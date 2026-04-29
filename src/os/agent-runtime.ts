/**
 * AgentRuntime — 自主 Agent 运行时
 *
 * 整合 SignalBus + AgentLoop + PermissionGuard，提供：
 *
 * 1. 自主循环 — agent 完成任务后回到 idle，被信号唤醒后自动执行下一个任务
 * 2. 并行子 agent — 多个子 agent 同时运行，各自独立
 * 3. 外部触发器注册 — 文件监控、定时器、webhook（预留）
 * 4. agent 回收与记忆压缩
 *
 * 使用方式：
 *   const runtime = new AgentRuntime({ signalBus, permissionGuard })
 *   runtime.registerAgent(agent)
 *   runtime.startAutonomous(agent)
 *   // agent 进入 idle → 被信号唤醒 → 执行 → idle → ...
 *   runtime.sendSignal(agent.id, 'wake', payload)
 */

import { Agent } from './agent.ts'
import type { AgentSignal } from './signal-bus.ts'
import { SignalBus, createSignal } from './signal-bus.ts'
import { runAgentLoop, runChildrenParallel } from './agent-loop.ts'
import type { AgentLoopResult } from './agent-loop.ts'
import type { PermissionGuard } from './permission-guard.ts'

// ---- Runtime 事件 ----

export type RuntimeEvent =
  | { type: 'agent_registered'; agentId: string }
  | { type: 'agent_started_autonomous'; agentId: string }
  | { type: 'agent_woken'; agentId: string; signal: AgentSignal }
  | { type: 'agent_task_completed'; agentId: string; result: AgentLoopResult }
  | { type: 'agent_returned_to_idle'; agentId: string }
  | { type: 'agent_recycled'; agentId: string }
  | { type: 'parallel_tasks_completed'; parentId: string; results: AgentLoopResult[] }
  | { type: 'error'; agentId: string; error: string }

// ---- AgentRuntime ----

export class AgentRuntime {
  readonly signalBus: SignalBus
  readonly permissionGuard: PermissionGuard | undefined

  /** 注册的 agent 索引 */
  private agents = new Map<string, Agent>()
  /** 自主循环中的 agent（key=agentId, value=AbortController） */
  private autonomousControllers = new Map<string, AbortController>()
  /** 事件回调 */
  private eventHandler?: (event: RuntimeEvent) => void

  constructor(options: {
    signalBus?: SignalBus
    permissionGuard?: PermissionGuard
  }) {
    this.signalBus = options.signalBus ?? new SignalBus()
    this.permissionGuard = options.permissionGuard
  }

  /** 设置事件回调 */
  setEventHandler(handler: (event: RuntimeEvent) => void): void {
    this.eventHandler = handler
  }

  private emit(event: RuntimeEvent): void {
    this.eventHandler?.(event)
  }

  // ============================================================
  //  Agent 注册
  // ============================================================

  /**
   * 注册 agent 到运行时
   * 自动在 SignalBus 上注册监听器
   */
  registerAgent(agent: Agent): void {
    this.agents.set(agent.id, agent)

    // 在信号总线注册监听器
    this.signalBus.register({
      agentId: agent.id,
      watchTags: agent.watchTags,
      active: agent.status === 'running',
      onSignal: (signal) => agent.receiveSignal(signal),
    })

    this.emit({ type: 'agent_registered', agentId: agent.id })
  }

  /** 注销 agent */
  unregisterAgent(agentId: string): void {
    this.stopAutonomous(agentId)
    this.signalBus.unregister(agentId)
    this.agents.delete(agentId)
  }

  /** 获取 agent */
  getAgent(agentId: string): Agent | undefined {
    return this.agents.get(agentId)
  }

  // ============================================================
  //  手动运行（人工触发）
  // ============================================================

  /**
   * 手动运行 agent（人工输入触发）
   * 完成后 agent 回到 idle
   */
  async runManual(
    agent: Agent,
    message: string,
    context?: string,
  ): Promise<AgentLoopResult> {
    this.signalBus.setActive(agent.id, true)

    try {
      const result = await runAgentLoop(agent, {
        userMessage: message,
        context,
        permissionGuard: this.permissionGuard,
        returnToIdle: true,
        autonomous: false,
      })

      this.emit({ type: 'agent_task_completed', agentId: agent.id, result })
      this.emit({ type: 'agent_returned_to_idle', agentId: agent.id })
      this.signalBus.setActive(agent.id, false)
      return result
    } catch (err) {
      this.signalBus.setActive(agent.id, false)
      this.emit({ type: 'error', agentId: agent.id, error: err instanceof Error ? err.message : String(err) })
      throw err
    }
  }

