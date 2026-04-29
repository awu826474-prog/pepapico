/**
 * Byte_cp — 统一入口层
 *
 * 将 Provider 层和 Agent OS 的所有公开 API 系统化封装，
 * 为前端提供单一导入点。
 *
 * 使用方式：
 *   import { ByteOS } from './index.ts'
 *   const os = new ByteOS()
 *   os.registerProvider('openrouter', { apiKey: '...' })
 *   const agent = os.createAgent({ name: 'coder', ... })
 *   const result = await os.run(agent, '帮我写一个排序')
 */

// ============================================================
//  Re-exports — 前端可按需 named import
// ============================================================

// ---- Provider 层 ----
export {
  // Provider 实现
  OpenAICompatibleProvider,
  NanoBananaProvider,
  CopilotProvider,
  // Copilot 认证
  requestDeviceCode,
  pollForToken,
  authenticateCopilot,
  listCopilotModels,
  // Provider 注册表
  registerProvider,
  registerImageProvider,
  getProvider,
  getImageProvider,
  listProviders,
  createOpenRouter,
  createNanoBanana,
  createCopilot,
  // 计费追踪
  LatencyTracker,
  TokenBillingTracker,
  OpenRouterUsageTracker,
  SubscriptionBillingTracker,
  UsageMonitor,
} from './provider/index.ts'

export type {
  // Provider 类型
  ModelProvider,
  ImageProvider,
  ProviderConfig,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  ContentPart,
  ContentPartText,
  ContentPartImage,
  ToolDefinition,
  ToolCall,
  TokenUsage,
  ImageGenerateRequest,
  ImageGenerateResult,
  ImageGenerateProgress,
  LatencyStats,
  // Copilot 类型
  CopilotProviderConfig,
  CopilotAuth,
  CopilotModelInfo,
  DeviceCodeResponse,
  // 计费类型
  TokenBillingStats,
  OpenRouterUsageStats,
  SubscriptionBillingStats,
  UnifiedUsageReport,
} from './provider/index.ts'

// ---- Agent OS 层 ----
export {
  // 核心
  Agent,
  runAgentLoop,
  runChildrenParallel,
  AgentManager,
  // 路由
  ModelRouter,
  inferTaskType,
  inferDifficulty,
  assessDifficulty,
  // 信号系统
  SignalBus,
  createSignal,
  // 权限守卫
  PermissionGuard,
  // 运行时
  AgentRuntime,
  // Plan Mode
  PlanMode,
  // 工具注册
  registerTool,
  getTool,
  getAllTools,
  getToolsByTag,
  toToolDefinitions,
  // 内置工具
  webFetchTool,
  bashTool,
  fileReadTool,
  fileWriteTool,
  createSubAgentTool,
} from './os/index.ts'

export type {
  // Agent 类型
  AgentConfig,
  AgentRole,
  AgentStatus,
  AgentEvent,
  AgentEventHandler,
  TaskNotification,
  AgentHierarchyNode,
  AgentLoopOptions,
  AgentLoopResult,
  CompressedMemory,
  AutoTrigger,
  AutonomousConfig,
  // 路由类型
  TaskType,
  DifficultyLevel,
  DifficultyFactors,
  DifficultyAssessment,
  RoutingRule,
  RoutingRequest,
  RoutingResult,
  // AgentManager 类型
  GoalNode,
  GoalStatus,
  PlanStep,
  EscalationRequest,
  PropagationDirective,
  PropagationDirection,
  ImpactAssessment,
  EscalationResult,
  EscalationLayer,
  EscalationReport,
  AISuggestion,
  PendingHumanDecision,
  PermissionPolicy,
  RolePermission,
  DepthRules,
  ManagerEvent,
  ManagerStats,
  PlanSnapshot,
  PlanDiff,
  PlanDiffEntry,
  PlanDiffModification,
  // 信号类型
  SignalType,
  SignalPriority,
  SignalRouting,
  AgentSignal,
  SignalListener,
  SignalBusEvent,
  SignalBusStats,
  // 权限类型
  RiskLevel,
  PermissionRequest,
  PermissionDecision,
  // 运行时类型
  RuntimeEvent,
  RuntimeStatus,
  // 工具类型
  Tool,
  ToolResult,
  ToolContext,
  ToolInputSchema,
} from './os/index.ts'

// ============================================================
//  ByteOS — 顶层门面（Facade）
// ============================================================

