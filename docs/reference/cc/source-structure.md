# Claude Code v2.1.88 源码目录结构

## 顶层入口

```
restored-src/src/
├── main.tsx              # CLI 入口 (4684行)，Commander 命令解析，启动流程
├── QueryEngine.ts        # Agentic Loop 核心引擎 (1295行)
├── Tool.ts               # 工具抽象基类/接口定义 (792行)
├── Task.ts               # 后台任务类型定义 (125行)
├── tools.ts              # 工具注册表，getAllBaseTools / getTools / assembleToolPool
├── commands.ts           # 斜杠命令注册
├── context.ts            # 系统/用户上下文构建
├── query.ts              # API 调用 + 流式响应处理
├── history.ts            # 输入历史
├── setup.ts              # 初始化流程
├── ink.ts                # Ink (React TUI) 入口
└── replLauncher.tsx      # REPL 启动器
```

## 核心模块

### tools/ — 30+ 内置工具

```
tools/
├── AgentTool/            # 子 agent 生成工具
│   ├── AgentTool.tsx     # 主实现
│   ├── runAgent.ts       # 运行子 agent
│   ├── forkSubagent.ts   # fork 子 agent 上下文
│   ├── builtInAgents.ts  # 内置 agent 类型定义
│   ├── loadAgentsDir.ts  # 从 .claude/agents/ 加载自定义 agent
│   ├── agentMemory.ts    # agent 记忆
│   ├── agentMemorySnapshot.ts
│   ├── agentColorManager.ts
│   ├── agentDisplay.ts
│   ├── agentToolUtils.ts
│   ├── constants.ts
│   ├── prompt.ts
│   ├── resumeAgent.ts
│   ├── UI.tsx
│   └── built-in/         # 内置 agent 实现
├── BashTool/             # Shell 执行
├── PowerShellTool/       # Windows PowerShell
├── FileReadTool/         # 文件读取
├── FileEditTool/         # 文件编辑
├── FileWriteTool/        # 文件写入
├── GlobTool/             # 文件搜索 (glob)
├── GrepTool/             # 文本搜索 (ripgrep)
├── WebFetchTool/         # HTTP 请求
├── WebSearchTool/        # 网页搜索
├── NotebookEditTool/     # Jupyter Notebook
├── SkillTool/            # 技能调用
├── ToolSearchTool/       # 工具搜索 (延迟加载)
├── MCPTool/              # MCP 工具代理
├── ListMcpResourcesTool/ # MCP 资源列表
├── ReadMcpResourceTool/  # MCP 资源读取
├── McpAuthTool/          # MCP 认证
├── SendMessageTool/      # 向 agent 发送消息
├── TaskCreateTool/       # 任务创建
├── TaskGetTool/          # 任务查询
├── TaskUpdateTool/       # 任务更新
├── TaskListTool/         # 任务列表
├── TaskOutputTool/       # 任务输出读取
├── TaskStopTool/         # 任务停止
├── TeamCreateTool/       # 团队创建
├── TeamDeleteTool/       # 团队删除
├── TodoWriteTool/        # Todo 列表
├── AskUserQuestionTool/  # 向用户提问
├── BriefTool/            # 精简消息发送
├── SleepTool/            # 休眠 (proactive mode)
├── EnterPlanModeTool/    # 进入计划模式
├── ExitPlanModeTool/     # 退出计划模式
├── EnterWorktreeTool/    # 进入 worktree
├── ExitWorktreeTool/     # 退出 worktree
├── ConfigTool/           # 配置修改
├── LSPTool/              # LSP 交互
├── REPLTool/             # REPL 执行
├── RemoteTriggerTool/    # 远程触发
├── ScheduleCronTool/     # 定时任务
├── SyntheticOutputTool/  # 结构化输出
├── shared/               # 工具共享代码
├── testing/              # 测试工具
└── utils.ts              # 工具通用函数
```

### coordinator/ — 多 Agent 协调

```
coordinator/
└── coordinatorMode.ts    # 协调者模式 (369行)
                          # - 协调者 system prompt
                          # - 工具过滤 (只保留 Agent/SendMessage/TaskStop)
                          # - worker 工具上下文生成
```

### services/ — 服务层

```
services/
├── api/                  # API 调用 (claude.ts 等)
│   ├── bootstrap.js      # 启动数据
│   ├── claude.js          # 核心 API 调用
│   ├── filesApi.js        # 文件下载
│   └── referral.js
├── mcp/                  # MCP (Model Context Protocol) 客户端
│   ├── client.js          # MCP 连接管理
│   ├── config.js          # MCP 配置解析
│   ├── types.js           # MCP 类型
│   └── ...
├── compact/              # 上下文压缩
├── AgentSummary/         # Agent 摘要
├── SessionMemory/        # 会话记忆
├── extractMemories/      # 记忆提取
├── MagicDocs/            # 文档自动发现
├── PromptSuggestion/     # 提示建议
├── analytics/            # 分析/遥测
├── lsp/                  # LSP 服务管理
├── oauth/                # OAuth 认证
├── plugins/              # 插件系统服务
├── policyLimits/         # 策略限制
├── remoteManagedSettings/# 远程托管设置
├── settingsSync/         # 设置同步
├── teamMemorySync/       # 团队记忆同步
├── tips/                 # 提示系统
├── toolUseSummary/       # 工具使用摘要
├── autoDream/            # 自动休眠
└── tools/                # 工具服务
```

### 其他模块

```
├── assistant/            # KAIROS 助手模式 (持久化 daemon)
├── bridge/               # Remote Control 桥接 (claude.ai ↔ CLI)
├── buddy/                # AI 伴侣 UI
├── remote/               # 远程会话管理
├── server/               # Direct Connect 服务器模式
├── plugins/              # 插件系统
├── skills/               # 技能系统
├── voice/                # 语音交互
├── vim/                  # Vim 模式
├── state/                # 应用状态管理
│   ├── AppState.js
│   ├── AppStateStore.js
│   ├── store.js
│   └── onChangeAppState.js
├── bootstrap/            # 启动状态
├── cli/                  # CLI 处理器 (print.ts, handlers/)
├── commands/             # 40+ 斜杠命令
├── components/           # React (Ink) 组件
├── constants/            # 常量
├── context/              # React Context
├── entrypoints/          # 入口点
├── hooks/                # React Hooks
├── schemas/              # 数据 Schema
├── types/                # TypeScript 类型定义
├── utils/                # 工具函数
│   ├── model/            # 模型相关
│   ├── permissions/      # 权限系统
│   ├── settings/         # 设置管理
│   ├── plugins/          # 插件工具
│   ├── skills/           # 技能工具
│   ├── swarm/            # Agent Swarm
│   ├── sandbox/          # 沙箱
│   ├── teleport/         # 远程传送
│   ├── deepLink/         # 深度链接
│   ├── claudeInChrome/   # Chrome 集成
│   ├── computerUse/      # 计算机使用 (屏幕控制)
│   ├── hooks/            # Hook 事件
│   └── ...
└── migrations/           # 数据迁移
```
