/**
 * SignalBus — 跨 Agent 信号系统
 *
 * 核心概念：
 * - Agent 之间通过 Signal 异步通信
 * - 每个 Agent 持有 watchTags 标签集，只接收匹配标签的信号
 * - 父节点创建子节点时自动继承子节点的所有 watchTags
 * - 外部系统（文件监控、HTTP webhook 等）也可发射信号
 *
 * 信号优先级：critical > high > normal > low
 * 信号路由：broadcast（广播）、targeted（定向）、tagged（按标签匹配）
 */

// ---- 信号类型 ----

export type SignalType =
  | 'wake'         // 唤醒 idle agent
  | 'monitor'      // 监控事件（文件变更、进程、网络等）
  | 'data'         // 来自其他 agent 的数据传递
  | 'escalation'   // 问题上报
  | 'directive'    // 父级指令下发
  | 'shutdown'     // 优雅关闭
  | 'heartbeat'    // 心跳检测
  | 'custom'       // 自定义信号

export type SignalPriority = 0 | 1 | 2 | 3 // 0=low, 1=normal, 2=high, 3=critical

export type SignalRouting =
  | { mode: 'targeted'; targetId: string }
  | { mode: 'broadcast' }
  | { mode: 'tagged'; requiredTags: string[] }

// ---- 信号定义 ----

let signalCounter = 0

export interface AgentSignal {
  /** 信号唯一 ID */
  id: string
  /** 信号类型 */
  type: SignalType
  /** 来源（agent ID 或 'external' 或具体外部源名） */
  source: string
  /** 路由策略 */
  routing: SignalRouting
  /** 信号载荷 */
  payload: unknown
  /** 信号所需的 watchTag（tagged 路由时使用） */
  tags: string[]
  /** 优先级 */
  priority: SignalPriority
  /** 时间戳 */
  timestamp: number
  /** 是否已处理 */
  handled: boolean
}

/** 创建信号 */
export function createSignal(
  type: SignalType,
  source: string,
  routing: SignalRouting,
  payload: unknown,
  options?: { tags?: string[]; priority?: SignalPriority },
): AgentSignal {
  return {
    id: `sig-${++signalCounter}-${Date.now()}`,
    type,
    source,
    routing,
    payload,
    tags: options?.tags ?? [],
    priority: options?.priority ?? 1,
    timestamp: Date.now(),
    handled: false,
  }
}

// ---- 信号监听器 ----

export interface SignalListener {
  /** 监听器所属的 agent ID */
  agentId: string
  /** 该 agent 关注的 watchTags */
  watchTags: Set<string>
  /** 接收信号的回调 */
  onSignal: (signal: AgentSignal) => void | Promise<void>
  /** 是否处于活跃状态（idle 时才接收 wake 信号） */
  active: boolean
}

// ---- 信号总线事件 ----

export type SignalBusEvent =
  | { type: 'signal_emitted'; signal: AgentSignal }
  | { type: 'signal_delivered'; signal: AgentSignal; targetId: string }
  | { type: 'signal_dropped'; signal: AgentSignal; reason: string }
  | { type: 'listener_registered'; agentId: string; watchTags: string[] }
  | { type: 'listener_removed'; agentId: string }

// ---- SignalBus 实现 ----

export class SignalBus {
  private listeners = new Map<string, SignalListener>()
  private signalLog: AgentSignal[] = []
  private maxLogSize: number
  private eventHandler?: (event: SignalBusEvent) => void

  constructor(options?: { maxLogSize?: number }) {
    this.maxLogSize = options?.maxLogSize ?? 1000
  }

  /** 设置事件回调 */
  setEventHandler(handler: (event: SignalBusEvent) => void): void {
    this.eventHandler = handler
  }

  private emit(event: SignalBusEvent): void {
    this.eventHandler?.(event)
  }

  // ---- 监听器管理 ----

  /** 注册信号监听器 */
  register(listener: SignalListener): void {
    this.listeners.set(listener.agentId, listener)
    this.emit({ type: 'listener_registered', agentId: listener.agentId, watchTags: [...listener.watchTags] })
  }

  /** 移除监听器 */
  unregister(agentId: string): void {
    this.listeners.delete(agentId)
    this.emit({ type: 'listener_removed', agentId })
  }

  /** 更新 agent 的 watchTags */
  updateWatchTags(agentId: string, tags: Set<string>): void {
    const listener = this.listeners.get(agentId)
    if (listener) {
      listener.watchTags = tags
    }
  }

  /** 设置监听器活跃状态 */
  setActive(agentId: string, active: boolean): void {
    const listener = this.listeners.get(agentId)
    if (listener) {
      listener.active = active
    }
  }

  /** 获取监听器 */
  getListener(agentId: string): SignalListener | undefined {
    return this.listeners.get(agentId)
  }

  // ---- 信号发送 ----

