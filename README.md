# Byte_cp

Byte_cp 是一个基于 TypeScript 和 Node.js 的多 Agent 协作运行框架。项目把 Provider 接入、模型路由、Agent 生命周期、权限控制、工具调用和终端交互封装在同一套运行时里，方便在 CLI、TUI 或自定义脚本中复用。

## 功能概览

- 多 Provider 接入：支持 OpenAI-compatible、OpenRouter、GitHub Copilot、NanoBanana 等 provider 适配。
- Agent OS：提供 Agent、AgentRuntime、AgentManager、SignalBus、PermissionGuard、ModelRouter 等核心模块。
- 工具系统：内置 bash、file_read、file_write、web_fetch、sub_agent 等工具接口。
- 终端入口：提供基础 CLI 和 React Ink TUI，用于交互式对话、Agent 管理和运行状态查看。
- 使用统计：包含延迟、token、订阅和 provider 使用情况的统计能力。

## 目录结构

```text
docs/                 架构与参考文档
src/cli.ts            命令行入口
src/tui-entry.ts      TUI 启动入口
src/index.ts          统一导出入口
src/os/               Agent OS 核心模块
src/os/tools/         Agent 可调用工具
src/provider/         Provider 适配与注册
```

## 环境要求

- Node.js >= 22.6.0
- npm
- TypeScript CLI，运行 `npm run build` 时需要可用的 `tsc`

项目使用 `node --experimental-strip-types` 直接运行 TypeScript 源码，因此需要较新的 Node.js 版本。

## 安装

```bash
npm install
```

## 常用命令

```bash
npm run cli
npm run tui
npm run test:provider
npm run build
```

说明：

- `npm run cli` 启动基础交互式 CLI。
- `npm run tui` 启动 React Ink 终端界面。
- `npm run test:provider` 运行 provider 测试入口。
- `npm run build` 执行 TypeScript 类型检查。当前项目没有把 `typescript` 写入 `devDependencies`，如果本机没有全局 `tsc`，需要先安装 TypeScript 或把它加入项目依赖。

## Provider 配置

Provider 相关实现位于 `src/provider/`。项目通过 registry 统一注册和读取 provider，并导出以下主要能力：

- `createOpenRouter`
- `createNanoBanana`
- `createCopilot`
- `registerProvider`
- `registerImageProvider`
- `getProvider`
- `getImageProvider`

可从 `src/index.ts` 统一导入：

```ts
import {
  ByteOS,
  createOpenRouter,
  registerProvider,
} from './src/index.ts'
```

## Agent OS

核心模块位于 `src/os/`：

- `agent.ts`：Agent 配置、状态和事件类型。
- `agent-runtime.ts`：Agent 执行运行时。
- `agent-manager.ts`：Agent 创建、管理和调度。
- `agent-loop.ts`：Agent 循环执行逻辑。
- `model-router.ts`：根据任务信息选择 provider/model。
- `permission-guard.ts`：命令和工具调用权限控制。
- `signal-bus.ts`：Agent 间信号与事件广播。

更多设计说明可查看 `docs/architecture.md` 和 `docs/reference/cc/`。

## 当前状态

这是一个早期实验性项目，主要用于探索多 Agent 协作、模型路由和终端交互式运行时。部分文档和源码注释可能仍需要进一步整理。
