/**
 * Agent 类 — 核心设计（v2: 并行 + 信号驱动）
 *
 * 设计要点：
 * - 每个 Agent 独立运行，完成任务后回到 idle 等待信号
 * - 节点之间通过 SignalBus 异步通信，支持 wake / monitor / data 等信号
 * - watchTags 控制 agent 可接收的信号类型（权限标签）
 * - 父节点创建子节点时自动继承子节点的所有 watchTags
 * - 父节点可回收子 agent，对其记忆进行深度压缩后封存
 * - 支持自主模式（autonomous）：agent 可被外部触发器自动唤醒
 */

import type { Tool } from './tool.ts'
import type { ChatMessage, ModelProvider } from '../provider/types.ts'
import type { AgentSignal } from './signal-bus.ts'

// ---- Agent 角色 ----

export type AgentRole = 'coordinator' | 'worker' | 'standalone'

// ---- Agent 状态（并行生命周期） ----

export type AgentStatus =
  | 'idle'        // 就绪等待信号/输入
  | 'running'     // 执行中
  | 'suspended'   // 被冻结（兄弟冲突/父级指令）
  | 'done'        // 当前任务完成（随后自动回 idle）
  | 'failed'      // 任务失败（可恢复后回 idle）
  | 'killed'      // 被终止（不可恢复）
  | 'recycled'    // 已回收（记忆压缩后封存，不再活动）

// ---- 自主触发配置 ----

export type AutoTrigger =
  | { type: 'signal'; tags: string[] }           // 被 tagged 信号唤醒
  | { type: 'file_watch'; patterns: string[] }    // 文件系统变更
  | { type: 'schedule'; intervalMs: number }       // 定时触发
  | { type: 'webhook'; path: string }              // HTTP webhook（预留）

export interface AutonomousConfig {
  /** 是否启用自主模式 */
  enabled: boolean
  /** 触发器列表 */
  triggers: AutoTrigger[]
  /** 自主运行最大次数（-1 = 无限） */
  maxAutoRuns: number
  /** 自主模式下自动放行的工具（不需人工确认） */
  autoApproveTools: string[]
  /** 自主模式附加 system prompt */
  autoPrompt?: string
}

// ---- Agent 配置 ----

export interface AgentConfig {
  /** 唯一 ID（不填则自动生成） */
  id?: string
  /** 显示名称 */
  name: string
  /** 角色 */
  role: AgentRole
  /** 系统 prompt（定义 agent 能力与行为） */
  systemPrompt: string
  /** 可使用的工具列表（为空则无工具） */
  tools?: Tool[]
  /** 使用的模型 provider */
  provider?: ModelProvider
  /** 使用的模型名称 */
  model?: string
  /** 最大循环轮次 */
  maxTurns?: number
  /** 最大 token 预算 */
  maxBudgetTokens?: number
  /** 标签（用于 ModelRouter 匹配能力） */
  tags?: string[]
  /**
   * watchTags — 信号权限标签
   * 控制 agent 可接收的信号类型，例如：
   * 'fs:watch', 'process:monitor', 'network:listen', 'agent:wake'
   */
  watchTags?: string[]
  /** 自主模式配置 */
  autonomous?: Partial<AutonomousConfig>
}

// ---- 任务通知（子 agent 完成后回报给父 agent） ----

export interface TaskNotification {
  agentId: string
  agentName: string
  status: 'completed' | 'failed' | 'killed'
  summary: string
  result: string
  usage: {
    totalTokens: number
    toolUses: number
    durationMs: number
  }
}

// ---- 压缩记忆（agent 被回收后的封存快照） ----

export interface CompressedMemory {
  /** 原 agent ID */
  agentId: string
  /** 原 agent 名称 */
  agentName: string
  /** 角色 */
  role: AgentRole
  /** 深度压缩后的对话摘要 */
  summary: string
  /** 关键发现/结论 */
  keyResults: string[]
  /** 工具使用统计 */
  toolHistory: { tool: string; count: number; lastResult: string }[]
  /** 原始 watchTags */
  watchTags: string[]
  /** 累计 token */
  totalTokens: number
  /** 累计工具调用 */
  totalToolUses: number
  /** 总运行时长 ms */
  totalDurationMs: number
  /** 信号处理统计 */
  signalsHandled: number
  /** 自主运行次数 */
  autoRuns: number
  /** 创建时间 */
  createdAt: number
  /** 回收时间 */
  recycledAt: number
}

