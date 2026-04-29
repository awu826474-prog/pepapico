# Claude Code v2.1.88 Agent 架构解析

## 1. 总体架构

Claude Code 采用 **React (Ink) TUI + 工具循环 (Agentic Loop)** 架构。
核心是一个 LLM 驱动的 ReAct agent，通过迭代调用工具来完成任务。

```
main.tsx (CLI入口)
  └─► QueryEngine.ts (agentic loop核心)
        ├─► services/api/claude.ts (API调用 Claude模型)
        ├─► Tool.ts (工具抽象基类)
        ├─► tools/ (30+ 个内置工具)
        └─► coordinator/ (多Agent协调模式)
```

## 2. 核心循环：QueryEngine

`QueryEngine.ts`（1295行）是 agent 的核心引擎。

### 运行机制

1. 构建 system prompt（CLAUDE.md + 用户上下文 + coordinator 上下文）
2. 将 messages 发送至 Claude API (streaming)
3. 处理模型返回：
   - `text` → 输出给用户
   - `tool_use` → checkPermissions → call() → tool_result → 回传 API
   - `end_turn` / 达到 maxTurns → 结束
4. 循环直到终止条件满足

### 关键配置

```typescript
type QueryEngineConfig = {
  cwd: string
  tools: Tools
  commands: Command[]
  mcpClients: MCPServerConnection[]
  agents: AgentDefinition[]
  canUseTool: CanUseToolFn
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  customSystemPrompt?: string
  appendSystemPrompt?: string
  userSpecifiedModel?: string
  fallbackModel?: string
  thinkingConfig?: ThinkingConfig
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: { total: number }
  // ...
}
```

### 流程图

```
用户输入 → main.tsx → Commander解析
                ↓
         交互模式(REPL) / 非交互模式(print.ts)
                ↓
         QueryEngine.query()
                ↓
    ┌─── 构建 system prompt
    ↓
    调用 Claude API (streaming)
    ↓
    ├─ text → 输出给用户
    ├─ tool_use → checkPermissions → call() → tool_result → 回传API
    │     ├─ AgentTool.call() → spawn子agent → 独立QueryEngine循环
    │     ├─ BashTool.call() → 执行shell命令
    │     ├─ FileEditTool.call() → 编辑文件
    │     └─ ...
    └─ end_turn / max_turns → 结束
```

## 3. 工具系统（Tool）

### Tool 接口

`Tool.ts` 定义了统一的工具接口：

```typescript
type Tool<Input, Output> = {
  name: string
  aliases?: string[]
  searchHint?: string                    // ToolSearch 关键词匹配
  shouldDefer?: boolean                  // 延迟加载
  alwaysLoad?: boolean                   // 始终加载
  maxResultSizeChars: number             // 结果最大字符数

  // 核心方法
  call(args, context, canUseTool, parentMessage, onProgress?): Promise<ToolResult>
  description(input, options): Promise<string>
  prompt(options): Promise<string>       // 给模型看的工具描述

  // 校验与权限
  validateInput?(input, context): Promise<ValidationResult>
  checkPermissions(input, context): Promise<PermissionResult>

  // 元信息
  inputSchema: ZodSchema
  isEnabled(): boolean
  isReadOnly(input): boolean
  isDestructive?(input): boolean
  isConcurrencySafe(input): boolean
  interruptBehavior?(): 'cancel' | 'block'

  // 分类器
  toAutoClassifierInput(input): unknown
  userFacingName(input): string
  getToolUseSummary?(input): string | null
  getActivityDescription?(input): string | null
}
```

### 工具分类

| 类别 | 工具 | 说明 |
|------|------|------|
| **文件操作** | FileRead, FileEdit, FileWrite, NotebookEdit | 读/编辑/写/Notebook |
| **搜索** | Glob, Grep, WebSearch, WebFetch | 文件/文本/网页搜索 |
| **执行** | Bash, PowerShell, REPL | Shell/脚本执行 |
| **Agent** | AgentTool, SendMessage, TaskStop | 子agent管理 |
| **团队** | TeamCreate, TeamDelete | Agent Swarm |
| **任务** | TaskCreate/Get/Update/List/Output | 后台任务CRUD |
| **计划** | EnterPlanMode, ExitPlanMode | 计划模式 |
| **交互** | AskUserQuestion, Brief, Sleep | 用户交互 |
| **MCP** | MCPTool, ListMcpResources, ReadMcpResource | MCP协议工具 |
| **辅助** | ToolSearch, Skill, Config, LSP, Todo | 工具发现/技能/配置 |

