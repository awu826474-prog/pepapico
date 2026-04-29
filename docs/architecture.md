# Byte_cp 架构设计文档

## 项目定位

多 Agent 联合的项目托管架构（Multi-Agent Collaborative Project Hosting）。

核心能力：
- 多模型多供应商切换（已实现：OpenRouter / grsai NanoBanana）
- 根据任务类型与难度自动为子 Agent 分配模型（规划中）
- TUI 与 Web UI 双界面共享同一套 Agent OS（规划中）

---

## 整体分层

```
┌─────────────────────────────────────────────────────┐
│                    Interface Layer                   │
│                                                     │
│   TUI (React + Ink)       Web UI (React + Vite)    │
│   ── 终端交互界面           ── 浏览器可视化面板        │
│   ── 直接 in-process        ── HTTP / WebSocket     │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│                   Agent OS (Core)                    │
│                                                     │
│   TaskQueue       AgentPool       ModelRouter        │
│   ── 任务队列      ── Agent 池     ── 模型路由调度器    │
│                                                     │
│   SessionManager  EventBus        StateStore         │
│   ── 会话管理      ── 事件总线     ── 状态持久化        │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│                  Provider Layer（已实现）              │
│                                                     │
│   OpenAICompatibleProvider    NanoBananaProvider     │
│   ── 对话模型（chat/stream）   ── 图像生成（stream）    │
│                                                     │
│   Registry: chatRegistry + imageRegistry            │
│   预置供应商: OpenRouter / grsai / Groq / Ollama 等  │
└─────────────────────────────────────────────────────┘
```

---

## Agent OS 核心模块（规划）

### TaskQueue — 任务队列
- 接收来自两个界面的任务提交
- 维护优先级队列，支持并发控制
- 任务状态：`pending → running → done | failed`

### AgentPool — Agent 池
- 管理可用的子 Agent 实例
- 按任务分配、回收 Agent
- 支持 Agent 能力标签（text / image / code / search …）

### ModelRouter — 模型路由调度器（核心差异化功能）
- **输入**：任务类型 + 难度评估 + 当前负载
- **输出**：选定的 Provider + Model
- 路由策略（计划支持）：
  - 任务类型匹配（代码 → deepseek，图像 → nano-banana）
  - 难度分级（简单 → fast 模型，复杂 → pro 模型）
  - 成本控制（预算约束下的最优模型选择）
  - 负载均衡（多 key 轮转、限流保护）

### EventBus — 事件总线
- TUI 和 Web UI 订阅同一个事件流
- 事件类型：`task:created / task:progress / task:done / agent:log`

### StateStore — 状态持久化
- 任务历史、Agent 会话、模型使用统计
- 初期：JSON 文件；后续可换 SQLite

---

## 界面层（规划）

### TUI — 终端界面（先行实现）
- 技术栈：React + [Ink](https://github.com/vadimdemedes/ink)
- 参考：Claude Code 的 `main.tsx` 入口风格
- 功能：任务提交、Agent 日志流、模型状态展示
- 与 OS 交互：直接 in-process 调用（无网络开销）

### Web UI — 浏览器面板（TUI 成熟后映射）
- 技术栈：React + Vite（+ shadcn/ui 或 antd）
- 与 OS 交互：HTTP REST + WebSocket（订阅事件总线）
- 功能：可视化任务流、多 Agent 状态、图像生成结果预览
- Agent OS 在同一进程内，Web 服务仅暴露接口层

---

## 实现路线

```
阶段 0 ✅  Provider Layer
          多模型多供应商，OpenRouter + grsai NanoBanana 测试通过

阶段 1     Agent OS 骨架
          TaskQueue + AgentPool + EventBus（最小可用版本）

阶段 2     ModelRouter
          任务类型识别 + 模型分配策略

阶段 3     TUI
          React + Ink，接入 Agent OS，CLI 可用

阶段 4     Web UI
          REST + WebSocket，映射 TUI 全部功能到浏览器
```

---

## 技术约定

| 项目 | 选型 |
|------|------|
| 语言 | TypeScript（Node 24 原生运行，无需编译） |
| 模块系统 | ESM，`.ts` 扩展名直接导入 |
| HTTP 客户端 | undici（proxy 感知） |
| TUI 框架 | React + Ink |
| Web 框架 | 待定（Hono / Fastify） |
| Web 前端 | React + Vite |
| 状态持久化 | JSON → SQLite（按需升级） |
| 代理 | HTTP_PROXY=http://127.0.0.1:7897 |

---

## 参考

- [Claude Code 架构解析](./reference/cc/agent-architecture.md)
- [Claude Code 源码结构](./reference/cc/source-structure.md)
- Provider 层实现：`src/provider/`