// ---- Agent 事件 ----

export type AgentEvent =
  | { type: 'log'; agentId: string; message: string }
  | { type: 'progress'; agentId: string; content: string }
  | { type: 'tool_call'; agentId: string; toolName: string; input: unknown }
  | { type: 'tool_result'; agentId: string; toolName: string; output: string; error?: boolean }
  | { type: 'status_change'; agentId: string; from: AgentStatus; to: AgentStatus }
  | { type: 'child_created'; parentId: string; childId: string }
  | { type: 'child_done'; parentId: string; notification: TaskNotification }
  | { type: 'signal_received'; agentId: string; signal: AgentSignal }
  | { type: 'woken'; agentId: string; source: string; reason?: string }
  | { type: 'recycled'; agentId: string; memory: CompressedMemory }
  | { type: 'watch_tags_changed'; agentId: string; tags: string[] }

export type AgentEventHandler = (event: AgentEvent) => void

// ---- Agent 类 ----

let agentCounter = 0

export class Agent {
  readonly id: string
  readonly name: string
  readonly role: AgentRole
  readonly systemPrompt: string
  readonly tools: Tool[]
  readonly tags: string[]

  /** 使用的 provider（可被 ModelRouter 动态替换） */
  provider: ModelProvider | undefined
  /** 使用的模型 */
  model: string | undefined
  /** 最大轮次 */
  maxTurns: number
  /** 最大 token */
  maxBudgetTokens: number

  /** 对话历史 */
  messages: ChatMessage[] = []
  /** 当前状态 */
  status: AgentStatus = 'idle'
  /** token 计数 */
  totalTokens = 0
  /** 工具调用计数 */
  toolUses = 0
  /** 开始时间 */
  startTime = 0

  // ---- 上下级关系 ----
  /** 父 agent（null 表示顶层） */
  parent: Agent | null = null
  /** 子 agent 列表 */
  children: Agent[] = []
  /** 子 agent 完成通知队列 */
  childNotifications: TaskNotification[] = []

  // ---- 信号系统 ----
  /**
   * watchTags — 信号权限标签
   * 父节点创建子节点时，自动继承子节点的所有 watchTags
   */
  readonly watchTags: Set<string>
  /** 待处理信号队列（按优先级排序） */
  signalQueue: AgentSignal[] = []
  /** 信号处理计数 */
  signalsHandled = 0

  // ---- 自主模式 ----
  readonly autonomous: AutonomousConfig
  /** 自主运行次数 */
  autoRunCount = 0
  /** 定时器 ID（schedule 触发） */
  private scheduleTimers: ReturnType<typeof setInterval>[] = []

  // ---- 唤醒控制 ----
  /** idle 时的唤醒 Promise（外部通过 wake() 解除） */
  private wakeResolver: ((signal: AgentSignal) => void) | null = null

  // ---- 回收 ----
  /** 已回收子 agent 的压缩记忆 */
  archivedChildren: CompressedMemory[] = []

  // ---- 事件 ----
  private eventHandlers: AgentEventHandler[] = []

  constructor(config: AgentConfig) {
    this.id = config.id ?? `agent-${++agentCounter}`
    this.name = config.name
    this.role = config.role
    this.systemPrompt = config.systemPrompt
    this.tools = config.tools ?? []
    this.tags = config.tags ?? []
    this.provider = config.provider
    this.model = config.model
    this.maxTurns = config.maxTurns ?? 20
    this.maxBudgetTokens = config.maxBudgetTokens ?? 100_000

    // 信号 watchTags
    this.watchTags = new Set(config.watchTags ?? ['agent:wake']) // 默认至少能被唤醒

    // 自主模式
    this.autonomous = {
      enabled: config.autonomous?.enabled ?? false,
      triggers: config.autonomous?.triggers ?? [],
      maxAutoRuns: config.autonomous?.maxAutoRuns ?? 10,
      autoApproveTools: config.autonomous?.autoApproveTools ?? ['file_read'],
      autoPrompt: config.autonomous?.autoPrompt,
    }
  }

  // ---- 事件系统 ----

  on(handler: AgentEventHandler): () => void {
    this.eventHandlers.push(handler)
    return () => {
      this.eventHandlers = this.eventHandlers.filter((h) => h !== handler)
    }
  }