import { Agent } from './os/agent.ts'
import type { AgentConfig, AgentEvent, CompressedMemory } from './os/agent.ts'
import { runAgentLoop, runChildrenParallel } from './os/agent-loop.ts'
import type { AgentLoopOptions, AgentLoopResult } from './os/agent-loop.ts'
import { ModelRouter, assessDifficulty as _assessDifficulty, inferTaskType as _inferTaskType } from './os/model-router.ts'
import type { RoutingRule } from './os/model-router.ts'
import { AgentManager, PlanMode } from './os/agent-manager.ts'
import type { PermissionPolicy, PlanDiff, PlanSnapshot } from './os/agent-manager.ts'
import { SignalBus } from './os/signal-bus.ts'
import { PermissionGuard } from './os/permission-guard.ts'
import type { PermissionRequest, PermissionDecision } from './os/permission-guard.ts'
import { AgentRuntime } from './os/agent-runtime.ts'
import type { RuntimeStatus } from './os/agent-runtime.ts'
import {
  registerProvider as _registerProvider,
  createCopilot as _createCopilot,
  getProvider as _getProvider,
  listProviders as _listProviders,
} from './provider/registry.ts'
import type { ProviderConfig, ModelProvider } from './provider/types.ts'
import { UsageMonitor, TokenBillingTracker as _TBT, SubscriptionBillingTracker as _SBT } from './provider/usage.ts'
import type { UnifiedUsageReport } from './provider/usage.ts'
import { webFetchTool, bashTool, fileReadTool, fileWriteTool, createSubAgentTool } from './os/tools/index.ts'
import type { Tool } from './os/tool.ts'

export interface ByteOSConfig {
  /** 默认路由规则 */
  routingRules?: RoutingRule[]
  /** 权限策略 */
  permissionPolicy?: PermissionPolicy
  /** 全局事件监听 */
  onEvent?: (event: AgentEvent) => void
  /** 权限确认请求回调（前端注册） */
  onPermissionRequest?: (request: PermissionRequest) => void
  /** 自动放行风险等级 */
  autoApproveLevel?: 'low' | 'medium' | 'high'
}

/**
 * ByteOS — 一站式项目托管门面
 *
 * 整合 Provider、Agent、路由、计费、权限、信号、Plan Mode 为统一 API。
 */
export class ByteOS {
  readonly router: ModelRouter
  readonly manager: AgentManager
  readonly monitor: UsageMonitor
  readonly signalBus: SignalBus
  readonly permissionGuard: PermissionGuard
  readonly runtime: AgentRuntime
  readonly planMode: PlanMode
  private globalEventHandler?: (event: AgentEvent) => void

  constructor(config?: ByteOSConfig) {
    this.router = new ModelRouter()
    this.manager = new AgentManager()
    this.monitor = new UsageMonitor()
    this.signalBus = new SignalBus()
    this.permissionGuard = new PermissionGuard({
      autoApproveLevel: config?.autoApproveLevel ?? 'low',
    })
    this.runtime = new AgentRuntime({
      signalBus: this.signalBus,
      permissionGuard: this.permissionGuard,
    })
    this.planMode = new PlanMode()

    if (config?.routingRules) {
      for (const rule of config.routingRules) this.router.addRule(rule)
    }
    if (config?.permissionPolicy) {
      this.manager.setPolicy(config.permissionPolicy)
    }
    if (config?.onEvent) {
      this.globalEventHandler = config.onEvent
    }
    if (config?.onPermissionRequest) {
      this.permissionGuard.setRequestHandler(config.onPermissionRequest)
    }
  }

  // ---- Provider 管理 ----

  /**
   * 注册一个 provider 并自动挂载计费追踪
   * @returns 注册后的 provider 实例
   */
  registerProvider(name: string, config: ProviderConfig): ModelProvider {
    const provider = _registerProvider(name, config)
    // 自动挂载计费追踪（OpenAI-compatible 有 latency tracker）
    if ('latency' in provider) {
      const tracker = new _TBT(name)
      ;(provider as unknown as { usage: _TBT }).usage = tracker
      this.monitor.attachTokenProvider(tracker)
    }
    return provider
  }

  /**
   * 注册 Copilot provider（订阅制计费）
   */
  registerCopilot(token: string, options?: { model?: string }): ModelProvider {
    const copilot = _createCopilot(token, options)
    this.monitor.attachSubscriptionProvider(copilot.usage)
    return copilot
  }

  /** 获取已注册的 provider（未注册则返回 undefined） */
  getProvider(name: string): ModelProvider | undefined {
    try { return _getProvider(name) } catch { return undefined }
  }

  /** 列出所有已注册 provider */
  listProviders(): { chat: string[]; image: string[] } {
    return _listProviders()
  }

  // ---- Agent 管理 ----

