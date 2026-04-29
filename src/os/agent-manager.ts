/**
 * AgentManager — 全局 Agent 管理器
 *
 * 三大职责：
 * 1. 注册表 — 全局 agent 树的索引
 * 2. 权限策略 — 工具白名单/黑名单 + 资源限制
 * 3. 目标树 — 维护项目进程目标树 + 目标传播机制
 *
 * 目标传播流程：
 * - 子 agent 发现问题无法解决 → 向上传播 (escalate)
 * - 父级评估修改子目标是否影响自身目标
 *   - 不影响 → 直接向下传播修改后的子目标
 *   - 影响 → 继续向上传播
 * - 传播到达决策层后，新目标向下传播，各级重新适配计划
 * - 鼓励复用原计划中有用且已实现的部分
 */

import type { AgentRole } from './agent.ts'

// ============================================================
//  GoalNode — 目标树节点
// ============================================================

export type GoalStatus =
  | 'pending'       // 待开始
  | 'active'        // 执行中
  | 'completed'     // 已完成
  | 'blocked'       // 被阻塞（等待上行传播结果）
  | 'suspended'     // 被冻结（兄弟节点出现高严重度问题时）
  | 'failed'        // 确认失败
  | 'revised'       // 目标已修改（经过传播后）
  | 'abandoned'     // 被放弃

export type PropagationDirection = 'up' | 'down' | 'none'

/** 计划步骤 */
export interface PlanStep {
  id: string
  description: string
  status: 'pending' | 'in-progress' | 'done' | 'skipped' | 'reused'
  /** 执行结果摘要 */
  result?: string
  /** 是否可在目标修改后复用 */
  reusable: boolean
}

/** 上行传播请求 — 子级向父级发起 */
export interface EscalationRequest {
  /** 发起 agent 的 ID */
  fromAgentId: string
  /** 对应的目标节点 ID */
  goalNodeId: string
  /** 问题描述 */
  reason: string
  /** 建议的修改后子目标（可选） */
  suggestedRevision?: string
  /** 是否建议放弃 */
  suggestAbandon: boolean
  /** 已完成的可复用步骤 */
  reusableSteps: PlanStep[]
  /** 时间戳 */
  timestamp: number
}

/** 下行传播指令 — 父级向子级发出 */
export interface PropagationDirective {
  /** 目标 agent ID */
  toAgentId: string
  /** 对应的目标节点 ID */
  goalNodeId: string
  /** 决策类型 */
  decision: 'revise' | 'abandon' | 'retry'
  /** 修改后的新目标（revise 时） */
  newGoal?: string
  /** 修改后的新计划（revise 时） */
  newPlan?: PlanStep[]
  /** 需要保留的原计划步骤 ID（鼓励复用） */
  retainStepIds?: string[]
  /** 原因说明 */
  reason: string
  /** 决策来源：ai = 自动，human = 人工 */
  decisionSource: 'ai' | 'human'
  /** 时间戳 */
  timestamp: number
}

// ============================================================
//  传播报告与人工决策类型
// ============================================================

/** 传播链中的单层记录 */
export interface EscalationLayer {
  /** 层级（0 = 原始节点，1 = 其父级，…） */
  level: number
  agentId: string
  goal: string
  /** 对其父级的影响评估 */
  impactOnParent?: ImpactAssessment
  /** 决策（若在此层消化） */
  decision?: 'revise' | 'abandon' | 'retry' | 'needs_human'
  decisionSource?: 'ai' | 'human' | 'pending'
}

/** AI 建议（呈现给人类决策者） */
export interface AISuggestion {
  recommendedDecision: 'revise' | 'abandon' | 'retry'
  suggestedNewGoal?: string
  rationale: string
  reusableSteps: PlanStep[]
  risks: string[]
}

/** 完整传播链报告（分层监控展示） */
export interface EscalationReport {
  id: string
  originAgentId: string
  reason: string
  chain: EscalationLayer[]
  resolvedAt?: string
  finalDecision?: 'revise' | 'abandon' | 'retry' | 'needs_human'
  aiSuggestion?: AISuggestion
  status: 'propagating' | 'ai_resolved' | 'pending_human' | 'human_resolved'
  createdAt: number
  updatedAt: number
}

/** 待人类决策的项目 */
export interface PendingHumanDecision {
  reportId: string
  agentId: string
  report: EscalationReport
  suggestion: AISuggestion
  pendingSince: number
}

/** 目标树节点 */
export interface GoalNode {
  /** 节点 ID（与 agent ID 关联） */
  id: string
  /** 关联的 agent ID */
  agentId: string
  /** 目标描述 */
  goal: string
  /** 原始目标（修改前） */
  originalGoal: string
  /** 当前状态 */
  status: GoalStatus
  /** 冻结前的状态（解冻后恢复） */
  statusBeforeSuspend?: GoalStatus
  /** 执行计划 */
  plan: PlanStep[]
  /** 子目标节点 */
  children: GoalNode[]
  /** 父节点 ID（null 表示根） */
  parentId: string | null
  /** 传播状态 */
  propagation: PropagationDirection
  /** 历史：所有收到的上行请求 */
  escalationHistory: EscalationRequest[]
  /** 历史：所有收到的下行指令 */
  directiveHistory: PropagationDirective[]
  /** 修订次数 */
  revisionCount: number
  /** 创建时间 */
  createdAt: number
  /** 最后更新时间 */
  updatedAt: number
}

// ============================================================
//  PermissionPolicy — 权限策略
// ============================================================

export interface RolePermission {
  allowedTools: string[] | '*'
  deniedTools: string[]
  maxTurns: number
  maxTokenBudget: number
  canCreateChild: boolean
}

export interface DepthRules {
  maxDepth: number
  maxChildrenPerAgent: number
  tokenBudgetDecay: number
  toolRestrictionsAtDepth: Record<number, string[]>
}