  // ============================================================
  //  自主循环
  // ============================================================

  /**
   * 启动 agent 的自主循环
   *
   * 流程：
   * 1. agent 进入 idle 状态
   * 2. 等待信号（wake/monitor/data）
   * 3. 收到信号后自动构建任务并执行
   * 4. 完成后回到 idle（步骤 2）
   * 5. 达到 maxAutoRuns 后停止自主循环
   */
  startAutonomous(agent: Agent, initialMessage?: string): void {
    if (!agent.autonomous.enabled) {
      throw new Error(`Agent "${agent.name}" 未启用自主模式`)
    }

    const ac = new AbortController()
    this.autonomousControllers.set(agent.id, ac)

    this.emit({ type: 'agent_started_autonomous', agentId: agent.id })

    // 启动定时触发器
    agent.startScheduleTimers((a, trigger) => {
      const signal = createSignal(
        'monitor',
        'scheduler',
        { mode: 'targeted', targetId: a.id },
        { trigger, message: `定时触发: ${trigger.type}` },
        { tags: trigger.type === 'schedule' ? ['schedule:tick'] : [] },
      )
      this.signalBus.send(signal)
    })

    // 启动自主循环（后台 async）
    this.autonomousLoop(agent, ac.signal, initialMessage).catch((err) => {
      this.emit({ type: 'error', agentId: agent.id, error: err instanceof Error ? err.message : String(err) })
    })
  }

  /** 停止自主循环 */
  stopAutonomous(agentId: string): void {
    const ac = this.autonomousControllers.get(agentId)
    if (ac) {
      ac.abort()
      this.autonomousControllers.delete(agentId)
    }
    const agent = this.agents.get(agentId)
    if (agent) {
      agent.clearScheduleTimers()
    }
  }

