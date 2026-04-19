# Byte_cp

Byte_cp 是一个基于 TypeScript 和 Node.js 的多 Agent 项目托管系统。项目的核心目标是把 Provider 接入、模型路由、Agent 生命周期、权限控制、工具调用、目标树规划和项目认知持久化封装成同一套 Agent OS，让终端界面、TUI 或自定义脚本都能复用同一个运行时。

当前仓库提供了三类入口：

- `PepaPico`：面向项目托管的交互式 Agent 系统，负责初始化工作区、扫描项目、认知对齐、规划目标树、部署子 Agent 并进入 REPL。
- `ByteOS`：面向二次开发的一站式 API 门面，整合 Provider、Agent Runtime、SignalBus、PermissionGuard、UsageMonitor 和 Plan Mode。
- `CLI/TUI`：用于直接聊天、管理 provider、创建 agent、查看目标树和运行时状态的终端前端。

## 功能特性

- 多 Provider 接入：支持 OpenRouter、GitHub Copilot、OpenAI Compatible API、NanoBanana 图像生成等适配方式。
- 多 Agent 协作：支持 coordinator/worker/standalone 角色、子 Agent 创建、并行执行、唤醒和回收。
- 项目托管工作流：初始化 `.pepapico/` 工作区，扫描项目结构，生成项目认知报告和目标树快照。
- 模型路由：根据任务类型、难度、标签和深度为 Agent 分配 provider/model。
- 工具系统：内置 `web_fetch`、`bash`、`file_read`、`file_write`、`sub_agent` 等工具。
- 权限守卫：按照风险等级、危险命令模式和工具策略拦截操作。
- 信号系统：通过 watch tags 唤醒匹配的 Agent，支持广播和监控信号。
- 使用量统计：跟踪 token provider、订阅 provider 的调用延迟和计费/使用情况。
- React Ink TUI：提供一个实验性的终端 UI，用于聊天、查看 Agent 树和运行时状态。

## 环境要求

- Node.js >= 22.6.0
- npm
- TypeScript CLI（运行 `npm run build` 时需要 `tsc`）

项目直接使用 `node --experimental-strip-types` 运行 TypeScript 源码，因此需要较新的 Node.js 版本。
如果本机没有 `tsc`，可以全局安装 TypeScript，或把 `typescript` 加入项目的 devDependencies。

## 安装

```bash
npm install
```

类型检查：

```bash
npm run build
```

> 注意：当前 `tsconfig.json` 设置了 `noEmit: true`，`npm run build` 用于类型检查，不会输出 `dist/`。

## 快速开始

托管当前目录：

```bash
npm run pico
```

托管指定项目：

```bash
npm run pico -- D:\my-project
```

首次启动时，PepaPico 会创建或读取全局配置，初始化目标项目下的 `.pepapico/` 工作区，并按以下流程引导：

1. 选择或生成配置模板。
2. 配置 Provider 和模型。
3. 扫描项目结构。
4. 让协调者 Agent 生成项目认知报告。
5. 根据用户目标生成分层目标树。
6. 创建并部署子 Agent。
7. 进入交互式 REPL。

如果目标项目已经存在 `.pepapico/`，再次运行会尝试恢复上次状态。

## 常用脚本

```bash
npm run pico              # 启动 PepaPico 项目托管入口
npm run pepacoo           # 启动 Pepacoo 命令式入口
npm run cli               # 启动基础交互式 CLI
npm run tui               # 启动 React Ink TUI
npm run test:provider     # 测试 provider 调用
npm run example:explore   # 运行项目探索示例
npm run build             # TypeScript 类型检查
```

## Provider 配置

项目支持多种 Provider。常见方式如下。

### OpenRouter

可以在 `.pepapico/providers.json` 中配置：

```json
{
  "default": "openrouter",
  "providers": {
    "openrouter": {
      "type": "openrouter",
      "apiKey": "${OPENROUTER_API_KEY}"
    }
  }
}
```

建议使用环境变量引用 API Key：

```bash
set OPENROUTER_API_KEY=sk-or-v1-xxx
```

PowerShell：

```powershell
$env:OPENROUTER_API_KEY="sk-or-v1-xxx"
```

### GitHub Copilot

基础 CLI 支持通过命令登录：

```text
/provider copilot
```

也可以把 Copilot token 放入 `.copilot-token`。该文件已经在根目录 `.gitignore` 中忽略。

### OpenAI Compatible API

对于兼容 OpenAI Chat Completions 格式的服务，可以通过 `baseURL` 接入：

```json
{
  "default": "custom",
  "providers": {
    "custom": {
      "type": "openai-compatible",
      "apiKey": "${CUSTOM_API_KEY}",
      "baseUrl": "https://example.com/v1"
    }
  }
}
```

## PepaPico REPL 命令

进入 `npm run pico` 后，可以直接输入自然语言与协调者 Agent 对话。常用命令包括：

