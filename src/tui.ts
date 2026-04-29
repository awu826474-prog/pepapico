/**
 * Byte TUI — React Ink 终端界面
 *
 * 使用 React.createElement (非 JSX，因为 --experimental-strip-types 不支持 JSX 转换)
 * 提供分区布局：Agent树 + 对话区 + 状态栏 + 输入区
 *
 * 启动: npm run tui
 */

import React from 'react'
import { render, Box, Text, useInput, useApp } from 'ink'
import type { Instance as InkInstance } from 'ink'
import TextInput from 'ink-text-input'
import Spinner from 'ink-spinner'

import type { Agent, AgentStatus, AgentHierarchyNode, CompressedMemory } from './os/agent.ts'
import type { AgentLoopResult } from './os/agent-loop.ts'
import type { PermissionRequest, PermissionDecision } from './os/permission-guard.ts'
import type { GoalNode, PlanDiff, PlanSnapshot } from './os/agent-manager.ts'
import type { RuntimeStatus } from './os/agent-runtime.ts'

// React.createElement shorthand
const h = React.createElement

// ============================================================
//  Theme / Colors
// ============================================================

const THEME = {
  primary: 'cyan',
  secondary: 'gray',
  success: 'green',
  warning: 'yellow',
  error: 'red',
  info: 'blue',
  accent: 'magenta',
  dim: 'gray',
} as const

const STATUS_COLORS: Record<AgentStatus, string> = {
  idle: 'gray',
  running: 'green',
  suspended: 'yellow',
  done: 'cyan',
  failed: 'red',
  killed: 'red',
  recycled: 'gray',
}

const STATUS_ICONS: Record<AgentStatus, string> = {
  idle: '◯',
  running: '●',
  suspended: '⏸',
  done: '✓',
  failed: '✗',
  killed: '☠',
  recycled: '♻',
}

// ============================================================
//  State Types
// ============================================================

type ViewMode = 'chat' | 'agents' | 'goals' | 'signals' | 'plan' | 'permissions' | 'help'

interface ChatMessage {
  id: number
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  timestamp: number
  agentId?: string
}

interface TUIState {
  viewMode: ViewMode
  inputValue: string
  messages: ChatMessage[]
  isProcessing: boolean
  agents: AgentHierarchyNode[]
  currentAgentId: string | null
  goalTree: GoalNode[]
  permissionRequests: PermissionRequest[]
  runtimeStatus: RuntimeStatus | null
  planSnapshots: PlanSnapshot[]
  activePlanDiff: PlanDiff | null
  notifications: string[]
  streamBuffer: string
}

// ============================================================
//  Components
// ============================================================

/** 顶部标题栏 */
function TitleBar(props: { viewMode: ViewMode; agentId: string | null; isProcessing: boolean }) {
  const modeLabels: Record<ViewMode, string> = {
    chat: '💬 对话',
    agents: '🤖 Agent树',
    goals: '🎯 目标树',
    signals: '📡 信号',
    plan: '📋 计划模式',
    permissions: '🔐 权限',
    help: '❓ 帮助',
  }

  return h(Box, {
    borderStyle: 'single',
    borderColor: THEME.primary,
    paddingX: 1,
    justifyContent: 'space-between',
    width: '100%',
  },
    h(Text, { bold: true, color: THEME.primary }, `Byte OS`),
    h(Text, { color: THEME.secondary }, ` │ ${modeLabels[props.viewMode]}`),
    props.agentId
      ? h(Text, { color: THEME.info }, ` │ Agent: ${props.agentId}`)
      : null,
    props.isProcessing
      ? h(Box, null,
          h(Text, { color: THEME.warning }, ' │ '),
          h(Spinner, { type: 'dots' }),
          h(Text, { color: THEME.warning }, ' 处理中...'),
        )
      : h(Text, { color: THEME.success }, ' │ 就绪'),
  )
}