  emit(event: AgentEvent): void {
    for (const handler of this.eventHandlers) handler(event)
    // 冒泡到父 agent
    this.parent?.emit(event)
  }

  // ---- 状态管理 ----

  setStatus(status: AgentStatus): void {
    const from = this.status
    this.status = status
    this.emit({ type: 'status_change', agentId: this.id, from, to: status })
  }

  log(message: string): void {
    this.emit({ type: 'log', agentId: this.id, message })
  }

  // ---- 信号处理 ----

  /**
   * 接收信号 — 由 SignalBus 调用
   * 如果 agent 正在 idle 等待，唤醒它；否则加入队列。
   */
  receiveSignal(signal: AgentSignal): void {
    this.emit({ type: 'signal_received', agentId: this.id, signal })
    this.signalsHandled++

    if (signal.type === 'wake' && this.wakeResolver) {
      // agent 正在 idle 等待唤醒 → 立即解除
      this.wakeResolver(signal)
      this.wakeResolver = null
    } else {
      // 加入队列，按优先级插入
      const idx = this.signalQueue.findIndex((s) => s.priority < signal.priority)
      if (idx === -1) {
        this.signalQueue.push(signal)
      } else {
        this.signalQueue.splice(idx, 0, signal)
      }
    }
  }

  /**
   * 等待唤醒信号 — agent 完成任务后调用
   * 返回唤醒信号（wake/monitor/data 等）
   */
  waitForWake(): Promise<AgentSignal> {
    return new Promise<AgentSignal>((resolve) => {
      // 先检查队列中是否有待处理的 wake 信号
      const wakeIdx = this.signalQueue.findIndex((s) => s.type === 'wake')
      if (wakeIdx !== -1) {
        const signal = this.signalQueue.splice(wakeIdx, 1)[0]
        resolve(signal)
        return
      }
      this.wakeResolver = resolve
    })
  }

  /** 消费信号队列中的下一个信号 */
  popSignal(): AgentSignal | undefined {
    return this.signalQueue.shift()
  }

  /** 查看信号队列（不消费） */
  peekSignals(): AgentSignal[] {
    return [...this.signalQueue]
  }

  // ---- watchTag 管理 ----

  /** 添加 watchTag */
  addWatchTag(tag: string): void {
    this.watchTags.add(tag)
    // 向上传播：父节点也获得此 tag
    if (this.parent) {
      this.parent.inheritWatchTag(tag)
    }
    this.emit({ type: 'watch_tags_changed', agentId: this.id, tags: [...this.watchTags] })
  }

  /** 批量添加 watchTags */
  addWatchTags(tags: string[]): void {
    for (const tag of tags) this.watchTags.add(tag)
    if (this.parent) {
      for (const tag of tags) this.parent.inheritWatchTag(tag)
    }
    this.emit({ type: 'watch_tags_changed', agentId: this.id, tags: [...this.watchTags] })
  }

  /** 移除 watchTag（不影响父节点已继承的） */
  removeWatchTag(tag: string): void {
    this.watchTags.delete(tag)
    this.emit({ type: 'watch_tags_changed', agentId: this.id, tags: [...this.watchTags] })
  }

  /** 继承子节点的 watchTag（向上传播） */
  private inheritWatchTag(tag: string): void {
    if (this.watchTags.has(tag)) return
    this.watchTags.add(tag)
    // 继续向上传播
    if (this.parent) {
      this.parent.inheritWatchTag(tag)
    }
  }

  // ---- 上下级关系 ----

  /**
   * 创建子 agent
   * - 子 agent 继承父 agent 的事件总线，但拥有独立的消息历史和工具集
   * - 父节点自动继承子节点的所有 watchTags
   */
  createChild(config: AgentConfig): Agent {
    const child = new Agent(config)
    child.parent = this
    this.children.push(child)

    // 父节点继承子节点的 watchTags
    for (const tag of child.watchTags) {
      this.inheritWatchTag(tag)
    }

    this.emit({ type: 'child_created', parentId: this.id, childId: child.id })
    return child
  }