export interface PermissionPolicy {
  roleDefaults: Record<AgentRole, RolePermission>
  depthRules: DepthRules
  overrides: Map<string, Partial<RolePermission>>
}

// ============================================================
//  AgentManager
// ============================================================

let reportCounter = 0

export class AgentManager {
  private registry = new Map<string, { agentId: string; role: AgentRole; depth: number }>()
  private goalTree = new Map<string, GoalNode>()
  private rootGoals: GoalNode[] = []
  readonly policy: PermissionPolicy

  /**
   * 人工决策阈值：当传播到达深度 <= 此值的节点时，
   * 停止 AI 自动决策，挂起等待人类。
   * 0 = 只有 root 需要人类 | 1 = root 及其直接子节点
   */
  readonly humanDecisionDepth: number

  /** 待人类决策的队列 */
  readonly pendingHumanDecisions = new Map<string, PendingHumanDecision>()

  /** 所有传播链报告（监控用） */
  readonly escalationReports = new Map<string, EscalationReport>()

  private onEvent?: (event: ManagerEvent) => void

  constructor(options?: { policy?: Partial<PermissionPolicy>; humanDecisionDepth?: number }) {
    this.humanDecisionDepth = options?.humanDecisionDepth ?? 1
    this.policy = {
      roleDefaults: {
        coordinator: {
          allowedTools: '*',
          deniedTools: ['bash'], // coordinator 不直接执行命令
          maxTurns: 30,
          maxTokenBudget: 200_000,
          canCreateChild: true,
        },
        worker: {
          allowedTools: '*',
          deniedTools: ['sub_agent'], // worker 不能再创建子级
          maxTurns: 15,
          maxTokenBudget: 50_000,
          canCreateChild: false,
        },
        standalone: {
          allowedTools: '*',
          deniedTools: [],
          maxTurns: 20,
          maxTokenBudget: 100_000,
          canCreateChild: true,
        },
      },
      depthRules: {
        maxDepth: 4,
        maxChildrenPerAgent: 6,
        tokenBudgetDecay: 0.6,
        toolRestrictionsAtDepth: {
          3: ['bash', 'file_write'], // depth >= 3 移除写操作
          4: ['bash', 'file_write', 'web_fetch'], // depth >= 4 只读本地
        },
      },
      overrides: new Map(),
      ...options?.policy,
    }
  }

  /** 设置事件回调 */
  setEventHandler(handler: (event: ManagerEvent) => void): void {
    this.onEvent = handler
  }

  private emit(event: ManagerEvent): void {
    this.onEvent?.(event)
  }

  // ============================================================
  //  注册表
  // ============================================================

  register(agentId: string, role: AgentRole, depth: number): void {
    this.registry.set(agentId, { agentId, role, depth })
  }

  unregister(agentId: string): void {
    this.registry.delete(agentId)
    this.goalTree.delete(agentId)
  }

  getRegistered(agentId: string) {
    return this.registry.get(agentId)
  }

  getAllRegistered() {
    return [...this.registry.values()]
  }

  // ============================================================
  //  权限查询
  // ============================================================

  /** 获取 agent 的有效权限（角色 + 深度 + 实例覆盖 合并后） */
  getEffectivePermission(agentId: string, role: AgentRole, depth: number): RolePermission {
    const base = { ...this.policy.roleDefaults[role] }

    // 深度衰减 token 预算
    base.maxTokenBudget = Math.floor(
      base.maxTokenBudget * Math.pow(this.policy.depthRules.tokenBudgetDecay, depth),
    )

    // 深度限制工具
    for (const [d, tools] of Object.entries(this.policy.depthRules.toolRestrictionsAtDepth)) {
      if (depth >= Number(d)) {
        base.deniedTools = [...new Set([...base.deniedTools, ...tools])]
      }
    }

    // 深度超限 → 禁止创建子级
    if (depth >= this.policy.depthRules.maxDepth) {
      base.canCreateChild = false
    }

    // 实例覆盖
    const override = this.policy.overrides.get(agentId)
    if (override) {
      Object.assign(base, override)
    }

    return base
  }

  /** 过滤工具列表 */
  filterTools(tools: string[], agentId: string, role: AgentRole, depth: number): string[] {
    const perm = this.getEffectivePermission(agentId, role, depth)
    let allowed = tools
    if (perm.allowedTools !== '*') {
      allowed = tools.filter((t) => (perm.allowedTools as string[]).includes(t))
    }
    return allowed.filter((t) => !perm.deniedTools.includes(t))
  }

  /** 检查是否允许创建子级 */
  canCreateChild(agentId: string, role: AgentRole, depth: number): { allowed: boolean; reason?: string } {
    const perm = this.getEffectivePermission(agentId, role, depth)
    if (!perm.canCreateChild) {
      return { allowed: false, reason: `角色 ${role} 在深度 ${depth} 不允许创建子 Agent` }
    }
    // 检查子级数量上限
    const goal = this.goalTree.get(agentId)
    if (goal && goal.children.length >= this.policy.depthRules.maxChildrenPerAgent) {
      return { allowed: false, reason: `子 Agent 数量已达上限 (${this.policy.depthRules.maxChildrenPerAgent})` }
    }
    return { allowed: true }
  }

  // ============================================================
  //  目标树管理
  // ============================================================