/** Agent 树节点（递归） */
function AgentTreeNode(props: { node: AgentHierarchyNode; depth: number; selected: boolean }) {
  const { node, depth, selected } = props
  const indent = '  '.repeat(depth)
  const connector = depth > 0 ? '├─ ' : ''
  const color = STATUS_COLORS[node.status]
  const icon = STATUS_ICONS[node.status]

  return h(Box, { flexDirection: 'column' },
    h(Box, null,
      h(Text, { color: THEME.dim }, indent + connector),
      h(Text, {
        color: selected ? THEME.primary : color,
        bold: selected,
        inverse: selected,
      }, ` ${icon} ${node.name} `),
      h(Text, { color: THEME.dim }, ` [${node.role}]`),
      node.model ? h(Text, { color: THEME.dim }, ` ${node.model}`) : null,
      node.watchTags.length > 0
        ? h(Text, { color: THEME.accent }, ` 🏷${node.watchTags.length}`)
        : null,
      node.signalQueueSize > 0
        ? h(Text, { color: THEME.warning }, ` 📨${node.signalQueueSize}`)
        : null,
      node.archivedCount > 0
        ? h(Text, { color: THEME.dim }, ` ♻${node.archivedCount}`)
        : null,
    ),
    ...node.children.map((child, i) =>
      h(AgentTreeNode, { key: child.id, node: child, depth: depth + 1, selected: false }),
    ),
  )
}

/** Agent 树视图 */
function AgentTreeView(props: { agents: AgentHierarchyNode[]; currentAgentId: string | null }) {
  if (props.agents.length === 0) {
    return h(Box, { padding: 1 },
      h(Text, { color: THEME.dim }, '(无 Agent)'),
    )
  }

  return h(Box, { flexDirection: 'column', padding: 1 },
    h(Text, { bold: true, color: THEME.primary, underline: true }, 'Agent 层级树'),
    h(Text, null, ''),
    ...props.agents.map((agent) =>
      h(AgentTreeNode, {
        key: agent.id,
        node: agent,
        depth: 0,
        selected: agent.id === props.currentAgentId,
      }),
    ),
    h(Text, null, ''),
    h(Text, { color: THEME.dim },
      `图例: ${Object.entries(STATUS_ICONS).map(([k, v]) => `${v}=${k}`).join(' ')}`,
    ),
  )
}

/** 目标树节点（递归） */
function GoalTreeNode(props: { node: GoalNode; depth: number }) {
  const { node, depth } = props
  const indent = '  '.repeat(depth)
  const statusIcons: Record<string, string> = {
    pending: '○', active: '●', completed: '✓', blocked: '⊘',
    suspended: '⏸', failed: '✗', revised: '↻', abandoned: '⊗',
  }
  const icon = statusIcons[node.status] ?? '?'

  const planDone = node.plan.filter((s) => s.status === 'done' || s.status === 'reused').length
  const planTotal = node.plan.length
  const planStr = planTotal > 0 ? ` [${planDone}/${planTotal}]` : ''

  return h(Box, { flexDirection: 'column' },
    h(Box, null,
      h(Text, { color: THEME.dim }, indent),
      h(Text, { color: node.status === 'completed' ? THEME.success : node.status === 'blocked' ? THEME.error : THEME.secondary },
        `${icon} ${node.agentId}: ${node.goal}${planStr}`,
      ),
      node.revisionCount > 0
        ? h(Text, { color: THEME.warning }, ` (修订${node.revisionCount}次)`)
        : null,
    ),
    ...node.children.map((child) =>
      h(GoalTreeNode, { key: child.id, node: child, depth: depth + 1 }),
    ),
  )
}

/** 目标树视图 */
function GoalTreeView(props: { goals: GoalNode[] }) {
  if (props.goals.length === 0) {
    return h(Box, { padding: 1 },
      h(Text, { color: THEME.dim }, '(无目标)'),
    )
  }
  return h(Box, { flexDirection: 'column', padding: 1 },
    h(Text, { bold: true, color: THEME.primary, underline: true }, '目标树'),
    h(Text, null, ''),
    ...props.goals.map((goal) =>
      h(GoalTreeNode, { key: goal.id, node: goal, depth: 0 }),
    ),
  )
}

