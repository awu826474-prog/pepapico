/**
 * TUI 入口 — 连接 ByteOS 后端与 React Ink TUI 前端
 *
 * 启动: npm run tui
 */

import { ByteOS } from './index.ts'
import { ByteTUI } from './tui.ts'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

async function main() {
  // ---- 初始化 ByteOS ----
  const tui = new ByteTUI()

  const os = new ByteOS({
    onEvent: (event) => {
      if (event.type === 'progress') {
        tui.updateStreamBuffer(event.content)
      } else if (event.type === 'log') {
        tui.notify(event.message)
      } else if (event.type === 'status_change') {
        tui.notify(`Agent ${event.agentId}: ${event.from} → ${event.to}`)
      }
    },
    onPermissionRequest: (request) => {
      tui.pushPermissionRequest(request)
      tui.notify(`⚠ 权限确认: ${request.description}`)
    },
  })

  // ---- 自动检测 Copilot token ----
  const tokenPath = join(process.cwd(), '.copilot-token')
  let defaultAgent: import('./os/agent.ts').Agent | null = null

  if (existsSync(tokenPath)) {
    try {
      const token = readFileSync(tokenPath, 'utf-8').trim()
      const copilot = os.registerCopilot(token)
      defaultAgent = os.createAgent({
        name: 'byte',
        role: 'coordinator',
        systemPrompt: '你是 Byte OS 的核心 Agent。你可以协调子 agent、使用工具完成任务。请用中文回答。',
        provider: copilot,
        model: 'claude-sonnet-4-20250514',
        watchTags: ['agent:wake', 'fs:watch', 'process:monitor'],
        autonomous: {
          enabled: false, // 默认关闭自主模式
          triggers: [{ type: 'signal', tags: ['agent:wake'] }],
          maxAutoRuns: 10,
          autoApproveTools: ['file_read', 'web_fetch'],
        },
      })
      tui.setCurrentAgent(defaultAgent.id)
      tui.notify('✓ Copilot 已连接，默认 Agent 已创建')
    } catch (err) {
      tui.notify(`Copilot 连接失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  } else {
    tui.notify('未检测到 .copilot-token，请使用 /provider copilot 添加')
  }

  // ---- 权限决策回调 ----
  tui.onPermission = (requestId, decision) => {
    os.permissionGuard.resolve(requestId, decision)
    tui.notify(`权限决策: ${decision.action}`)
  }

  // ---- 聊天回调 ----
  tui.onChat = async (message) => {
    if (!defaultAgent) {
      tui.addMessage('system', '无可用 Agent，请先通过 /provider 添加 Provider 并 /agent create 创建 Agent')
      return null
    }

    try {
      const result = await os.run(defaultAgent, message)
      // 更新 agent 树
      tui.updateAgentTree([defaultAgent.getHierarchy()])
      tui.updateRuntimeStatus(os.getRuntimeStatus())
      return result
    } catch (err) {
      tui.addMessage('system', `错误: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  // ---- 命令回调 ----
  tui.onCommand = async (cmd, args) => {
    switch (cmd) {
      // ---- Agent 命令 ----
      case 'agent': {
        const sub = args[0]
        if (sub === 'tree' && defaultAgent) {
          tui.updateAgentTree([defaultAgent.getHierarchy()])
          tui.setViewMode('agents')
          return null
        }
        if (sub === 'create' && defaultAgent) {
          const name = args[1] ?? `worker-${Date.now()}`
          const child = defaultAgent.createChild({
            name,
            role: 'worker',
            systemPrompt: `你是 ${name}，一个工作节点 Agent。`,
            provider: defaultAgent.provider,
            model: defaultAgent.model,
            watchTags: args.slice(2),
          })
          os.runtime.registerAgent(child)
          os.manager.register(child.id, child.role, child.getDepth())
          tui.updateAgentTree([defaultAgent.getHierarchy()])
          return `已创建子 Agent: ${child.id} (${child.name}), watchTags: [${[...child.watchTags].join(', ')}]`
        }
        if (sub === 'wake' && args[1]) {
          const ok = await os.wakeAgent(args[1], 'user', args.slice(2).join(' ') || 'manual wake')
          return ok ? `已唤醒 ${args[1]}` : `唤醒失败: ${args[1]} 未注册或不在 idle`
        }
        if (sub === 'auto' && defaultAgent && args[1]) {
          const target = defaultAgent.findById(args[1])
          if (!target) return `Agent ${args[1]} 不存在`
          target.autonomous.enabled = true
          os.startAutonomous(target, args.slice(2).join(' ') || undefined)
          return `已启动 ${args[1]} 的自主模式`
        }
        if (sub === 'recycle' && defaultAgent && args[1]) {
          const memory = os.recycleAgent(defaultAgent.id, args[1])
          if (!memory) return `回收失败: ${args[1]}`
          tui.updateAgentTree([defaultAgent.getHierarchy()])
          return `已回收 ${memory.agentName}, 压缩摘要: ${memory.summary.slice(0, 100)}...`
        }
        return '用法: /agent tree|create <name>|wake <id>|auto <id>|recycle <id>'
      }

      // ---- 信号命令 ----
      case 'signal': {
        const sub = args[0]
        if (sub === 'wake' && args[1]) {
          const ok = await os.wakeAgent(args[1], 'user', args.slice(2).join(' '))
          return ok ? `信号已发送` : `目标未注册`
        }
        if (sub === 'broadcast') {
          const targets = await os.runtime.broadcastSignal('user', args.slice(1).join(' '))
          return `已广播到 ${targets.length} 个 agent`
        }
        if (sub === 'monitor' && args[1]) {
          const tags = args[1].split(',')
          const targets = await os.runtime.sendMonitorSignal('user', tags, args.slice(2).join(' '))
          return `监控信号已发送到 ${targets.length} 个匹配 agent`
        }
        return '用法: /signal wake <id>|broadcast <msg>|monitor <tags> <msg>'
      }

      // ---- Plan Mode 命令 ----
      case 'plan': {
        const sub = args[0]
        if (sub === 'snapshot') {
          const snap = os.createPlanSnapshot()
          tui.updatePlanSnapshots(os.planMode.listSnapshots())
          return `快照已创建: ${snap.id}`
        }
        if (sub === 'diff') {
          const snapshots = os.planMode.listSnapshots()
          if (snapshots.length === 0) return '无快照，先 /plan snapshot'
          const latest = snapshots[snapshots.length - 1]
          const diff = os.getPlanDiff(latest.id)
          if (diff) {
            tui.setActivePlanDiff(diff)
            tui.setViewMode('plan')
            return os.planMode.printDiff(diff)
          }
          return '无差分'
        }
        if (sub === 'apply') {
          const snapshots = os.planMode.listSnapshots()
          if (snapshots.length === 0) return '无快照'
          const latest = snapshots[snapshots.length - 1]
          const diff = os.applyPlanDiff(latest.id)
          tui.setActivePlanDiff(null)
          tui.updatePlanSnapshots(os.planMode.listSnapshots())
          return diff ? `已应用差分: +${diff.added.length} -${diff.removed.length} ~${diff.modified.length}` : '应用失败'
        }
        if (sub === 'discard') {
          const snapshots = os.planMode.listSnapshots()
          if (snapshots.length === 0) return '无快照'
          const latest = snapshots[snapshots.length - 1]
          os.planMode.discardSnapshot(latest.id)
          tui.setActivePlanDiff(null)
          tui.updatePlanSnapshots(os.planMode.listSnapshots())
          return '快照已丢弃'
        }
        tui.setViewMode('plan')
        return null
      }

      // ---- 其他命令 ----
      case 'usage':
        return os.printUsageReport()

      case 'difficulty': {
        const text = args.join(' ')
        if (!text) return '用法: /difficulty <text>'
        const { assessDifficulty } = await import('./os/model-router.ts')
        const a = assessDifficulty(text)
        return `难度: ${a.level} (${a.score}/100)\n理由: ${a.rationale}\n因素: ${JSON.stringify(a.factors, null, 2)}`
      }

      case 'goals':
        tui.updateGoalTree(os.manager.getGoalTree())
        tui.setViewMode('goals')
        return null

      case 'status':
        tui.updateRuntimeStatus(os.getRuntimeStatus())
        return JSON.stringify(os.getRuntimeStatus(), null, 2)

      case 'clear':
        if (defaultAgent) defaultAgent.messages = []
        return '对话已清除'

      case 'model':
        if (args[0] && defaultAgent) {
          defaultAgent.model = args[0]
          return `模型已切换: ${args[0]}`
        }
        return `当前模型: ${defaultAgent?.model ?? '无'}`

      case 'help':
      case 'h':
      case '?':
        tui.setViewMode('help')
        return null

      default:
        return `未知命令: /${cmd}，输入 /help 查看帮助`
    }
  }

  // ---- 启动 TUI ----
  tui.start()

  // 初始状态
  if (defaultAgent) {
    tui.updateAgentTree([defaultAgent.getHierarchy()])
  }
  tui.updateRuntimeStatus(os.getRuntimeStatus())
}

main().catch((err) => {
  console.error('TUI 启动失败:', err)
  process.exit(1)
})
