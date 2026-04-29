/**
 * AgentManager v2 测试
 *
 * 验证三大新能力：
 * 1. 分层传播报告（EscalationReport + printEscalationReport）
 * 2. 人工决策阈值（humanDecisionDepth=1：到达 depth≤1 层停止 AI 自决，挂起等人类）
 * 3. 兄弟节点条件冻结（severity=medium/high → 兄弟 suspended）
 *
 * 树结构：
 *   root (depth=0)
 *   ├── agent-a  (depth=1)  ← 支付系统
 *   │   ├── agent-a1 (depth=2)  ← 支付宝
 *   │   └── agent-a2 (depth=2)  ← PayPal
 *   └── agent-b  (depth=1)  ← 用户系统（活跃，可能被冻结）
 */

import { AgentManager } from './os/agent-manager.ts'
import type { PlanStep, ManagerEvent } from './os/agent-manager.ts'

function main() {
  console.log('=== AgentManager v2 测试 ===\n')

  // ---- 1. 创建 Manager（humanDecisionDepth=1）----
  const manager = new AgentManager({ humanDecisionDepth: 1 })

  manager.setEventHandler((event: ManagerEvent) => {
    console.log(`  [EVENT] ${formatEvent(event)}`)
  })

  console.log(`✓ Manager 创建完成（人工决策阈值 depth ≤ ${manager.humanDecisionDepth}）\n`)

  // ---- 2. 注册 + 构建目标树 ----
  console.log('--- 构建目标树 ---')

  manager.register('root',     'coordinator', 0)
  manager.register('agent-a',  'coordinator', 1)
  manager.register('agent-a1', 'worker',      2)
  manager.register('agent-a2', 'worker',      2)
  manager.register('agent-b',  'worker',      1)

  const rootPlan: PlanStep[] = [
    { id: 'r1', description: '需求分析',   status: 'done',        reusable: true  },
    { id: 'r2', description: '架构设计',   status: 'done',        reusable: true  },
    { id: 'r3', description: '模块实现',   status: 'in-progress', reusable: false },
    { id: 'r4', description: '集成测试',   status: 'pending',     reusable: false },
  ]
  manager.createGoal('root', '构建电商网站', rootPlan)

  manager.createGoal('agent-a', '实现支付系统', [
    { id: 'a1', description: '支付接口设计', status: 'done',        reusable: true  },
    { id: 'a2', description: '接入支付渠道', status: 'in-progress', reusable: false },
    { id: 'a3', description: '支付测试',     status: 'pending',     reusable: false },
  ], 'root')

  manager.createGoal('agent-a1', '接入支付宝', [
    { id: 'a1-1', description: '注册支付宝开发者',   status: 'done',        reusable: true, result: '已注册' },
    { id: 'a1-2', description: '实现支付宝 SDK',    status: 'in-progress', reusable: false },
    { id: 'a1-3', description: '测试沙箱支付',      status: 'pending',     reusable: false },
  ], 'agent-a')

  manager.createGoal('agent-a2', '接入 PayPal', [
    { id: 'a2-1', description: '研究 PayPal API',   status: 'done', reusable: true, result: 'API 文档已读' },
    { id: 'a2-2', description: '注册 PayPal 开发者', status: 'done', reusable: true, result: '已注册' },
    { id: 'a2-3', description: '实现 PayPal 集成',  status: 'in-progress', reusable: false },
  ], 'agent-a')

  manager.createGoal('agent-b', '实现用户系统', [
    { id: 'b1', description: '用户注册/登录',  status: 'done',        reusable: true  },
    { id: 'b2', description: '用户权限管理',   status: 'in-progress', reusable: false },
  ], 'root')

  // 设置活跃状态
  for (const id of ['root', 'agent-a', 'agent-a1', 'agent-a2', 'agent-b']) {
    manager.updateGoalStatus(id, 'active')
  }

  console.log('\n初始目标树:')
  console.log(manager.printGoalTree())

  // ================================================================
  // 场景一：Agent-A2 发现 PayPal 不可用，自己有替代方案
  //   → assessImpact: suggestedRevision → affectsParent=false → AI 直接决策
  //   → 不冻结兄弟（severity=low），不需要人工
  // ================================================================
  console.log('━'.repeat(60))
  console.log('场景一: Agent-A2 上行传播（有建议修改 → AI 直接决策）')
  console.log('━'.repeat(60))

  const r1 = manager.escalate(
    'agent-a2',
    'PayPal 在中国大陆地区不可用，无法完成支付接入',
    '接入微信支付（替代 PayPal）',
  )

  console.log(`\n传播结果:`)
  console.log(`  处理方: ${r1.stoppedAt}`)
  console.log(`  决策:   ${r1.finalDecision} (${r1.handled ? 'AI自动' : '人工'})`)
  console.log(`  报告ID: ${r1.reportId}`)

  // 打印分层报告
  console.log(manager.printEscalationReport(r1.reportId))

  const a2 = manager.getGoal('agent-a2')!
  console.log(`Agent-A2 新目标: ${a2.goal}（修订${a2.revisionCount}次）`)
  console.log(`Agent-B 状态: ${manager.getGoal('agent-b')!.status}（场景一 severity=low，应未被冻结）\n`)

  // ================================================================
  // 场景二：Agent-A1 也失败（唯一子路线）→ 影响父目标 agent-a
  //   → agent-a depth=1 ≤ humanDecisionDepth=1 → 停止！挂起等人类
  //   → severity=high → agent-b 被冻结（兄弟）
  // ================================================================
  console.log('━'.repeat(60))
  console.log('场景二: Agent-A1 上行传播（唯一子路线失败 → 触发人工决策 + 兄弟冻结）')
  console.log('━'.repeat(60))

  const r2 = manager.escalate(
    'agent-a1',
    '支付宝开放平台审核未通过，短期内无法接入',
    // 无建议 → suggestAbandon=true，是唯一子节点 → severity=high
  )

  console.log(`\n传播结果:`)
  console.log(`  处理方: ${r2.stoppedAt}`)
  console.log(`  决策:   ${r2.finalDecision}`)
  console.log(`  报告ID: ${r2.reportId}`)

  if (r2.pendingDecision) {
    console.log(`\n⚠ 挂起等待人类决策！`)
    console.log(`  AI 建议: ${r2.pendingDecision.suggestion.recommendedDecision}`)
    console.log(`  理由: ${r2.pendingDecision.suggestion.rationale}`)
    console.log(`  风险: ${r2.pendingDecision.suggestion.risks.join(' / ')}`)
  }

  // 打印分层报告（分层展示传播链）
  console.log(manager.printEscalationReport(r2.reportId))

  // 查看待决策列表
  const pending = manager.getPendingDecisionsSummary()
  console.log(`待人类决策队列（${pending.length} 项）:`)
  for (const p of pending) {
    console.log(`  ${p.reportId} | agent=${p.agentId} | ${p.reason}`)
  }

  console.log('\n冻结后目标树:')
  console.log(manager.printGoalTree())

  // ================================================================
  // 人类决策: 提交 submitHumanDecision
  //   → 用新接口（传 reportId），兄弟节点自动解冻
  // ================================================================
  console.log('━'.repeat(60))
  console.log('人类决策: 修改 agent-a 目标为"接入聚合支付"')
  console.log('━'.repeat(60))

  manager.submitHumanDecision(
    r2.reportId,
    'revise',
    '接入第三方聚合支付（含微信支付+支付宝）',
  )

  console.log('\n决策后目标树（兄弟节点应已解冻）:')
  console.log(manager.printGoalTree())

  // ================================================================
  // 权限测试（复用旧场景验证 decay）
  // ================================================================
  console.log('━'.repeat(60))
  console.log('权限测试')
  console.log('━'.repeat(60))

  const permW2 = manager.getEffectivePermission('agent-a1', 'worker', 2)
  console.log('Worker depth=2:')
  console.log(`  Token 预算: ${permW2.maxTokenBudget.toLocaleString()}`)
  console.log(`  禁用工具: ${permW2.deniedTools.join(', ')}`)

  const permW4 = manager.getEffectivePermission('deep-agent', 'worker', 4)
  console.log('Worker depth=4:')
  console.log(`  Token 预算: ${permW4.maxTokenBudget.toLocaleString()}`)
  console.log(`  禁用工具: ${permW4.deniedTools.join(', ')}`)
  console.log(`  可创建子级: ${permW4.canCreateChild}`)

  const tools = ['bash', 'file_read', 'file_write', 'web_fetch', 'sub_agent']
  const filtered = manager.filterTools(tools, 'deep-agent', 'worker', 4)
  console.log(`  过滤后工具: [${filtered.join(', ')}]`)

  // ================================================================
  // 统计
  // ================================================================
  console.log('\n--- 全局统计 ---')
  const stats = manager.getStats()
  for (const [k, v] of Object.entries(stats)) {
    console.log(`  ${k}: ${v}`)
  }

  console.log('\n=== 所有测试完成 ===')
}