/** 权限确认弹窗 */
function PermissionDialog(props: {
  request: PermissionRequest
  onDecision: (requestId: string, decision: PermissionDecision) => void
}) {
  const { request } = props
  const riskColors: Record<string, string> = {
    low: THEME.success,
    medium: THEME.warning,
    high: THEME.error,
    critical: 'redBright',
  }
  const riskColor = riskColors[request.risk] ?? THEME.secondary

  return h(Box, {
    flexDirection: 'column',
    borderStyle: 'double',
    borderColor: riskColor,
    paddingX: 1,
    paddingY: 0,
    marginY: 1,
  },
    h(Text, { bold: true, color: riskColor }, `⚠ 权限确认 [${request.risk.toUpperCase()}]`),
    h(Text, null, ''),
    h(Text, null, `Agent: ${request.agentId}`),
    h(Text, null, `操作: ${request.description}`),
    h(Text, { color: riskColor }, request.reason),
    h(Text, null, ''),
    h(Text, { color: THEME.dim }, '[y] 允许  [Y] 本会话允许  [n] 拒绝  [N] 拒绝并终止'),
  )
}

/** Plan Mode 差分视图 */
function PlanDiffView(props: { diff: PlanDiff | null; snapshots: PlanSnapshot[] }) {
  return h(Box, { flexDirection: 'column', padding: 1 },
    h(Text, { bold: true, color: THEME.primary, underline: true }, '📋 Plan Mode'),
    h(Text, null, ''),
    h(Text, { color: THEME.dim }, `快照数: ${props.snapshots.length}`),
    props.diff
      ? h(Box, { flexDirection: 'column', marginTop: 1 },
          h(Text, { bold: true }, '差分:'),
          props.diff.added.length > 0
            ? h(Text, { color: THEME.success }, `  + 新增 ${props.diff.added.length} 个节点`)
            : null,
          props.diff.removed.length > 0
            ? h(Text, { color: THEME.error }, `  - 移除 ${props.diff.removed.length} 个节点`)
            : null,
          props.diff.modified.length > 0
            ? h(Text, { color: THEME.warning }, `  ~ 修改 ${props.diff.modified.length} 处`)
            : null,
        )
      : h(Text, { color: THEME.dim }, '(无活跃差分)'),
    h(Text, null, ''),
    h(Text, { color: THEME.dim }, '命令: /plan snapshot | /plan edit | /plan diff | /plan apply | /plan discard'),
  )
}

/** 帮助视图 */
function HelpView() {
  const sections = [
    ['视图切换', [
      ['Tab', '循环切换视图'],
      ['F1', '帮助'],
      ['F2', '对话'],
      ['F3', 'Agent树'],
      ['F4', '目标树'],
      ['F5', '信号'],
      ['F6', '计划模式'],
    ]],
    ['对话命令', [
      ['/run <msg>', 'Agentic 模式运行'],
      ['/model <name>', '切换模型'],
      ['/clear', '清除对话'],
      ['/compact', '压缩上下文'],
    ]],
    ['Agent 命令', [
      ['/agent create <name>', '创建子 agent'],
      ['/agent switch <id>', '切换活跃 agent'],
      ['/agent recycle <id>', '回收子 agent'],
      ['/agent tree', '显示层级树'],
      ['/agent wake <id>', '唤醒 idle agent'],
      ['/agent auto <id>', '启动自主模式'],
    ]],
    ['信号命令', [
      ['/signal wake <target>', '发送唤醒信号'],
      ['/signal broadcast <msg>', '广播信号'],
      ['/signal monitor <tags>', '发送监控信号'],
    ]],
    ['计划命令', [
      ['/plan snapshot', '创建计划快照'],
      ['/plan edit <id> <goal>', '编辑草稿节点'],
      ['/plan diff', '查看差分'],
      ['/plan apply', '应用差分到原树'],
      ['/plan discard', '丢弃快照'],
    ]],
    ['其他', [
      ['/usage', '计费报告'],
      ['/difficulty <text>', '难度评估'],
      ['/provider list', '列出 Provider'],
      ['/exit', '退出'],
    ]],
  ]

  return h(Box, { flexDirection: 'column', padding: 1 },
    h(Text, { bold: true, color: THEME.primary, underline: true }, '❓ Byte OS 帮助'),
    h(Text, null, ''),
    ...sections.map(([title, commands]) =>
      h(Box, { key: String(title), flexDirection: 'column', marginBottom: 1 },
        h(Text, { bold: true, color: THEME.accent }, `  ${title}`),
        ...(commands as [string, string][]).map(([cmd, desc]) =>
          h(Box, { key: cmd },
            h(Text, { color: THEME.primary }, `    ${cmd.padEnd(28)}`),
            h(Text, { color: THEME.secondary }, desc),
          ),
        ),
      ),
    ),
  )
}