  /**
   * 子 agent 完成后汇报
   */
  reportToParent(): TaskNotification {
    const notification: TaskNotification = {
      agentId: this.id,
      agentName: this.name,
      status: this.status === 'done' ? 'completed' : this.status === 'failed' ? 'failed' : 'killed',
      summary: this.getSummary(),
      result: this.getLastAssistantMessage(),
      usage: {
        totalTokens: this.totalTokens,
        toolUses: this.toolUses,
        durationMs: Date.now() - this.startTime,
      },
    }

    if (this.parent) {
      this.parent.childNotifications.push(notification)
      this.parent.emit({ type: 'child_done', parentId: this.parent.id, notification })
    }

    return notification
  }

  // ---- Agent 回收与记忆压缩 ----

  /**
   * 回收子 agent — 压缩其记忆后封存
   *
   * 流程：
   * 1. 确认子 agent 已完成任务（idle/done/failed）
   * 2. 深度压缩对话历史为摘要
   * 3. 提取关键结果和工具使用统计
   * 4. 封存为 CompressedMemory
   * 5. 从 children 列表移除，存入 archivedChildren
   * 6. 标记子 agent 为 recycled
   */
  recycleChild(childId: string): CompressedMemory | null {
    const childIdx = this.children.findIndex((c) => c.id === childId)
    if (childIdx === -1) return null

    const child = this.children[childIdx]
    if (child.status === 'running') {
      this.log(`无法回收正在运行的子 agent ${child.name}`)
      return null
    }

    // 先递归回收子 agent 的子代
    for (const grandchild of [...child.children]) {
      child.recycleChild(grandchild.id)
    }

    // 压缩记忆
    const memory = child.compressMemory()

    // 清理
    child.setStatus('recycled')
    child.clearScheduleTimers()
    child.messages = []
    child.signalQueue = []

    // 从 children 列表移除，存入归档
    this.children.splice(childIdx, 1)
    this.archivedChildren.push(memory)

    this.emit({ type: 'recycled', agentId: child.id, memory })
    return memory
  }