```text
/provider           管理 Provider
/model [name]       查看或切换模型
/tree               查看 Agent 树
/goals              查看目标树
/status             查看运行时状态
/cd <path>          切换托管项目
/config             管理全局配置
/template           管理项目配置模板
/wake <id>          唤醒指定 Agent
/recycle <id>       回收子 Agent 并归档压缩记忆
/scan               重新扫描项目
/usage              查看使用量和计费报告
/tutorial           查看内置教程
/exit               保存状态并退出
```

## 基础 CLI 命令

`npm run cli` 提供一个更直接的聊天和管理入口：

```text
/provider list
/provider add <name> <apiKey> [baseURL]
/provider copilot
/provider models [name]

/agent list
/agent create <name>
/agent switch <name>
/agent tree
/agent info

/model <model-name>
/difficulty <text>
/goal create <text>
/goal tree
/usage
/config
/config set <key> <value>
/stream
/compact
/clear
/exit
```

## Pepacoo 命令式入口

`src/pepacoo.ts` 提供了更明确的命令式流程：

```bash
node --experimental-strip-types src/pepacoo.ts init D:\my-project --provider openrouter --key sk-xxx
node --experimental-strip-types src/pepacoo.ts start D:\my-project --provider openrouter --key sk-xxx
node --experimental-strip-types src/pepacoo.ts resume D:\my-project
node --experimental-strip-types src/pepacoo.ts status D:\my-project
node --experimental-strip-types src/pepacoo.ts help
```

也可以通过 npm 脚本运行：

```bash
npm run pepacoo -- start D:\my-project --provider openrouter --key sk-xxx
```

## 作为库使用

可以从 `src/index.ts` 导入 `ByteOS` 和相关类型：

```ts
import { ByteOS, createOpenRouter } from './src/index.ts'

const os = new ByteOS({
  autoApproveLevel: 'low',
  onEvent: (event) => {
    console.log(event)
  },
})

const provider = createOpenRouter(process.env.OPENROUTER_API_KEY!)

const agent = os.createAgent({
  name: 'coordinator',
  role: 'coordinator',
  systemPrompt: '你是项目协调者，请用中文回答。',
  provider,
  model: 'anthropic/claude-sonnet-4-5',
  builtinTools: true,
})

const result = await os.run(agent, '请分析这个项目的目录结构。')
console.log(result.response)
```

## 工作区结构

PepaPico 会在被托管项目下创建 `.pepapico/`：

```text
.pepapico/
  workspace.json       项目元信息和当前对齐状态
  providers.json       Provider 凭证和默认 provider
  models.json          coordinator/worker/scanner 的模型映射
  agents.json          Agent prompt、watchTags、自主模式和深度限制
  permissions.json     权限策略、工具白名单、危险命令模式
  scan.json            扫描忽略规则、关键文件列表、大文件阈值
  cognition/           项目认知和最近一次扫描结果
  snapshots/           目标树快照
  archives/            Agent 回收后的压缩记忆
```

全局配置默认位于 `~/.pepapico`，也可以通过环境变量 `PEPAPICO_HOME` 指定。`~/.pepapico-pointer` 用于记录实际全局配置目录。

## 项目结构

```text
src/
  index.ts                 ByteOS 统一入口和 re-export
  cli.ts                   基础交互式 CLI
  tui.ts                   React Ink TUI 组件
  tui-entry.ts             TUI 启动入口
  pepapico.ts              PepaPico 项目托管入口
  pepacoo.ts               命令式项目托管入口
  workspace.ts             .pepapico 工作区读写、扫描和归档
  global-config.ts         全局配置和模板管理
  provider/                Provider 抽象、注册表和具体实现
  os/                      Agent OS 核心
    agent.ts               Agent 实体和层级关系
    agent-loop.ts          Agent 执行循环
    agent-manager.ts       目标树、计划、升级和策略管理
    agent-runtime.ts       运行时、唤醒、回收和并行执行
    model-router.ts        任务类型和难度推断、模型路由
    permission-guard.ts    工具权限和风险控制
    signal-bus.ts          Agent 信号系统
    tools/                 内置工具
docs/
  architecture.md          架构设计文档
examples/
  project-explorer.ts      项目探索示例
test-gomoku/
  .pepapico/               示例工作区配置和认知产物
```

## 安全提醒

- 不要把真实 API Key、token 或个人凭证提交到 GitHub。
- `.copilot-token` 已被根目录 `.gitignore` 忽略。
- `.pepapico/providers.json` 可能包含 API Key，建议使用 `${ENV_VAR}` 形式引用环境变量。
- 如果误提交过真实密钥，请立即在对应平台轮换密钥。
- 内置权限守卫会拦截部分高风险命令，但不能替代人工审查；运行具备 `bash` 或 `file_write` 工具的 Agent 前，请确认目标项目和权限策略。

## 当前状态

这是一个处于快速迭代阶段的原型项目。Provider 层、Agent OS 核心、工作区扫描、项目认知、目标树、CLI 和 TUI 已经具备基础实现；Web UI、更多模型路由策略和更完整的持久化能力仍属于规划或实验方向。

## 参考文档

- [架构设计](docs/architecture.md)
- [Claude Code 架构参考](docs/reference/cc/agent-architecture.md)
- [Claude Code 源码结构参考](docs/reference/cc/source-structure.md)