function formatEvent(event: ManagerEvent): string {
  switch (event.type) {
    case 'goal_created':        return `目标创建: ${event.node.agentId} → "${event.node.goal}"`
    case 'goal_status_changed': return `状态变更: ${event.nodeId} ${event.from}→${event.to}`
    case 'goal_revised':        return `目标修订: ${event.nodeId} → "${event.newGoal}" [${event.directive.decisionSource}]`
    case 'goal_abandoned':      return `目标放弃: ${event.nodeId}`
    case 'goal_retry':          return `目标重试: ${event.nodeId}`
    case 'escalation_started':  return `上行传播开始: ${event.request.fromAgentId}`
    case 'escalation_propagated': return `传播继续: ${event.fromNodeId} → ${event.toNodeId}`
    case 'escalation_reached_root': return `传播到达根节点: ${event.nodeId}`
    case 'escalation_resolved': return `传播已解决: report=${event.reportId} status=${event.report.status}`
    case 'impact_assessed':     return `影响评估: 影响=${event.impact.affectsParent} (${event.impact.severity})`
    case 'needs_human_decision': return `⚠ 需要人工决策: report=${event.reportId} agent=${event.pending.agentId}`
    case 'human_decision_submitted': return `✓ 人工决策提交: ${event.decision} for ${event.agentId}`
    case 'sibling_suspended':   return `⏸ 兄弟冻结: ${event.siblingId} (severity=${event.severity})`
    case 'sibling_resumed':     return `▶ 兄弟解冻: ${event.siblingId}`
    default:                    return (event as ManagerEvent).type
  }
}

main()