  /**
   * 深度压缩当前 agent 的记忆
   */
  compressMemory(): CompressedMemory {
    // 提取工具使用统计
    const toolCounts = new Map<string, { count: number; lastResult: string }>()
    for (const msg of this.messages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const name = tc.function.name
          const entry = toolCounts.get(name) ?? { count: 0, lastResult: '' }
          entry.count++
          toolCounts.set(name, entry)
        }
      }
      if (msg.role === 'tool' && msg.tool_call_id) {
        // 找到对应的工具名
        for (const [name, entry] of toolCounts.entries()) {
          entry.lastResult = String(msg.content).slice(0, 200)
        }
      }
    }

    // 提取关键结果（所有 assistant 消息的前 100 字符）
    const keyResults: string[] = []
    for (const msg of this.messages) {
      if (msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.length > 0) {
        keyResults.push(msg.content.slice(0, 100))
      }
    }

    // 生成综合摘要
    const summary = this.generateCompressedSummary()

    return {
      agentId: this.id,
      agentName: this.name,
      role: this.role,
      summary,
      keyResults: keyResults.slice(-10), // 保留最后 10 条
      toolHistory: [...toolCounts.entries()].map(([tool, stat]) => ({
        tool,
        count: stat.count,
        lastResult: stat.lastResult,
      })),
      watchTags: [...this.watchTags],
      totalTokens: this.totalTokens,
      totalToolUses: this.toolUses,
      totalDurationMs: Date.now() - (this.startTime || Date.now()),
      signalsHandled: this.signalsHandled,
      autoRuns: this.autoRunCount,
      createdAt: this.startTime || Date.now(),
      recycledAt: Date.now(),
    }
  }

  /** 生成压缩摘要 */
  private generateCompressedSummary(): string {
    const assistantMsgs = this.messages
      .filter((m) => m.role === 'assistant' && typeof m.content === 'string')
      .map((m) => String(m.content))

    if (assistantMsgs.length === 0) return '(无对话记录)'

    // 取最后一条完整消息 + 前面消息的极简摘要
    const lastMsg = assistantMsgs[assistantMsgs.length - 1]
    if (assistantMsgs.length === 1) return lastMsg.slice(0, 500)

    const earlierSummary = assistantMsgs
      .slice(0, -1)
      .map((m) => m.slice(0, 50))
      .join(' → ')
    return `[${assistantMsgs.length} 轮对话] ${earlierSummary.slice(0, 200)} ⟶ 最终: ${lastMsg.slice(0, 300)}`
  }

  // ---- 自主模式 ----

  /** 启动定时触发器 */
  startScheduleTimers(onTrigger: (agent: Agent, trigger: AutoTrigger) => void): void {
    for (const trigger of this.autonomous.triggers) {
      if (trigger.type === 'schedule') {
        const timer = setInterval(() => {
          if (this.status === 'idle' && this.autoRunCount < this.autonomous.maxAutoRuns) {
            onTrigger(this, trigger)
          }
        }, trigger.intervalMs)
        this.scheduleTimers.push(timer)
      }
    }
  }

  /** 清理定时器 */
  clearScheduleTimers(): void {
    for (const timer of this.scheduleTimers) clearInterval(timer)
    this.scheduleTimers = []
  }

  /** 检查信号触发器是否匹配 */
  matchesSignalTrigger(signal: AgentSignal): boolean {
    if (!this.autonomous.enabled) return false
    return this.autonomous.triggers.some(
      (t) => t.type === 'signal' && t.tags.some((tag) => signal.tags.includes(tag)),
    )
  }

  // ---- 上下文构建 ----

  /** 构建系统消息（包含子 agent 通知） */
  buildSystemMessage(): string {
    let system = this.systemPrompt

    // 注入待处理的子 agent 通知
    if (this.childNotifications.length > 0) {
      system += '\n\n# 子 Agent 通知\n'
      for (const n of this.childNotifications) {
        system += `\n<task-notification>
  <task-id>${n.agentId}</task-id>
  <agent-name>${n.agentName}</agent-name>
  <status>${n.status}</status>
  <summary>${n.summary}</summary>
  <result>${n.result}</result>
  <usage>
    <total_tokens>${n.usage.totalTokens}</total_tokens>
    <tool_uses>${n.usage.toolUses}</tool_uses>
    <duration_ms>${n.usage.durationMs}</duration_ms>
  </usage>
</task-notification>\n`
      }
      this.childNotifications = [] // 已注入，清空
    }

    return system
  }

  // ---- 辅助方法 ----

  /** 获取最后一条 assistant 消息 */
  getLastAssistantMessage(): string {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i]
      if (msg.role === 'assistant' && typeof msg.content === 'string') {
        return msg.content
      }
    }
    return ''
  }

  /** 简要摘要 */
  getSummary(): string {
    const lastMsg = this.getLastAssistantMessage()
    if (lastMsg.length <= 200) return lastMsg
    return lastMsg.slice(0, 200) + '...'
  }

  /** 获取完整的 agent 层级树（包含信号信息） */
  getHierarchy(): AgentHierarchyNode {
    return {
      id: this.id,
      name: this.name,
      role: this.role,
      status: this.status,
      model: this.model,
      watchTags: [...this.watchTags],
      signalQueueSize: this.signalQueue.length,
      autoRuns: this.autoRunCount,
      archivedCount: this.archivedChildren.length,
      children: this.children.map((c) => c.getHierarchy()),
    }
  }

  /** 向上追溯获取根 agent */
  getRoot(): Agent {
    let current: Agent = this
    while (current.parent) current = current.parent
    return current
  }

  /** 获取层级深度（root = 0） */
  getDepth(): number {
    let depth = 0
    let current: Agent = this
    while (current.parent) {
      depth++
      current = current.parent
    }
    return depth
  }

  /** 按 ID 在整棵树中查找 agent */
  findById(id: string): Agent | undefined {
    if (this.id === id) return this
    for (const child of this.children) {
      const found = child.findById(id)
      if (found) return found
    }
    return undefined
  }

  /** 获取整棵树中所有活跃（非 recycled）的 agent */
  getAllActive(): Agent[] {
    const result: Agent[] = []
    if (this.status !== 'recycled') result.push(this)
    for (const child of this.children) {
      result.push(...child.getAllActive())
    }
    return result
  }

  /** 获取整棵树中所有 idle 的 agent */
  getAllIdle(): Agent[] {
    return this.getAllActive().filter((a) => a.status === 'idle')
  }
}

// ---- 层级树节点（用于可视化，包含新增字段） ----

export interface AgentHierarchyNode {
  id: string
  name: string
  role: AgentRole
  status: AgentStatus
  model?: string
  watchTags: string[]
  signalQueueSize: number
  autoRuns: number
  archivedCount: number
  children: AgentHierarchyNode[]
}