  /**
   * 发射信号 — 根据路由策略分发给匹配的监听器
   *
   * 路由模式：
   * - targeted: 直接发给指定 agent
   * - broadcast: 发给所有监听器
   * - tagged: 发给持有匹配 watchTag 的监听器
   *
   * 信号按优先级排序后分发，critical 信号即使 agent 不在 idle 也会送达。
   */
  async send(signal: AgentSignal): Promise<string[]> {
    this.logSignal(signal)
    this.emit({ type: 'signal_emitted', signal })

    const delivered: string[] = []

    if (signal.routing.mode === 'targeted') {
      const listener = this.listeners.get(signal.routing.targetId)
      if (listener) {
        await this.deliver(signal, listener)
        delivered.push(listener.agentId)
      } else {
        this.emit({ type: 'signal_dropped', signal, reason: `目标 ${signal.routing.targetId} 未注册` })
      }
    } else if (signal.routing.mode === 'broadcast') {
      for (const listener of this.listeners.values()) {
        if (listener.agentId === signal.source) continue // 不发给自己
        await this.deliver(signal, listener)
        delivered.push(listener.agentId)
      }
    } else if (signal.routing.mode === 'tagged') {
      const requiredTags = signal.routing.requiredTags
      for (const listener of this.listeners.values()) {
        if (listener.agentId === signal.source) continue
        // 检查 listener 是否持有所需 tag
        const hasTag = requiredTags.some((tag) => listener.watchTags.has(tag))
        if (hasTag) {
          await this.deliver(signal, listener)
          delivered.push(listener.agentId)
        }
      }
      if (delivered.length === 0) {
        this.emit({ type: 'signal_dropped', signal, reason: `无匹配 tag [${requiredTags.join(',')}] 的监听器` })
      }
    }

    signal.handled = delivered.length > 0
    return delivered
  }

  /** 快捷方法：发送定向唤醒信号 */
  async wake(targetId: string, source: string, payload?: unknown): Promise<boolean> {
    const signal = createSignal('wake', source, { mode: 'targeted', targetId }, payload, { priority: 2 })
    const delivered = await this.send(signal)
    return delivered.length > 0
  }

  /** 快捷方法：发送广播信号 */
  async broadcast(type: SignalType, source: string, payload: unknown, tags?: string[]): Promise<string[]> {
    const signal = createSignal(type, source, { mode: 'broadcast' }, payload, { tags })
    return this.send(signal)
  }

  /** 快捷方法：发送 tagged 信号 */
  async sendTagged(
    type: SignalType,
    source: string,
    requiredTags: string[],
    payload: unknown,
    priority?: SignalPriority,
  ): Promise<string[]> {
    const signal = createSignal(type, source, { mode: 'tagged', requiredTags }, payload, { tags: requiredTags, priority })
    return this.send(signal)
  }

  // ---- 信号分发 ----

  private async deliver(signal: AgentSignal, listener: SignalListener): Promise<void> {
    // critical 信号无论 active 状态都送达
    // wake 信号只有 active=false（即 idle）时才送达（唤醒）
    // 其他信号只有 active=true 时送达
    if (signal.type === 'wake' && listener.active && signal.priority < 3) {
      return // agent 正在运行，不需要 wake（除非 critical）
    }
    if (signal.type !== 'wake' && signal.priority < 3 && !listener.active) {
      return // agent idle 且信号不是 wake/critical，跳过
    }

    try {
      await listener.onSignal(signal)
      this.emit({ type: 'signal_delivered', signal, targetId: listener.agentId })
    } catch {
      // 信号处理出错不中断总线
    }
  }

  // ---- 信号日志 ----

  private logSignal(signal: AgentSignal): void {
    this.signalLog.push(signal)
    if (this.signalLog.length > this.maxLogSize) {
      this.signalLog = this.signalLog.slice(-Math.floor(this.maxLogSize * 0.8))
    }
  }

  /** 获取信号日志 */
  getLog(filter?: { agentId?: string; type?: SignalType; since?: number }): AgentSignal[] {
    let log = this.signalLog
    if (filter?.agentId) {
      log = log.filter((s) => s.source === filter.agentId || (s.routing.mode === 'targeted' && s.routing.targetId === filter.agentId))
    }
    if (filter?.type) {
      log = log.filter((s) => s.type === filter.type)
    }
    if (filter?.since) {
      log = log.filter((s) => s.timestamp >= filter.since!)
    }
    return log
  }

  /** 获取总线统计 */
  getStats(): SignalBusStats {
    const byType = new Map<SignalType, number>()
    for (const s of this.signalLog) {
      byType.set(s.type, (byType.get(s.type) ?? 0) + 1)
    }
    return {
      totalSignals: this.signalLog.length,
      activeListeners: [...this.listeners.values()].filter((l) => l.active).length,
      idleListeners: [...this.listeners.values()].filter((l) => !l.active).length,
      byType: Object.fromEntries(byType),
    }
  }
}

export interface SignalBusStats {
  totalSignals: number
  activeListeners: number
  idleListeners: number
  byType: Record<string, number>
}