  /** 自主循环主体 */
  private async autonomousLoop(
    agent: Agent,
    signal: AbortSignal,
    initialMessage?: string,
  ): Promise<void> {
    // 如果有初始消息，先执行一次
    if (initialMessage) {
      try {
        this.signalBus.setActive(agent.id, true)
        const result = await runAgentLoop(agent, {
          userMessage: initialMessage,
          permissionGuard: this.permissionGuard,
          returnToIdle: true,
          autonomous: true,
          signal,
        })
        agent.autoRunCount++
        this.emit({ type: 'agent_task_completed', agentId: agent.id, result })
      } catch (err) {
        if (signal.aborted) return
        this.emit({ type: 'error', agentId: agent.id, error: err instanceof Error ? err.message : String(err) })
      }
      this.signalBus.setActive(agent.id, false)
    }

    // 主循环：等待信号 → 执行 → 回到 idle
    while (!signal.aborted) {
      // 检查自主运行次数限制
      if (agent.autonomous.maxAutoRuns >= 0 && agent.autoRunCount >= agent.autonomous.maxAutoRuns) {
        agent.log(`自主运行次数已达上限 (${agent.autoRunCount}/${agent.autonomous.maxAutoRuns})`)
        break
      }

      // 进入 idle，等待唤醒信号
      agent.setStatus('idle')
      this.signalBus.setActive(agent.id, false)
      this.emit({ type: 'agent_returned_to_idle', agentId: agent.id })

      const wakeSignal = await Promise.race([
        agent.waitForWake(),
        new Promise<null>((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
      ]).catch(() => null)

      if (!wakeSignal || signal.aborted) break

      // 被唤醒
      this.emit({ type: 'agent_woken', agentId: agent.id, signal: wakeSignal })
      agent.emit({ type: 'woken', agentId: agent.id, source: wakeSignal.source, reason: String(wakeSignal.payload ?? '') })

      // 构建任务消息
      const taskMessage = this.buildTaskFromSignal(agent, wakeSignal)

      try {
        this.signalBus.setActive(agent.id, true)
        const result = await runAgentLoop(agent, {
          userMessage: taskMessage,
          permissionGuard: this.permissionGuard,
          returnToIdle: true,
          autonomous: true,
          signal,
        })
        agent.autoRunCount++
        this.emit({ type: 'agent_task_completed', agentId: agent.id, result })
      } catch (err) {
        if (signal.aborted) break
        this.emit({ type: 'error', agentId: agent.id, error: err instanceof Error ? err.message : String(err) })
        // 失败后回到 idle 继续等待，而不是退出
        agent.setStatus('idle')
      }
      this.signalBus.setActive(agent.id, false)
    }

    // 循环结束，清理
    agent.clearScheduleTimers()
    this.autonomousControllers.delete(agent.id)
  }

  /** 从信号构建任务消息 */
  private buildTaskFromSignal(agent: Agent, signal: AgentSignal): string {
    const payloadStr = signal.payload
      ? (typeof signal.payload === 'string' ? signal.payload : JSON.stringify(signal.payload))
      : ''

    const autoPrompt = agent.autonomous.autoPrompt ?? ''

    switch (signal.type) {
      case 'wake':
        return `${autoPrompt}\n\n[唤醒信号] 来源: ${signal.source}\n${payloadStr}`.trim()
      case 'monitor':
        return `${autoPrompt}\n\n[监控事件] 来源: ${signal.source}\n事件数据:\n${payloadStr}`.trim()
      case 'data':
        return `${autoPrompt}\n\n[数据传递] 来自 agent ${signal.source}:\n${payloadStr}`.trim()
      case 'directive':
        return `${autoPrompt}\n\n[父级指令] 来自 ${signal.source}:\n${payloadStr}`.trim()
      default:
        return `${autoPrompt}\n\n[信号 ${signal.type}] 来源: ${signal.source}\n${payloadStr}`.trim()
    }
  }

  // ============================================================
  //  并行子 agent 协调
  // ============================================================

  /**
   * 在父 agent 下并行创建并运行多个子 agent
   *
   * @returns 所有子 agent 的运行结果
   */
  async runParallelChildren(
    parent: Agent,
    tasks: { config: Partial<import('./agent.ts').AgentConfig> & { name: string; systemPrompt: string }; message: string; context?: string }[],
  ): Promise<AgentLoopResult[]> {
    const children: { agent: Agent; message: string; context?: string }[] = []

    for (const task of tasks) {
      const child = parent.createChild({
        name: task.config.name,
        role: task.config.role ?? 'worker',
        systemPrompt: task.config.systemPrompt,
        tools: task.config.tools ?? parent.tools,
        provider: task.config.provider ?? parent.provider,
        model: task.config.model ?? parent.model,
        tags: task.config.tags,
        watchTags: task.config.watchTags,
      })
      this.registerAgent(child)
      children.push({ agent: child, message: task.message, context: task.context })
    }

    const results = await runChildrenParallel(parent, children.map((c) => c.agent), children, {
      permissionGuard: this.permissionGuard,
    })

    this.emit({ type: 'parallel_tasks_completed', parentId: parent.id, results })
    return results
  }

  // ============================================================
  //  Agent 回收
  // ============================================================

  /**
   * 回收 agent — 压缩记忆后封存
   */
  recycleAgent(parentId: string, childId: string): import('./agent.ts').CompressedMemory | null {
    const parent = this.agents.get(parentId)
    if (!parent) return null

    // 先停止自主循环
    this.stopAutonomous(childId)

    const memory = parent.recycleChild(childId)
    if (memory) {
      this.unregisterAgent(childId)
      this.emit({ type: 'agent_recycled', agentId: childId })
    }
    return memory
  }

  // ============================================================
  //  信号快捷方法
  // ============================================================

  /** 唤醒指定 agent */
  async wakeAgent(targetId: string, source: string, payload?: unknown): Promise<boolean> {
    return this.signalBus.wake(targetId, source, payload)
  }

  /** 向所有 agent 广播信号 */
  async broadcastSignal(source: string, payload: unknown, tags?: string[]): Promise<string[]> {
    return this.signalBus.broadcast('data', source, payload, tags)
  }

  /** 发送 tagged 监控信号 */
  async sendMonitorSignal(
    source: string,
    requiredTags: string[],
    payload: unknown,
  ): Promise<string[]> {
    return this.signalBus.sendTagged('monitor', source, requiredTags, payload, 2)
  }

  // ============================================================
  //  状态查询
  // ============================================================

  /** 获取运行时状态 */
  getStatus(): RuntimeStatus {
    const agents = [...this.agents.values()]
    return {
      totalAgents: agents.length,
      idleAgents: agents.filter((a) => a.status === 'idle').length,
      runningAgents: agents.filter((a) => a.status === 'running').length,
      autonomousAgents: this.autonomousControllers.size,
      signalBusStats: this.signalBus.getStats(),
    }
  }

  /** 获取所有注册的 agent */
  getAllAgents(): Agent[] {
    return [...this.agents.values()]
  }
}

export interface RuntimeStatus {
  totalAgents: number
  idleAgents: number
  runningAgents: number
  autonomousAgents: number
  signalBusStats: import('./signal-bus.ts').SignalBusStats
}