### 工具注册与过滤

```typescript
// tools.ts
function getAllBaseTools(): Tools        // 获取所有内置工具
function getTools(permCtx): Tools       // 过滤后的可用工具
function assembleToolPool(permCtx, mcpTools): Tools  // 合并内置+MCP工具
function filterToolsByDenyRules(tools, permCtx): Tools  // 按权限过滤
```

## 4. 多 Agent 架构

### 4.1 AgentTool — 子 Agent 生成

`tools/AgentTool/` 是多 agent 的核心：

- `AgentTool.tsx` — 调用时 spawn 独立 agent 循环
- `runAgent.ts` — 运行子 agent，创建独立的 `ToolUseContext`
- `forkSubagent.ts` — fork 子 agent 上下文（受限工具集、独立消息）
- `loadAgentsDir.ts` — 从 `.claude/agents/` 加载自定义 agent 定义
- `builtInAgents.ts` — 内置 agent（如 Explore）

**工具限制**：子 agent 使用 `ASYNC_AGENT_ALLOWED_TOOLS` 白名单，不能访问全部工具。

**通信**：子 agent 完成后通过 `<task-notification>` XML 回报结果：

```xml
<task-notification>
  <task-id>{agentId}</task-id>
  <status>completed|failed|killed</status>
  <summary>{状态摘要}</summary>
  <result>{agent最终响应}</result>
  <usage>
    <total_tokens>N</total_tokens>
    <tool_uses>N</tool_uses>
    <duration_ms>N</duration_ms>
  </usage>
</task-notification>
```

### 4.2 Coordinator 模式 — 协调者/工人架构

`coordinator/coordinatorMode.ts` 实现了分层多 agent：

**协调者（Coordinator）角色：**
- 只能使用：`AgentTool`、`SendMessageTool`、`TaskStopTool`
- 负责：理解需求、拆分任务、分配 worker、综合结果
- 不直接操作文件/执行命令

**工人（Worker）角色：**
- 由协调者通过 `AgentTool({ subagent_type: "worker" })` 生成
- 拥有：Bash、FileRead、FileEdit + MCP 工具 + Skill
- 自主完成研究/实现/验证

**工作流：**
```
用户需求 → Coordinator
              ├─► Worker A (研究) ──并行──┐
              ├─► Worker B (研究) ────────┤
              │                          ↓
              │← <task-notification> ←──结果汇报
              ↓
         Coordinator 综合研究结果，制定实现方案
              ↓
              ├─► Worker C (实现) → commit
              │← <task-notification> ←──完成通知
              ↓
              ├─► Worker D (验证) → 运行测试
              │← <task-notification> ←──验证结果
              ↓
         Coordinator 向用户报告
```

**协调者 System Prompt 要点：**
1. 并行是核心优势 — 独立任务同时发起
2. 必须自己综合研究结果 — 不能懒委托 ("based on your findings")
3. 给 worker 的 prompt 必须自包含 — worker 看不到主对话
4. 包含文件路径、行号、具体修改内容
5. worker 自验证后 commit，coordinator 另发验证 worker 复查

### 4.3 Agent Swarms — 团队协作

通过 `TeamCreateTool`/`TeamDeleteTool` + teammate 体系：

- **生成方式**: `tmux` | `in-process` | `auto`
  - `tmux`: 在独立 tmux pane 中启动新 claude 进程
  - `in-process`: 进程内 fork（共享内存）
  - `auto`: 自动选择
- **身份**: 每个 teammate 有 `agentId`, `agentName`, `teamName`, `agentColor`
- **通信**: 通过 `SendMessageTool` 向 teammate 发送消息

### 4.4 自定义 Agent

从 `.claude/agents/` 目录或 `--agents` CLI 参数加载：

```json
{
  "reviewer": {
    "description": "Reviews code",
    "prompt": "You are a code reviewer..."
  }
}
```

通过 `--agent reviewer` 或 settings 中的 `agent` 字段选择。

## 5. Task 系统

### 任务类型