  /**
   * 创建 agent 并注册到 manager + runtime
   * 自动附带内置工具（可通过 config.tools 覆盖）
   */
  createAgent(config: AgentConfig & { builtinTools?: boolean }): Agent {
    const tools: Tool[] = config.tools ?? []
    if (config.builtinTools !== false && tools.length === 0) {
      tools.push(webFetchTool, bashTool, fileReadTool, fileWriteTool)
    }

    const agent = new Agent({ ...config, tools })
    this.manager.register(agent.id, agent.role, agent.getDepth())
    this.runtime.registerAgent(agent)

    // 自动路由：如未指定 provider/model，通过 router 分配
    if (!agent.provider || !agent.model) {
      const routing = this.router.route({
        taskType: 'general',
        difficulty: 'moderate',
        tags: config.tags,
      })
      if (routing.provider && !agent.provider) {
        agent.provider = routing.provider
      }
      if (routing.model && !agent.model) {
        agent.model = routing.model
      }
    }

    // 挂载全局事件
    if (this.globalEventHandler) {
      const handler = this.globalEventHandler
      agent.on(handler)
    }

    return agent
  }

  // ---- 执行 ----

  /**
   * 运行 agent 循环（带权限守卫）
   * 完成后 agent 回到 idle
   */
  async run(
    agent: Agent,
    message: string,
    options?: Partial<AgentLoopOptions>,
  ): Promise<AgentLoopResult> {
    const assessment = _assessDifficulty(message)
    agent.log(`难度评估: ${assessment.level} (${assessment.score}/100) — ${assessment.rationale}`)

    return this.runtime.runManual(agent, message, options?.context)
  }

  /**
   * 并行运行多个子 agent
   */
  async runParallel(
    parent: Agent,
    tasks: { name: string; systemPrompt: string; message: string; watchTags?: string[] }[],
  ): Promise<AgentLoopResult[]> {
    return this.runtime.runParallelChildren(
      parent,
      tasks.map((t) => ({
        config: { name: t.name, systemPrompt: t.systemPrompt, watchTags: t.watchTags },
        message: t.message,
      })),
    )
  }

  /**
   * 启动 agent 自主模式
   */
  startAutonomous(agent: Agent, initialMessage?: string): void {
    this.runtime.startAutonomous(agent, initialMessage)
  }

  /** 停止自主模式 */
  stopAutonomous(agentId: string): void {
    this.runtime.stopAutonomous(agentId)
  }

  /** 唤醒 idle agent */
  async wakeAgent(targetId: string, source: string, payload?: unknown): Promise<boolean> {
    return this.runtime.wakeAgent(targetId, source, payload)
  }

  /** 回收子 agent（压缩记忆后封存） */
  recycleAgent(parentId: string, childId: string): CompressedMemory | null {
    return this.runtime.recycleAgent(parentId, childId)
  }

  // ---- Plan Mode ----

  /** 创建计划快照 */
  createPlanSnapshot(): PlanSnapshot {
    return this.planMode.createSnapshot(this.manager.getGoalTree())
  }

  /** 获取计划差分 */
  getPlanDiff(snapshotId: string): PlanDiff | null {
    return this.planMode.computeDiff(snapshotId)
  }

  /** 应用计划差分到原树 — 需要实现为直接修改 manager 的目标树 */
  applyPlanDiff(snapshotId: string): PlanDiff | null {
    const diff = this.planMode.computeDiff(snapshotId)
    if (!diff) return null

    // 移除节点
    for (const nodeId of diff.removed) {
      // 从 manager 的目标树中移除
      const agentId = nodeId.replace('goal-', '')
      this.manager.unregister(agentId)
    }

    // 修改节点
    for (const mod of diff.modified) {
      const agentId = mod.nodeId.replace('goal-', '')
      if (mod.field === 'goal') {
        const goal = this.manager.getGoal(agentId)
        if (goal) goal.goal = mod.newValue as string
      }
      if (mod.field === 'status') {
        this.manager.updateGoalStatus(agentId, mod.newValue as import('./os/agent-manager.ts').GoalStatus)
      }
    }

    this.planMode.discardSnapshot(snapshotId)
    return diff
  }

  // ---- 报告 ----

  /** 获取统一计费报告 */
  getUsageReport(): UnifiedUsageReport {
    return this.monitor.getReport()
  }

  /** 打印可读计费报告 */
  printUsageReport(): string {
    return this.monitor.printReport()
  }

  /** 获取 agent manager 统计 */
  getManagerStats() {
    return this.manager.getStats()
  }

  /** 获取运行时状态 */
  getRuntimeStatus(): RuntimeStatus {
    return this.runtime.getStatus()
  }
}