  /** 创建目标节点并挂载到树上 */
  createGoal(
    agentId: string,
    goal: string,
    plan: PlanStep[],
    parentAgentId?: string,
  ): GoalNode {
    const node: GoalNode = {
      id: `goal-${agentId}`,
      agentId,
      goal,
      originalGoal: goal,
      status: 'pending',
      plan,
      children: [],
      parentId: parentAgentId ? `goal-${parentAgentId}` : null,
      propagation: 'none',
      escalationHistory: [],
      directiveHistory: [],
      revisionCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    this.goalTree.set(agentId, node)

    // 挂到父节点
    if (parentAgentId) {
      const parentGoal = this.goalTree.get(parentAgentId)
      if (parentGoal) {
        parentGoal.children.push(node)
      }
    } else {
      this.rootGoals.push(node)
    }

    this.emit({ type: 'goal_created', node })
    return node
  }

  /** 更新目标状态 */
  updateGoalStatus(agentId: string, status: GoalStatus): void {
    const node = this.goalTree.get(agentId)
    if (!node) return
    const oldStatus = node.status
    node.status = status
    node.updatedAt = Date.now()
    this.emit({ type: 'goal_status_changed', nodeId: node.id, from: oldStatus, to: status })
  }

  /** 标记计划步骤完成 */
  completeStep(agentId: string, stepId: string, result?: string): void {
    const node = this.goalTree.get(agentId)
    if (!node) return
    const step = node.plan.find((s) => s.id === stepId)
    if (step) {
      step.status = 'done'
      step.result = result
      step.reusable = true // 已完成的步骤默认可复用
      node.updatedAt = Date.now()
    }
  }

  /** 获取目标节点 */
  getGoal(agentId: string): GoalNode | undefined {
    return this.goalTree.get(agentId)
  }

  /** 获取完整目标树 */
  getGoalTree(): GoalNode[] {
    return this.rootGoals
  }

  // ============================================================
  //  目标传播机制
  // ============================================================

  /**
   * 上行传播（Escalate）
   *
   * 子 agent 发现问题无法解决时调用。
   * 流程：
   * 1. 标记当前节点为 blocked
   * 2. 收集可复用步骤
   * 3. 向父级发起 EscalationRequest
   * 4. 父级评估影响（assessImpact）
   * 5. 如果不影响父级 → 直接向下传播（propagateDown）
   * 6. 如果影响父级 → 继续向上传播
   * 7. 到达根节点仍无法消化 → 标记 abandoned
   */
  escalate(agentId: string, reason: string, suggestedRevision?: string): EscalationResult {
    const node = this.goalTree.get(agentId)
    if (!node) {
      return { handled: false, stoppedAt: agentId, finalDecision: 'error', reason: '目标节点不存在', reportId: '' }
    }

    node.status = 'blocked'
    node.propagation = 'up'
    node.updatedAt = Date.now()

    const reusableSteps = node.plan.filter((s) => s.status === 'done' && s.reusable)
    const request: EscalationRequest = {
      fromAgentId: agentId,
      goalNodeId: node.id,
      reason,
      suggestedRevision,
      suggestAbandon: !suggestedRevision,
      reusableSteps,
      timestamp: Date.now(),
    }
    node.escalationHistory.push(request)

    // 初始化分层报告
    const reportId = `report-${++reportCounter}-${agentId}`
    const report: EscalationReport = {
      id: reportId,
      originAgentId: agentId,
      reason,
      chain: [{ level: 0, agentId, goal: node.goal }],
      status: 'propagating',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.escalationReports.set(reportId, report)

    this.emit({ type: 'escalation_started', request, reportId })
    return this.propagateUp(node, request, report)
  }

  /**
   * 上行传播核心 — 逐级向上寻找能消化问题的祖先
   *
   * 新增：
   * - 分层报告收集（EscalationReport.chain）
   * - 兄弟节点条件冻结（severity 决定）
   * - 人工决策阈值检测（humanDecisionDepth）
   */
  private propagateUp(originNode: GoalNode, request: EscalationRequest, report: EscalationReport): EscalationResult {
    let currentNode = originNode
    let level = 0

    while (currentNode.parentId) {
      const parentNode = this.findGoalById(currentNode.parentId)
      if (!parentNode) break

      level++
      const impact = this.assessImpact(parentNode, currentNode, request)

      // 更新报告链
      report.chain[level - 1].impactOnParent = impact
      report.chain.push({ level, agentId: parentNode.agentId, goal: parentNode.goal })
      report.updatedAt = Date.now()

      this.emit({ type: 'impact_assessed', parentNodeId: parentNode.id, childNodeId: currentNode.id, impact, reportId: report.id })

      if (!impact.affectsParent) {
        // ✅ 不影响父目标 → AI 直接决策，向下传播
        const directive = this.makeDirective(parentNode, currentNode, request, impact, 'ai')

        report.chain[level].decision = directive.decision
        report.chain[level].decisionSource = 'ai'
        report.resolvedAt = parentNode.agentId
        report.finalDecision = directive.decision
        report.status = 'ai_resolved'
        report.updatedAt = Date.now()

        // 解冻父节点下已冻结的兄弟
        this.resumeSiblings(parentNode)

        this.propagateDown(currentNode, directive)
        this.emit({ type: 'escalation_resolved', reportId: report.id, report })

        return {
          handled: true,
          stoppedAt: parentNode.agentId,
          finalDecision: directive.decision,
          reason: impact.reason,
          directive,
          reportId: report.id,
        }
      }

      // ❌ 影响父目标 → 条件冻结兄弟节点，继续上传
      this.handleSiblingFreeze(currentNode, impact.severity)

      parentNode.status = 'blocked'
      parentNode.propagation = 'up'
      parentNode.escalationHistory.push(request)
      parentNode.updatedAt = Date.now()

      this.emit({ type: 'escalation_propagated', fromNodeId: currentNode.id, toNodeId: parentNode.id, reportId: report.id })

      // ── 检查是否到达人工决策阈值 ──
      const parentDepth = this.getNodeDepth(parentNode)
      if (parentDepth <= this.humanDecisionDepth) {
        return this.parkForHumanDecision(parentNode, currentNode, request, report, level, impact)
      }

      currentNode = parentNode
    }

    // 到达根节点（无父级）仍未消化
    return this.parkForHumanDecision(currentNode, currentNode, request, report, level, {
      affectsParent: true, severity: 'high',
      reason: '传播到达根节点，所有层级均受影响',
      suggestedAction: 'escalate',
    })
  }

  /** 挂起等待人类决策，创建 PendingHumanDecision 并 emit */
  private parkForHumanDecision(
    decisionNode: GoalNode,
    triggerChild: GoalNode,
    request: EscalationRequest,
    report: EscalationReport,
    level: number,
    impact: ImpactAssessment,
  ): EscalationResult {
    const suggestion = this.generateAISuggestion(decisionNode, triggerChild, request, impact)

    const pending: PendingHumanDecision = {
      reportId: report.id,
      agentId: decisionNode.agentId,
      report,
      suggestion,
      pendingSince: Date.now(),
    }
    this.pendingHumanDecisions.set(report.id, pending)

    const chainIdx = report.chain.findIndex((l) => l.agentId === decisionNode.agentId)
    if (chainIdx !== -1) {
      report.chain[chainIdx].decision = 'needs_human'
      report.chain[chainIdx].decisionSource = 'pending'
    }
    report.finalDecision = 'needs_human'
    report.aiSuggestion = suggestion
    report.status = 'pending_human'
    report.updatedAt = Date.now()

    this.emit({ type: 'needs_human_decision', pending, reportId: report.id })

    return {
      handled: false,
      stoppedAt: decisionNode.agentId,
      finalDecision: 'needs_human',
      reason: `已到达人工决策阈值 (depth=${this.getNodeDepth(decisionNode)})，等待人类决策`,
      reportId: report.id,
      pendingDecision: pending,
    }
  }

  // ============================================================
  //  兄弟节点冻结
  // ============================================================

  /**
   * 根据 severity 决定如何处理兄弟节点：
   * low    → 不干预，兄弟继续运行
   * medium → 软暂停（suspended），避免浪费，完成当前轮次后停
   * high   → 立即冻结，父目标可能根本改变
   */
  private handleSiblingFreeze(affectedNode: GoalNode, severity: ImpactAssessment['severity']): void {
    if (severity === 'low') return
    const parent = affectedNode.parentId ? this.findGoalById(affectedNode.parentId) : undefined
    if (!parent) return

    const activeSiblings = parent.children.filter(
      (c) => c.id !== affectedNode.id && (c.status === 'active' || c.status === 'revised'),
    )

    for (const sibling of activeSiblings) {
      sibling.statusBeforeSuspend = sibling.status
      sibling.status = 'suspended'
      sibling.updatedAt = Date.now()
      this.emit({
        type: 'sibling_suspended',
        siblingId: sibling.id,
        triggerAgentId: affectedNode.agentId,
        severity,
        reason: severity === 'medium'
          ? '软暂停：等待兄弟节点问题传播结果（低风险可继续当前轮次）'
          : '立即冻结：父级目标可能根本改变，继续运行等于浪费',
      })
    }
  }

  /** 解冻父节点下所有 suspended 的子节点 */
  private resumeSiblings(parentNode: GoalNode): void {
    for (const child of parentNode.children) {
      if (child.status === 'suspended') {
        child.status = child.statusBeforeSuspend ?? 'active'
        child.statusBeforeSuspend = undefined
        child.updatedAt = Date.now()
        this.emit({ type: 'sibling_resumed', siblingId: child.id })
      }
    }
  }

  // ============================================================
  //  AI 建议生成
  // ============================================================

  /** 生成 AI 建议（只呈现给人类，不自动执行） */
  private generateAISuggestion(
    parentNode: GoalNode,
    childNode: GoalNode,
    request: EscalationRequest,
    impact: ImpactAssessment,
  ): AISuggestion {
    const reusableSteps = request.reusableSteps
    if (request.suggestedRevision) {
      return {
        recommendedDecision: 'revise',
        suggestedNewGoal: request.suggestedRevision,
        rationale: `子级 "${childNode.goal}" 建议修改为 "${request.suggestedRevision}"，AI 评估影响为 ${impact.severity}`,
        reusableSteps,
        risks: impact.severity === 'high'
          ? ['修改后父级整体计划需要调整', '部分已完成工作可能失效']
          : ['修改范围局部，影响有限'],
      }
    }
    return {
      recommendedDecision: 'abandon',
      rationale: `子级 "${childNode.goal}" 无法完成，且 ${impact.reason}。建议放弃，由兄弟节点或父级调整方案弥补`,
      reusableSteps,
      risks: ['放弃可能导致父级目标需要重新规划', `可复用步骤 ${reusableSteps.length} 个`],
    }
  }

  // ============================================================
  //  人工决策接口
  // ============================================================

  /**
   * 人类提交决策
   *
   * @param reportId 对应 EscalationReport 的 ID（从 EscalationResult.reportId 获取）
   * @param decision 决策类型
   * @param newGoal  人类指定的新目标（revise 时）
   * @param newPlan  人类提供的新计划（可选，不提供则沿用原计划+复用步骤）
   */
  submitHumanDecision(
    reportId: string,
    decision: 'revise' | 'abandon' | 'retry',
    newGoal?: string,
    newPlan?: PlanStep[],
  ): void {
    const pending = this.pendingHumanDecisions.get(reportId)
    if (!pending) throw new Error(`找不到待决策项 "${reportId}"`)

    this.pendingHumanDecisions.delete(reportId)

    const report = pending.report
    report.finalDecision = decision
    report.status = 'human_resolved'
    report.updatedAt = Date.now()

    // 更新报告链
    for (const layer of report.chain) {
      if (layer.agentId === pending.agentId && layer.decisionSource === 'pending') {
        layer.decision = decision
        layer.decisionSource = 'human'
      }
    }

    const agentNode = this.goalTree.get(pending.agentId)
    if (!agentNode) return

    const reusableStepIds = pending.suggestion.reusableSteps.map((s) => s.id)
    const directive: PropagationDirective = {
      toAgentId: pending.agentId,
      goalNodeId: agentNode.id,
      decision,
      newGoal,
      newPlan,
      retainStepIds: reusableStepIds,
      reason: '人类决策',
      decisionSource: 'human',
      timestamp: Date.now(),
    }

    this.emit({ type: 'human_decision_submitted', reportId, decision, agentId: pending.agentId })

    // 向下传播：先处理决策节点本身，再级联其子节点
    this.propagateDown(agentNode, directive)
    this.cascadeDownAfterHumanDecision(agentNode, decision, newGoal)

    // 解冻该节点的兄弟（若有父节点）
    if (agentNode.parentId) {
      const parentNode = this.findGoalById(agentNode.parentId)
      if (parentNode) this.resumeSiblings(parentNode)
    }

    this.emit({ type: 'escalation_resolved', reportId, report })
  }

  /** 人类决策后级联向下解除所有 blocked/suspended 子节点 */
  private cascadeDownAfterHumanDecision(
    node: GoalNode,
    decision: 'revise' | 'abandon' | 'retry',
    parentNewGoal?: string,
  ): void {
    for (const child of node.children) {
      if (child.status === 'blocked' || child.status === 'suspended') {
        const childDirective: PropagationDirective = {
          toAgentId: child.agentId,
          goalNodeId: child.id,
          decision,
          newGoal: parentNewGoal ? `适配父目标修改: ${parentNewGoal}` : undefined,
          retainStepIds: child.plan.filter((s) => s.status === 'done').map((s) => s.id),
          reason: `来自上级 ${node.agentId} 的人工决策级联传播`,
          decisionSource: 'human',
          timestamp: Date.now(),
        }
        this.propagateDown(child, childDirective)
        this.resumeSiblings(node)
      }
      this.cascadeDownAfterHumanDecision(child, decision, parentNewGoal)
    }
  }

  /**
   * 评估影响 — 修改子目标是否影响父目标
   *
   * 默认实现：基于规则的简单评估。
   * 实际使用时可用 LLM 做更智能的评估。
   */
  assessImpact(
    parentNode: GoalNode,
    childNode: GoalNode,
    request: EscalationRequest,
  ): ImpactAssessment {
    // 如果子级建议了修改方案 → 大概率不影响（子级自己能消化）
    if (request.suggestedRevision && !request.suggestAbandon) {
      return {
        affectsParent: false,
        severity: 'low',
        reason: `子目标 "${childNode.goal}" 可修改为 "${request.suggestedRevision}"，不影响父目标`,
        suggestedAction: 'revise',
      }
    }

    // 如果子级建议放弃
    if (request.suggestAbandon) {
      // 检查父目标的其他子节点是否能弥补
      const siblings = parentNode.children.filter((c) => c.id !== childNode.id)
      const completedSiblings = siblings.filter((c) => c.status === 'completed')

      if (completedSiblings.length > 0 || siblings.length > 1) {
        // 有兄弟节点可能弥补 → 不影响
        return {
          affectsParent: false,
          severity: 'medium',
          reason: `子目标 "${childNode.goal}" 被放弃，但有 ${siblings.length} 个兄弟节点可能弥补`,
          suggestedAction: 'abandon',
        }
      }

      // 唯一子节点且要放弃 → 影响父目标
      return {
        affectsParent: true,
        severity: 'high',
        reason: `子目标 "${childNode.goal}" 是唯一子任务且无法完成，父目标 "${parentNode.goal}" 受影响`,
        suggestedAction: 'escalate',
      }
    }

    // 默认：需要上报
    return {
      affectsParent: true,
      severity: 'medium',
      reason: `无法确定子目标修改对父目标的影响，需上级决策`,
      suggestedAction: 'escalate',
    }
  }

  private makeDirective(
    parentNode: GoalNode,
    childNode: GoalNode,
    request: EscalationRequest,
    impact: ImpactAssessment,
    source: 'ai' | 'human',
  ): PropagationDirective {
    const retainStepIds = request.reusableSteps.map((s) => s.id)

    if (impact.suggestedAction === 'revise' && request.suggestedRevision) {
      return {
        toAgentId: childNode.agentId,
        goalNodeId: childNode.id,
        decision: 'revise',
        newGoal: request.suggestedRevision,
        retainStepIds,
        reason: `父级 "${parentNode.agentId}" 批准修改: ${impact.reason}`,
        decisionSource: source,
        timestamp: Date.now(),
      }
    }

    if (impact.suggestedAction === 'abandon') {
      return {
        toAgentId: childNode.agentId,
        goalNodeId: childNode.id,
        decision: 'abandon',
        reason: `父级 "${parentNode.agentId}" 批准放弃: ${impact.reason}`,
        decisionSource: source,
        timestamp: Date.now(),
      }
    }

    return {
      toAgentId: childNode.agentId,
      goalNodeId: childNode.id,
      decision: 'retry',
      retainStepIds,
      reason: `父级 "${parentNode.agentId}" 要求重试`,
      decisionSource: source,
      timestamp: Date.now(),
    }
  }

  /**
   * 下行传播（PropagateDown）
   *
   * 将决策结果向下传播，修改子目标 + 重新适配计划
   * 鼓励复用原计划中有用且已实现的部分
   */
  propagateDown(node: GoalNode, directive: PropagationDirective): void {
    node.directiveHistory.push(directive)
    node.propagation = 'down'
    node.updatedAt = Date.now()

    switch (directive.decision) {
      case 'revise': {
        // 修改目标
        node.goal = directive.newGoal ?? node.goal
        node.revisionCount++
        node.status = 'revised'

        // 重新适配计划 — 保留可复用步骤
        if (directive.newPlan) {
          node.plan = directive.newPlan
        } else if (directive.retainStepIds && directive.retainStepIds.length > 0) {
          // 标记保留的步骤为 reused，其余重置为 pending
          for (const step of node.plan) {
            if (directive.retainStepIds.includes(step.id)) {
              step.status = 'reused'
            } else if (step.status !== 'done') {
              step.status = 'pending'
            }
          }
        }

        this.emit({ type: 'goal_revised', nodeId: node.id, newGoal: node.goal, directive })
        break
      }

      case 'abandon': {
        node.status = 'abandoned'
        for (const child of node.children) {
          this.propagateDown(child, {
            toAgentId: child.agentId,
            goalNodeId: child.id,
            decision: 'abandon',
            reason: `父目标 "${node.goal}" 被放弃，级联放弃`,
            decisionSource: directive.decisionSource,
            timestamp: Date.now(),
          })
        }

        this.emit({ type: 'goal_abandoned', nodeId: node.id, directive })
        break
      }

      case 'retry': {
        node.status = 'active'
        // 保留已完成步骤，重置未完成步骤
        for (const step of node.plan) {
          if (step.status !== 'done') {
            step.status = 'pending'
          }
        }

        this.emit({ type: 'goal_retry', nodeId: node.id, directive })
        break
      }
    }

    node.propagation = 'none' // 传播完成
  }

  /** 已废弃，保留兼容：改用 submitHumanDecision */
  resolveEscalation(
    agentId: string,
    decision: 'revise' | 'abandon' | 'retry',
    newGoal?: string,
    newPlan?: PlanStep[],
  ): void {
    const node = this.goalTree.get(agentId)
    if (!node || node.status !== 'blocked') return

    const directive: PropagationDirective = {
      toAgentId: agentId,
      goalNodeId: node.id,
      decision,
      newGoal,
      newPlan,
      reason: '人工决策（兼容接口）',
      decisionSource: 'human',
      timestamp: Date.now(),
    }

    this.propagateDown(node, directive)

    for (const child of node.children) {
      if (child.status === 'blocked' || child.status === 'suspended') {
        this.propagateDown(child, {
          toAgentId: child.agentId,
          goalNodeId: child.id,
          decision,
          newGoal: newGoal ? `适配父目标修改: ${newGoal}` : undefined,
          reason: `来自上级 ${agentId} 的传播`,
          decisionSource: 'human',
          timestamp: Date.now(),
        })
      }
    }
  }

  // ============================================================
  //  辅助方法
  // ============================================================

  private findGoalById(goalId: string): GoalNode | undefined {
    for (const node of this.goalTree.values()) {
      if (node.id === goalId) return node
    }
    return undefined
  }

  /** 计算节点深度（0 = 根节点） */
  private getNodeDepth(node: GoalNode): number {
    let depth = 0
    let current = node
    while (current.parentId) {
      const parent = this.findGoalById(current.parentId)
      if (!parent) break
      depth++
      current = parent
    }
    return depth
  }

  /** 打印目标树（分层监控视图） */
  printGoalTree(nodes?: GoalNode[], indent = 0): string {
    const targets = nodes ?? this.rootGoals
    let output = ''
    for (const node of targets) {
      const prefix = '  '.repeat(indent)
      const icon: Record<GoalStatus, string> = {
        pending: '○', active: '●', completed: '✓', blocked: '⊘',
        suspended: '⏸', failed: '✗', revised: '↻', abandoned: '⊗',
      }

      const planProgress = node.plan.length
        ? ` [${node.plan.filter((s) => s.status === 'done' || s.status === 'reused').length}/${node.plan.length}]`
        : ''

      output += `${prefix}${icon[node.status]} ${node.agentId}: ${node.goal}${planProgress}`
      if (node.revisionCount > 0) output += ` (修订${node.revisionCount}次)`
      if (node.status === 'suspended') output += ' ⟵ 已冻结'
      if (node.originalGoal !== node.goal) output += `\n${prefix}  原目标: ${node.originalGoal}`
      output += '\n'

      if (node.children.length > 0) {
        output += this.printGoalTree(node.children, indent + 1)
      }
    }
    return output
  }

  /** 打印传播链报告（分层监控展示） */
  printEscalationReport(reportId: string): string {
    const report = this.escalationReports.get(reportId)
    if (!report) return `报告 ${reportId} 不存在`

    const statusLabel = {
      propagating: '传播中',
      ai_resolved: 'AI已决策',
      pending_human: '等待人工决策',
      human_resolved: '人工决策完成',
    }[report.status]

    let out = `\n${'='.repeat(60)}\n`
    out += `传播报告 ${report.id}\n`
    out += `状态: ${statusLabel}\n`
    out += `原始问题: ${report.reason}\n`
    out += `${'-'.repeat(60)}\n`
    out += `传播链（从下到上）:\n\n`

    for (const layer of report.chain) {
      const indent = '  '.repeat(layer.level)
      out += `${indent}层级 ${layer.level}${layer.level === 0 ? ' [问题起源]' : ''}\n`
      out += `${indent}  Agent: ${layer.agentId}\n`
      out += `${indent}  目标: ${layer.goal}\n`
      if (layer.impactOnParent) {
        const imp = layer.impactOnParent
        out += `${indent}  ↑ 对父级影响: ${imp.affectsParent ? `有影响 (${imp.severity})` : `无影响 (${imp.severity})`}\n`
        out += `${indent}    原因: ${imp.reason}\n`
      }
      if (layer.decision) {
        const src = layer.decisionSource === 'ai' ? '[AI自动]' : layer.decisionSource === 'human' ? '[人工]' : '[待决策]'
        out += `${indent}  ❆ 决策: ${layer.decision} ${src}\n`
      }
      out += '\n'
    }

    if (report.aiSuggestion) {
      const s = report.aiSuggestion
      out += `${'-'.repeat(60)}\n`
      out += `AI 建议（供人类参考）:\n`
      out += `  推荐决策: ${s.recommendedDecision}\n`
      if (s.suggestedNewGoal) out += `  建议新目标: ${s.suggestedNewGoal}\n`
      out += `  理由: ${s.rationale}\n`
      out += `  可复用步骤: ${s.reusableSteps.map((s) => s.id).join(', ') || '无'}\n`
      out += `  风险: ${s.risks.join(' / ')}\n`
    }

    out += `${'='.repeat(60)}\n`
    return out
  }

  /** 获取所有待人类决策的摘要列表 */
  getPendingDecisionsSummary(): { reportId: string; agentId: string; reason: string; pendingSince: number }[] {
    return [...this.pendingHumanDecisions.values()].map((p) => ({
      reportId: p.reportId,
      agentId: p.agentId,
      reason: p.report.reason,
      pendingSince: p.pendingSince,
    }))
  }

  /** 全局统计 */
  getStats(): ManagerStats {
    const all = [...this.goalTree.values()]
    return {
      totalAgents: this.registry.size,
      totalGoals: all.length,
      activeGoals: all.filter((n) => n.status === 'active').length,
      blockedGoals: all.filter((n) => n.status === 'blocked').length,
      suspendedGoals: all.filter((n) => n.status === 'suspended').length,
      completedGoals: all.filter((n) => n.status === 'completed').length,
      revisedGoals: all.filter((n) => n.revisionCount > 0).length,
      abandonedGoals: all.filter((n) => n.status === 'abandoned').length,
      totalRevisions: all.reduce((sum, n) => sum + n.revisionCount, 0),
      pendingHumanDecisions: this.pendingHumanDecisions.size,
    }
  }
}

// ============================================================
//  辅助类型
// ============================================================

export interface ImpactAssessment {
  affectsParent: boolean
  severity: 'low' | 'medium' | 'high'
  reason: string
  suggestedAction: 'revise' | 'abandon' | 'escalate' | 'retry'
}

export interface EscalationResult {
  handled: boolean
  stoppedAt: string
  finalDecision: 'revise' | 'abandon' | 'retry' | 'needs_human' | 'error'
  reason: string
  reportId: string
  directive?: PropagationDirective
  pendingDecision?: PendingHumanDecision
}

export interface ManagerStats {
  totalAgents: number
  totalGoals: number
  activeGoals: number
  blockedGoals: number
  suspendedGoals: number
  completedGoals: number
  revisedGoals: number
  abandonedGoals: number
  totalRevisions: number
  pendingHumanDecisions: number
}

export type ManagerEvent =
  | { type: 'goal_created'; node: GoalNode }
  | { type: 'goal_status_changed'; nodeId: string; from: GoalStatus; to: GoalStatus }
  | { type: 'goal_revised'; nodeId: string; newGoal: string; directive: PropagationDirective }
  | { type: 'goal_abandoned'; nodeId: string; directive: PropagationDirective }
  | { type: 'goal_retry'; nodeId: string; directive: PropagationDirective }
  | { type: 'escalation_started'; request: EscalationRequest; reportId: string }
  | { type: 'escalation_propagated'; fromNodeId: string; toNodeId: string; reportId: string }
  | { type: 'escalation_reached_root'; nodeId: string; request: EscalationRequest; reportId: string }
  | { type: 'escalation_resolved'; reportId: string; report: EscalationReport }
  | { type: 'impact_assessed'; parentNodeId: string; childNodeId: string; impact: ImpactAssessment; reportId: string }
  | { type: 'needs_human_decision'; pending: PendingHumanDecision; reportId: string }
  | { type: 'human_decision_submitted'; reportId: string; decision: string; agentId: string }
  | { type: 'sibling_suspended'; siblingId: string; triggerAgentId: string; severity: string; reason: string }
  | { type: 'sibling_resumed'; siblingId: string }
  | { type: 'plan_snapshot_created'; snapshotId: string }
  | { type: 'plan_diff_applied'; snapshotId: string; diff: PlanDiff }

// ============================================================
//  Plan Mode — 计划快照与差分编辑
// ============================================================

/**
 * Plan Mode 工作流：
 * 1. snapshotPlan() — 复制当前目标树为可编辑副本
 * 2. 在副本上进行编辑（addDraftGoal / editDraftGoal / removeDraftGoal）
 * 3. computePlanDiff() — 计算副本与原树的差分
 * 4. applyPlanDiff() — 将差分应用到原树
 * 5. discardSnapshot() — 放弃编辑
 */

/** 计划快照 */
export interface PlanSnapshot {
  /** 快照 ID */
  id: string
  /** 原始目标树的深拷贝 */
  originalTree: GoalNode[]
  /** 可编辑的草稿树 */
  draftTree: GoalNode[]
  /** 创建时间 */
  createdAt: number
}

/** 计划差分 */
export interface PlanDiff {
  /** 新增的目标节点 */
  added: PlanDiffEntry[]
  /** 移除的目标节点 ID */
  removed: string[]
  /** 修改的字段 */
  modified: PlanDiffModification[]
}

export interface PlanDiffEntry {
  node: GoalNode
  parentId: string | null
}

export interface PlanDiffModification {
  nodeId: string
  field: string
  oldValue: unknown
  newValue: unknown
}

let snapshotCounter = 0

/** Plan Mode 管理器 — 作为 AgentManager 的扩展方法集 */
export class PlanMode {
  private snapshots = new Map<string, PlanSnapshot>()

  /** 创建计划快照 — 深拷贝当前目标树 */
  createSnapshot(goalTree: GoalNode[]): PlanSnapshot {
    const id = `plan-snap-${++snapshotCounter}-${Date.now()}`
    const snapshot: PlanSnapshot = {
      id,
      originalTree: deepCloneGoalTree(goalTree),
      draftTree: deepCloneGoalTree(goalTree),
      createdAt: Date.now(),
    }
    this.snapshots.set(id, snapshot)
    return snapshot
  }

  /** 获取快照 */
  getSnapshot(id: string): PlanSnapshot | undefined {
    return this.snapshots.get(id)
  }

  /** 获取所有快照 */
  listSnapshots(): PlanSnapshot[] {
    return [...this.snapshots.values()]
  }

  /** 在草稿树上添加目标节点 */
  addDraftGoal(snapshotId: string, goal: GoalNode, parentNodeId?: string): boolean {
    const snap = this.snapshots.get(snapshotId)
    if (!snap) return false

    if (parentNodeId) {
      const parent = findGoalInTree(snap.draftTree, parentNodeId)
      if (!parent) return false
      goal.parentId = parent.id
      parent.children.push(goal)
    } else {
      goal.parentId = null
      snap.draftTree.push(goal)
    }
    return true
  }

  /** 在草稿树上编辑目标节点 */
  editDraftGoal(
    snapshotId: string,
    nodeId: string,
    updates: { goal?: string; status?: GoalStatus; plan?: PlanStep[] },
  ): boolean {
    const snap = this.snapshots.get(snapshotId)
    if (!snap) return false

    const node = findGoalInTree(snap.draftTree, nodeId)
    if (!node) return false

    if (updates.goal !== undefined) node.goal = updates.goal
    if (updates.status !== undefined) node.status = updates.status
    if (updates.plan !== undefined) node.plan = updates.plan
    node.updatedAt = Date.now()
    return true
  }

  /** 在草稿树上移除目标节点 */
  removeDraftGoal(snapshotId: string, nodeId: string): boolean {
    const snap = this.snapshots.get(snapshotId)
    if (!snap) return false
    return removeGoalFromTree(snap.draftTree, nodeId)
  }

  /** 计算草稿与原始树的差分 */
  computeDiff(snapshotId: string): PlanDiff | null {
    const snap = this.snapshots.get(snapshotId)
    if (!snap) return null

    const diff: PlanDiff = { added: [], removed: [], modified: [] }

    // 收集所有节点 ID
    const originalIds = collectNodeIds(snap.originalTree)
    const draftIds = collectNodeIds(snap.draftTree)

    // 新增节点
    for (const id of draftIds) {
      if (!originalIds.has(id)) {
        const node = findGoalInTree(snap.draftTree, id)
        if (node) {
          diff.added.push({ node, parentId: node.parentId })
        }
      }
    }

    // 移除节点
    for (const id of originalIds) {
      if (!draftIds.has(id)) {
        diff.removed.push(id)
      }
    }

    // 修改的节点
    for (const id of originalIds) {
      if (!draftIds.has(id)) continue
      const orig = findGoalInTree(snap.originalTree, id)
      const draft = findGoalInTree(snap.draftTree, id)
      if (!orig || !draft) continue

      if (orig.goal !== draft.goal) {
        diff.modified.push({ nodeId: id, field: 'goal', oldValue: orig.goal, newValue: draft.goal })
      }
      if (orig.status !== draft.status) {
        diff.modified.push({ nodeId: id, field: 'status', oldValue: orig.status, newValue: draft.status })
      }
      if (JSON.stringify(orig.plan) !== JSON.stringify(draft.plan)) {
        diff.modified.push({ nodeId: id, field: 'plan', oldValue: orig.plan, newValue: draft.plan })
      }
    }

    return diff
  }

  /** 丢弃快照 */
  discardSnapshot(snapshotId: string): boolean {
    return this.snapshots.delete(snapshotId)
  }

  /** 打印差分报告 */
  printDiff(diff: PlanDiff): string {
    let out = '=== Plan Diff ===\n'
    if (diff.added.length > 0) {
      out += `\n+ 新增 (${diff.added.length}):\n`
      for (const a of diff.added) {
        out += `  + [${a.node.id}] ${a.node.goal}${a.parentId ? ` (父: ${a.parentId})` : ' (根)'}\n`
      }
    }
    if (diff.removed.length > 0) {
      out += `\n- 移除 (${diff.removed.length}):\n`
      for (const r of diff.removed) {
        out += `  - ${r}\n`
      }
    }
    if (diff.modified.length > 0) {
      out += `\n~ 修改 (${diff.modified.length}):\n`
      for (const m of diff.modified) {
        out += `  ~ [${m.nodeId}].${m.field}: ${JSON.stringify(m.oldValue).slice(0, 80)} → ${JSON.stringify(m.newValue).slice(0, 80)}\n`
      }
    }
    if (diff.added.length === 0 && diff.removed.length === 0 && diff.modified.length === 0) {
      out += '\n(无变更)\n'
    }
    return out
  }
}

// ---- 目标树辅助函数 ----

function deepCloneGoalTree(tree: GoalNode[]): GoalNode[] {
  return tree.map((node) => deepCloneGoalNode(node))
}

function deepCloneGoalNode(node: GoalNode): GoalNode {
  return {
    ...node,
    plan: node.plan.map((s) => ({ ...s })),
    children: node.children.map((c) => deepCloneGoalNode(c)),
    escalationHistory: node.escalationHistory.map((e) => ({ ...e, reusableSteps: e.reusableSteps.map((s) => ({ ...s })) })),
    directiveHistory: node.directiveHistory.map((d) => ({ ...d })),
  }
}

function findGoalInTree(tree: GoalNode[], nodeId: string): GoalNode | undefined {
  for (const node of tree) {
    if (node.id === nodeId) return node
    const found = findGoalInTree(node.children, nodeId)
    if (found) return found
  }
  return undefined
}

function removeGoalFromTree(tree: GoalNode[], nodeId: string): boolean {
  for (let i = 0; i < tree.length; i++) {
    if (tree[i].id === nodeId) {
      tree.splice(i, 1)
      return true
    }
    if (removeGoalFromTree(tree[i].children, nodeId)) return true
  }
  return false
}

function collectNodeIds(tree: GoalNode[]): Set<string> {
  const ids = new Set<string>()
  for (const node of tree) {
    ids.add(node.id)
    for (const id of collectNodeIds(node.children)) ids.add(id)
  }
  return ids
}