/** 聊天消息 */
function ChatMessageView(props: { msg: ChatMessage }) {
  const { msg } = props
  const roleColors: Record<string, string> = {
    user: THEME.primary,
    assistant: THEME.success,
    system: THEME.warning,
    tool: THEME.accent,
  }
  const roleIcons: Record<string, string> = {
    user: '👤',
    assistant: '🤖',
    system: '⚙',
    tool: '🔧',
  }

  return h(Box, { flexDirection: 'column', marginBottom: 1 },
    h(Box, null,
      h(Text, { color: roleColors[msg.role] ?? THEME.dim, bold: true },
        `${roleIcons[msg.role] ?? '?'} ${msg.role}`,
      ),
      msg.agentId
        ? h(Text, { color: THEME.dim }, ` [${msg.agentId}]`)
        : null,
      h(Text, { color: THEME.dim }, ` ${new Date(msg.timestamp).toLocaleTimeString()}`),
    ),
    h(Text, { wrap: 'wrap' }, msg.content),
  )
}

/** 对话视图 */
function ChatView(props: {
  messages: ChatMessage[]
  streamBuffer: string
  isProcessing: boolean
}) {
  const visibleMessages = props.messages.slice(-30) // 显示最后 30 条

  return h(Box, { flexDirection: 'column', padding: 1, flexGrow: 1 },
    visibleMessages.length === 0
      ? h(Text, { color: THEME.dim }, '(输入消息开始对话，或输入 /help 查看命令)')
      : null,
    ...visibleMessages.map((msg) =>
      h(ChatMessageView, { key: msg.id, msg }),
    ),
    props.streamBuffer
      ? h(Box, null,
          h(Text, { color: THEME.success }, '🤖 '),
          h(Text, { wrap: 'wrap', color: THEME.secondary }, props.streamBuffer),
          h(Spinner, { type: 'dots' }),
        )
      : null,
  )
}

/** 状态栏 */
function StatusBar(props: { runtimeStatus: RuntimeStatus | null; notifications: string[] }) {
  const st = props.runtimeStatus
  const lastNotification = props.notifications[props.notifications.length - 1]

  return h(Box, {
    borderStyle: 'single',
    borderColor: THEME.dim,
    paddingX: 1,
    justifyContent: 'space-between',
    width: '100%',
  },
    st
      ? h(Text, { color: THEME.dim },
          `Agents: ${st.totalAgents} (${st.runningAgents}▶ ${st.idleAgents}◯ ${st.autonomousAgents}🤖)`,
          ` │ 信号: ${st.signalBusStats.totalSignals}`,
        )
      : h(Text, { color: THEME.dim }, '未连接'),
    lastNotification
      ? h(Text, { color: THEME.info }, ` │ ${lastNotification.slice(0, 60)}`)
      : null,
  )
}

/** 输入区 */
function InputArea(props: {
  value: string
  onChange: (value: string) => void
  onSubmit: (value: string) => void
  isProcessing: boolean
}) {
  return h(Box, { paddingX: 1 },
    h(Text, { color: THEME.primary, bold: true }, '❯ '),
    h(TextInput, {
      value: props.value,
      onChange: props.onChange,
      onSubmit: props.onSubmit,
      placeholder: props.isProcessing ? '处理中...' : '输入消息或 /命令',
    }),
  )
}

// ============================================================
//  Main App Component
// ============================================================

