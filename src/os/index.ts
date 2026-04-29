/**
 * AgentOS — 顶层入口
 *
 * 管理 Agent 生命周期、ModelRouter、事件总线、信号系统、权限、Plan Mode
 */

export { Agent } from './agent.ts'
export type {
  AgentConfig,
  AgentRole,
  AgentStatus,
  AgentEvent,
  AgentEventHandler,
  TaskNotification,
  AgentHierarchyNode,
  CompressedMemory,
  AutoTrigger,
  AutonomousConfig,
} from './agent.ts'

export { runAgentLoop, runChildrenParallel } from './agent-loop.ts'
export type { AgentLoopOptions, AgentLoopResult } from './agent-loop.ts'

export { ModelRouter, inferTaskType, inferDifficulty, assessDifficulty } from './model-router.ts'
export type {
  TaskType,
  DifficultyLevel,
  DifficultyFactors,
  DifficultyAssessment,
  RoutingRule,
  RoutingRequest,
  RoutingResult,
} from './model-router.ts'

export { AgentManager, PlanMode } from './agent-manager.ts'
export type {
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
} from './agent-manager.ts'

export { SignalBus, createSignal } from './signal-bus.ts'
export type {
  SignalType,
  SignalPriority,
  SignalRouting,
  AgentSignal,
  SignalListener,
  SignalBusEvent,
  SignalBusStats,
} from './signal-bus.ts'

export { PermissionGuard } from './permission-guard.ts'
export type {
  RiskLevel,
  PermissionRequest,
  PermissionDecision,
} from './permission-guard.ts'

export { AgentRuntime } from './agent-runtime.ts'
export type {
  RuntimeEvent,
  RuntimeStatus,
} from './agent-runtime.ts'

export type { Tool, ToolResult, ToolContext, ToolInputSchema } from './tool.ts'
export { registerTool, getTool, getAllTools, getToolsByTag, toToolDefinitions } from './tool.ts'

export {
  webFetchTool,
  bashTool,
  fileReadTool,
  fileWriteTool,
  createSubAgentTool,
} from './tools/index.ts'