```typescript
type TaskType =
  | 'local_bash'           // 本地 bash 后台任务
  | 'local_agent'          // 本地子 agent
  | 'remote_agent'         // 远程 agent
  | 'in_process_teammate'  // 进程内 teammate
  | 'local_workflow'       // 本地工作流
  | 'monitor_mcp'          // MCP 监控
  | 'dream'                // 自动休眠任务
```

### 任务生命周期

```
pending → running → completed / failed / killed
```

通过 `AppState.tasks` 统一管理，`TaskStateBase` 包含：
- `id`, `type`, `status`, `description`
- `toolUseId` (关联的工具调用)
- `startTime`, `outputFile`, `outputOffset`

## 6. 权限系统

三层控制：

### 6.1 PermissionMode

- `default` — 标准交互模式，需要用户确认
- `plan` — 计划模式，只读操作
- `auto` — 自动模式，分类器自动决策
- `bypassPermissions` — 跳过所有权限（仅沙箱）

### 6.2 ToolPermissionContext

```typescript
type ToolPermissionContext = {
  mode: PermissionMode
  additionalWorkingDirectories: Map<string, AdditionalWorkingDirectory>
  alwaysAllowRules: ToolPermissionRulesBySource   // 始终允许
  alwaysDenyRules: ToolPermissionRulesBySource     // 始终拒绝
  alwaysAskRules: ToolPermissionRulesBySource      // 始终询问
  isBypassPermissionsModeAvailable: boolean
  shouldAvoidPermissionPrompts?: boolean           // 后台agent静默拒绝
  awaitAutomatedChecksBeforeDialog?: boolean        // coordinator worker等待自动检查
}
```

### 6.3 工具级权限

每个工具的 `checkPermissions()` 方法，支持：
- `preparePermissionMatcher()` — hook 条件匹配（如 `Bash(git *)`)
- `getPath()` — 路径级权限检查

## 7. 特殊运行模式

| 模式 | Feature Flag | 说明 |
|------|-------------|------|
| **KAIROS (Assistant)** | `KAIROS` | 持久化 daemon，通过 bridge 远程控制 |
| **Proactive** | `PROACTIVE` | 主动模式，定期 `<tick>` 自主行动 |
| **Brief** | `KAIROS_BRIEF` | 通过 SendUserMessage 精简输出 |
| **Coordinator** | `COORDINATOR_MODE` | 多 worker 编排 |
| **Bridge/RC** | `BRIDGE_MODE` | Remote Control，通过 claude.ai 连接 |
| **Remote/Teleport** | — | 远程会话创建与恢复 |
| **SSH Remote** | `SSH_REMOTE` | SSH 到远程主机执行 |
| **Direct Connect** | `DIRECT_CONNECT` | cc:// 协议服务器模式 |
| **Worktree** | — | Git worktree 隔离 |

## 8. 状态管理

`AppState` 是全局状态树：

```typescript
type AppState = {
  settings: Settings
  tasks: Record<string, TaskState>
  verbose: boolean
  mainLoopModel: string
  toolPermissionContext: ToolPermissionContext
  agent?: string
  agentDefinitions: AgentDefinitions
  mcp: { clients, tools, commands, resources }
  plugins: { enabled, disabled, commands, errors }
  kairosEnabled: boolean
  teamContext?: TeamContext
  effortValue?: EffortLevel
  fastMode?: FastModeState
  advisorModel?: string
  // ...
}
```

通过 `createStore()` + `onChangeAppState` 管理，支持 `getState()` / `setState()`。

## 9. 对我们项目的借鉴价值

### 可复用的架构模式

1. **Agentic Loop**: QueryEngine 的消息驱动循环 — 适用于任何 LLM agent
2. **Tool 接口抽象**: 统一的 `call/checkPermissions/prompt` 接口 — 可直接采用
3. **Coordinator 模式**: 协调者只做规划，worker 做执行 — 适合多 agent 托管
4. **Task 系统**: 统一的任务生命周期管理 — 适合后台 agent 管理
5. **权限分层**: mode + rules + tool-level — 适合多租户场景

### 关键差异点

- Claude Code 深度绑定 Anthropic API（tool_use 原生支持）
- 我们需要支持多模型 API，需要统一的 tool_use 适配层
- Claude Code 是 CLI/TUI，我们可能需要 Web UI
- 我们的多 agent 托管需要更强的项目级状态持久化