function App(props: {
  onCommand: (cmd: string) => Promise<void>
  getState: () => TUIState
  onPermissionDecision: (requestId: string, decision: PermissionDecision) => void
}) {
  const [, forceUpdate] = React.useState(0)
  const state = props.getState()
  const { exit } = useApp()

  // 定期刷新
  React.useEffect(() => {
    const timer = setInterval(() => forceUpdate((n) => n + 1), 500)
    return () => clearInterval(timer)
  }, [])

  // 键盘快捷键
  useInput((input, key) => {
    if (key.escape) exit()

    // 权限确认快捷键
    if (state.permissionRequests.length > 0) {
      const req = state.permissionRequests[0]
      if (input === 'y') {
        props.onPermissionDecision(req.id, { action: 'allow' })
      } else if (input === 'Y') {
        props.onPermissionDecision(req.id, { action: 'allow_session', tool: req.tool })
      } else if (input === 'n') {
        props.onPermissionDecision(req.id, { action: 'deny', reason: '用户拒绝' })
      } else if (input === 'N') {
        props.onPermissionDecision(req.id, { action: 'deny_and_abort' })
      }
    }
  })

  // 权限确认覆盖层
  const permissionOverlay = state.permissionRequests.length > 0
    ? h(PermissionDialog, {
        request: state.permissionRequests[0],
        onDecision: props.onPermissionDecision,
      })
    : null

  // 主内容区根据 viewMode 切换
  let mainContent
  switch (state.viewMode) {
    case 'chat':
      mainContent = h(ChatView, {
        messages: state.messages,
        streamBuffer: state.streamBuffer,
        isProcessing: state.isProcessing,
      })
      break
    case 'agents':
      mainContent = h(AgentTreeView, {
        agents: state.agents,
        currentAgentId: state.currentAgentId,
      })
      break
    case 'goals':
      mainContent = h(GoalTreeView, { goals: state.goalTree })
      break
    case 'plan':
      mainContent = h(PlanDiffView, {
        diff: state.activePlanDiff,
        snapshots: state.planSnapshots,
      })
      break
    case 'help':
      mainContent = h(HelpView, null)
      break
    default:
      mainContent = h(Text, { color: THEME.dim }, `视图 ${state.viewMode} 开发中...`)
  }

  return h(Box, { flexDirection: 'column', width: '100%', height: '100%' },
    h(TitleBar, {
      viewMode: state.viewMode,
      agentId: state.currentAgentId,
      isProcessing: state.isProcessing,
    }),
    h(Box, { flexGrow: 1, flexDirection: 'column', overflow: 'hidden' },
      permissionOverlay ?? mainContent,
    ),
    h(StatusBar, {
      runtimeStatus: state.runtimeStatus,
      notifications: state.notifications,
    }),
    h(InputArea, {
      value: state.inputValue,
      onChange: (v: string) => { state.inputValue = v },
      onSubmit: (v: string) => {
        if (v.trim()) {
          state.inputValue = ''
          props.onCommand(v.trim())
        }
      },
      isProcessing: state.isProcessing,
    }),
  )
}

// ============================================================
//  TUI Controller — 连接 App 组件与后端
// ============================================================

export class ByteTUI {
  private state: TUIState
  private inkInstance: InkInstance | null = null
  private msgCounter = 0

  // 外部注入的回调
  onChat?: (message: string) => Promise<AgentLoopResult | null>
  onCommand?: (command: string, args: string[]) => Promise<string | null>
  onPermission?: (requestId: string, decision: PermissionDecision) => void

  constructor() {
    this.state = {
      viewMode: 'chat',
      inputValue: '',
      messages: [],
      isProcessing: false,
      agents: [],
      currentAgentId: null,
      goalTree: [],
      permissionRequests: [],
      runtimeStatus: null,
      planSnapshots: [],
      activePlanDiff: null,
      notifications: [],
      streamBuffer: '',
    }
  }

  /** 启动 TUI */
  start(): void {
    this.inkInstance = render(
      h(App, {
        onCommand: (cmd: string) => this.handleInput(cmd),
        getState: () => this.state,
        onPermissionDecision: (id: string, decision: PermissionDecision) => {
          this.state.permissionRequests = this.state.permissionRequests.filter((r) => r.id !== id)
          this.onPermission?.(id, decision)
        },
      }),
    )
  }

  /** 停止 TUI */
  stop(): void {
    this.inkInstance?.unmount()
  }

  // ---- 状态更新接口（供后端调用） ----

  /** 添加聊天消息 */
  addMessage(role: ChatMessage['role'], content: string, agentId?: string): void {
    this.state.messages.push({
      id: ++this.msgCounter,
      role,
      content,
      timestamp: Date.now(),
      agentId,
    })
  }

  /** 更新流式输出 buffer */
  updateStreamBuffer(content: string): void {
    this.state.streamBuffer = content
  }

  /** 清除流式 buffer */
  clearStreamBuffer(): void {
    this.state.streamBuffer = ''
  }

  /** 设置处理状态 */
  setProcessing(processing: boolean): void {
    this.state.isProcessing = processing
  }

  /** 更新 agent 树 */
  updateAgentTree(agents: AgentHierarchyNode[]): void {
    this.state.agents = agents
  }

  /** 设置当前 agent */
  setCurrentAgent(agentId: string | null): void {
    this.state.currentAgentId = agentId
  }

  /** 更新目标树 */
  updateGoalTree(goals: GoalNode[]): void {
    this.state.goalTree = goals
  }

  /** 推送权限请求 */
  pushPermissionRequest(request: PermissionRequest): void {
    this.state.permissionRequests.push(request)
  }

  /** 更新运行时状态 */
  updateRuntimeStatus(status: RuntimeStatus): void {
    this.state.runtimeStatus = status
  }

  /** 更新计划快照列表 */
  updatePlanSnapshots(snapshots: PlanSnapshot[]): void {
    this.state.planSnapshots = snapshots
  }

  /** 设置活跃差分 */
  setActivePlanDiff(diff: PlanDiff | null): void {
    this.state.activePlanDiff = diff
  }

  /** 推送通知 */
  notify(message: string): void {
    this.state.notifications.push(message)
    if (this.state.notifications.length > 50) {
      this.state.notifications = this.state.notifications.slice(-30)
    }
  }

  /** 切换视图 */
  setViewMode(mode: ViewMode): void {
    this.state.viewMode = mode
  }

  // ---- 输入处理 ----

  private async handleInput(input: string): Promise<void> {
    // 视图切换命令
    if (input === '/chat' || input === '/c') { this.state.viewMode = 'chat'; return }
    if (input === '/agents' || input === '/a') { this.state.viewMode = 'agents'; return }
    if (input === '/goals' || input === '/g') { this.state.viewMode = 'goals'; return }
    if (input === '/signals' || input === '/s') { this.state.viewMode = 'signals'; return }
    if (input === '/plan' || input === '/p') { this.state.viewMode = 'plan'; return }
    if (input === '/help' || input === '/h' || input === '/?') { this.state.viewMode = 'help'; return }

    if (input === '/exit' || input === '/quit' || input === '/q') {
      this.stop()
      process.exit(0)
    }

    // 命令处理
    if (input.startsWith('/')) {
      const parts = input.slice(1).split(/\s+/)
      const cmd = parts[0]
      const args = parts.slice(1)

      if (this.onCommand) {
        this.state.isProcessing = true
        try {
          const result = await this.onCommand(cmd, args)
          if (result) {
            this.addMessage('system', result)
          }
        } catch (err) {
          this.addMessage('system', `错误: ${err instanceof Error ? err.message : String(err)}`)
        }
        this.state.isProcessing = false
      }
      return
    }

    // 普通聊天
    this.addMessage('user', input)
    this.state.isProcessing = true

    if (this.onChat) {
      try {
        const result = await this.onChat(input)
        if (result) {
          this.clearStreamBuffer()
          this.addMessage('assistant', result.response, this.state.currentAgentId ?? undefined)
        }
      } catch (err) {
        this.addMessage('system', `错误: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    this.state.isProcessing = false
  }
}

// ============================================================
//  导出
// ============================================================

export type { ViewMode, TUIState }
export { THEME, STATUS_COLORS, STATUS_ICONS }
