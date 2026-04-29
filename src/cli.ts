#!/usr/bin/env node
/**
 * Byte CLI — 交互式多 Agent 终端前端
 *
 * 功能概览：
 *   /help           — 帮助信息
 *   /provider       — 管理 provider（list / add / models）
 *   /agent          — 管理 agent（list / create / switch / tree）
 *   /model          — 切换模型
 *   /difficulty     — 评估文本难度
 *   /goal           — 查看/管理目标树
 *   /usage          — 查看计费报告
 *   /config         — 查看/修改配置
 *   /compact        — 压缩上下文
 *   /clear          — 清空对话
 *   /exit           — 退出
 *
 * 直接输入文本即为对话（流式输出）
 */

import * as readline from 'node:readline'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  ByteOS,
  Agent,
  assessDifficulty,
  inferTaskType,
  authenticateCopilot,
  createCopilot,
  registerProvider,
} from './index.ts'

import type {
  AgentConfig,
  AgentEvent,
  ChatMessage,
  ChatStreamChunk,
  CopilotModelInfo,
  DifficultyAssessment,
} from './index.ts'

// ============================================================
//  ANSI 色彩工具
// ============================================================

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  // 前景色
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
}

function c(color: string, text: string): string {
  return `${color}${text}${C.reset}`
}

// ============================================================
//  全局状态
// ============================================================

const TOKEN_FILE = resolve('.copilot-token')
const CONFIG_FILE = resolve('.byte-config.json')

interface CLIConfig {
  defaultProvider?: string
  defaultModel?: string
  copilotToken?: string
  providers?: Record<string, { apiKey: string; baseURL?: string }>
  systemPrompt?: string
  maxTurns?: number
  stream?: boolean
}

let config: CLIConfig = {}
let os: ByteOS
let activeAgent: Agent | null = null
let conversationHistory: ChatMessage[] = []
let streamMode = true

// ============================================================
//  配置持久化
// ============================================================

function loadConfig(): CLIConfig {
  if (existsSync(CONFIG_FILE)) {
    try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) } catch { /* ignore */ }
  }
  // 尝试从旧 .copilot-token 读取
  if (existsSync(TOKEN_FILE)) {
    return { copilotToken: readFileSync(TOKEN_FILE, 'utf-8').trim() }
  }
  return {}
}

function saveConfig(): void {
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
}

// ============================================================
//  初始化
// ============================================================

function createOS(): ByteOS {
  return new ByteOS({
    onEvent: handleAgentEvent,
  })
}

function handleAgentEvent(event: AgentEvent): void {
  switch (event.type) {
    case 'log':
      process.stderr.write(c(C.gray, `  [${event.agentId.slice(0, 6)}] ${event.message}\n`))
      break
    case 'tool_call':
      process.stderr.write(c(C.cyan, `  ⚡ ${event.toolName}`) + c(C.gray, `(${truncate(String(event.input), 60)})\n`))
      break
    case 'tool_result':
      if (event.error) {
        process.stderr.write(c(C.red, `  ✗ ${event.toolName}: ${truncate(event.output, 80)}\n`))
      } else {
        process.stderr.write(c(C.green, `  ✓ ${event.toolName}`) + c(C.gray, ` (${truncate(event.output, 60)})\n`))
      }
      break
    case 'status_change':
      if (event.to === 'failed') {
        process.stderr.write(c(C.red, `  Agent ${event.agentId.slice(0, 6)} failed\n`))
      }
      break
    case 'child_done':
      process.stderr.write(c(C.magenta, `  ◆ 子 agent 完成: ${event.notification.agentName} — ${event.notification.status}\n`))
      break
  }
}

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\n/g, '↵').trim()
  return oneLine.length > n ? oneLine.slice(0, n - 1) + '…' : oneLine
}

// ============================================================
//  Provider 初始化
// ============================================================

async function initProviders(): Promise<void> {
  // 从配置初始化 providers
  if (config.providers) {
    for (const [name, cfg] of Object.entries(config.providers)) {
      try {
        registerProvider(name, { apiKey: cfg.apiKey, baseURL: cfg.baseURL ?? '' })
        log(`已注册 provider: ${name}`)
      } catch (e) {
        logError(`注册 ${name} 失败: ${e instanceof Error ? e.message : e}`)
      }
    }
  }

  // Copilot token
  if (config.copilotToken) {
    try {
      const copilot = createCopilot(config.copilotToken)
      os.monitor.attachSubscriptionProvider(copilot.usage)
      log('已注册 Copilot provider')
    } catch (e) {
      logError(`Copilot 初始化失败: ${e instanceof Error ? e.message : e}`)
    }
  }
}

// ============================================================
//  日志辅助
// ============================================================

function log(msg: string): void {
  console.log(c(C.green, '● ') + msg)
}

function logError(msg: string): void {
  console.log(c(C.red, '✗ ') + msg)
}

function logInfo(msg: string): void {
  console.log(c(C.blue, 'ℹ ') + msg)
}

function logWarn(msg: string): void {
  console.log(c(C.yellow, '⚠ ') + msg)
}

// ============================================================
//  核心对话（流式）
// ============================================================

async function chat(input: string): Promise<void> {
  if (!activeAgent) {
    logError('没有活跃的 agent。使用 /agent create 或 /provider add 先配置')
    return
  }

  if (!activeAgent.provider) {
    logError('当前 agent 没有 provider。使用 /provider add 添加')
    return
  }

  // 动态难度评估
  const assessment = assessDifficulty(input)
  const taskType = inferTaskType(input)
  process.stderr.write(
    c(C.gray, `  难度: ${assessment.level}(${assessment.score}) 类型: ${taskType}\n`),
  )

  // 追加到历史
  conversationHistory.push({ role: 'user', content: input })

  const t0 = Date.now()

  if (streamMode && activeAgent.provider.chatStream) {
    // 流式对话
    process.stdout.write(c(C.bold + C.blue, '\n  Byte') + c(C.gray, ' > '))

    let fullResponse = ''
    let ttft: number | undefined
    const messages: ChatMessage[] = [
      { role: 'system', content: activeAgent.systemPrompt || 'You are a helpful assistant.' },
      ...conversationHistory,
    ]

    try {
      for await (const chunk of activeAgent.provider.chatStream({
        model: activeAgent.model!,
        messages,
        stream: true,
      })) {
        if (ttft === undefined && chunk.latencyMs) {
          ttft = chunk.latencyMs
        }
        const delta = chunk.choices[0]?.delta
        if (delta?.content) {
          process.stdout.write(delta.content)
          fullResponse += delta.content
        }
      }
    } catch (err) {
      process.stdout.write('\n')
      logError(`流式调用失败: ${err instanceof Error ? err.message : err}`)
      return
    }

    const totalMs = Date.now() - t0
    process.stdout.write('\n')
    process.stderr.write(
      c(C.gray, `  ${totalMs}ms total`) +
        (ttft !== undefined ? c(C.gray, ` / TTFT ${ttft}ms`) : '') +
        '\n\n',
    )

    conversationHistory.push({ role: 'assistant', content: fullResponse })
  } else {
    // 非流式
    try {
      const result = await os.run(activeAgent, input)
      console.log(c(C.bold + C.blue, '\n  Byte') + c(C.gray, ' > ') + result.response)
      console.log(
        c(C.gray, `  ${result.durationMs}ms / ${result.totalTokens} tokens / ${result.turns} turns / ${result.toolUses} tool calls\n`),
      )
      conversationHistory.push({ role: 'assistant', content: result.response })
    } catch (err) {
      logError(`调用失败: ${err instanceof Error ? err.message : err}`)
    }
  }
}

// ============================================================
//  Agentic 模式（带工具调用循环）
// ============================================================

async function agenticChat(input: string): Promise<void> {
  if (!activeAgent) {
    logError('没有活跃的 agent。使用 /agent create 创建')
    return
  }

  try {
    const result = await os.run(activeAgent, input)
    console.log(c(C.bold + C.blue, '\n  Byte') + c(C.gray, ' > ') + result.response)
    console.log(
      c(C.gray, `  ${result.durationMs}ms / ${result.totalTokens} tokens / ${result.turns} turns / ${result.toolUses} tool calls\n`),
    )
  } catch (err) {
    logError(`Agentic 调用失败: ${err instanceof Error ? err.message : err}`)
  }
}

// ============================================================
//  命令处理
// ============================================================

async function handleCommand(line: string): Promise<boolean> {
  const parts = line.trim().split(/\s+/)
  const cmd = parts[0]?.toLowerCase()
  const args = parts.slice(1)

  switch (cmd) {
    case '/help':
    case '/h':
    case '/?':
      printHelp()
      return true

    case '/exit':
    case '/quit':
    case '/q':
      return false  // signal exit

    case '/clear':
      conversationHistory = []
      activeAgent?.messages.splice(0)
      log('对话已清空')
      return true

    case '/compact': {
      if (conversationHistory.length < 4) {
        logWarn('对话太短，无需压缩')
        return true
      }
      const kept = conversationHistory.slice(-4)
      const dropped = conversationHistory.length - 4
      conversationHistory = kept
      log(`已压缩，保留最近 4 条，丢弃 ${dropped} 条`)
      return true
    }

    case '/provider':
      await handleProviderCommand(args)
      return true

    case '/agent':
      await handleAgentCommand(args)
      return true

    case '/model':
      handleModelCommand(args)
      return true

    case '/difficulty':
    case '/diff':
      handleDifficultyCommand(args.join(' '))
      return true

    case '/goal':
      handleGoalCommand(args)
      return true

    case '/usage':
    case '/cost':
      console.log(os.printUsageReport())
      return true

    case '/config':
      handleConfigCommand(args)
      return true

    case '/stream':
      streamMode = !streamMode
      log(`流式模式: ${streamMode ? '开启' : '关闭'}`)
      return true

    case '/agentic':
    case '/run':
      await agenticChat(args.join(' '))
      return true

    default:
      logWarn(`未知命令: ${cmd}。使用 /help 查看帮助`)
      return true
  }
}

// ============================================================
//  /help
// ============================================================

function printHelp(): void {
  console.log(`
${c(C.bold + C.cyan, '  Byte CLI')} ${c(C.gray, '— 多 Agent 项目托管终端')}

${c(C.bold, '  对话')}
    ${c(C.yellow, '直接输入')}        流式对话（当前 agent + model）
    ${c(C.yellow, '/run <text>')}     Agentic 模式（带工具调用循环）
    ${c(C.yellow, '/stream')}         切换流式/非流式
    ${c(C.yellow, '/clear')}          清空对话历史
    ${c(C.yellow, '/compact')}        压缩上下文（保留最近 4 条）

${c(C.bold, '  Provider 管理')}
    ${c(C.yellow, '/provider list')}           列出已注册 provider
    ${c(C.yellow, '/provider add <name> <key>')}  注册新 provider
    ${c(C.yellow, '/provider copilot')}         Copilot OAuth 登录
    ${c(C.yellow, '/provider models [name]')}   列出可用模型

${c(C.bold, '  Agent 管理')}
    ${c(C.yellow, '/agent list')}              列出所有 agent
    ${c(C.yellow, '/agent create <name>')}     创建新 agent
    ${c(C.yellow, '/agent switch <name>')}     切换活跃 agent
    ${c(C.yellow, '/agent tree')}              显示 agent 层级树
    ${c(C.yellow, '/agent info')}              当前 agent 详情

${c(C.bold, '  模型与路由')}
    ${c(C.yellow, '/model <name>')}            切换当前 agent 的模型
    ${c(C.yellow, '/difficulty <text>')}       评估文本难度

${c(C.bold, '  目标与计费')}
    ${c(C.yellow, '/goal')}                    查看目标树
    ${c(C.yellow, '/usage')}                   查看计费报告

${c(C.bold, '  配置')}
    ${c(C.yellow, '/config')}                  查看当前配置
    ${c(C.yellow, '/config set <k> <v>')}      设置配置项
    ${c(C.yellow, '/exit')}                    退出
`)
}

// ============================================================
//  /provider
// ============================================================

async function handleProviderCommand(args: string[]): Promise<void> {
  const sub = args[0]?.toLowerCase()

  switch (sub) {
    case 'list':
    case 'ls':
    case undefined: {
      const list = os.listProviders()
      console.log(c(C.bold, '\n  已注册 Provider:'))
      if (list.chat.length === 0 && list.image.length === 0) {
        console.log(c(C.gray, '    (空) 使用 /provider add <name> <apiKey> 添加\n'))
        return
      }
      for (const name of list.chat) {
        const provider = os.getProvider(name)
        console.log(`    ${c(C.cyan, name)} ${c(C.gray, provider ? '(chat)' : '')}`)
      }
      for (const name of list.image) {
        console.log(`    ${c(C.magenta, name)} ${c(C.gray, '(image)')}`)
      }
      console.log()
      break
    }

    case 'add': {
      const name = args[1]
      const apiKey = args[2]
      if (!name || !apiKey) {
        logError('用法: /provider add <name> <apiKey> [baseURL]')
        logInfo('name 可以是: openrouter, deepseek, groq, openai, grsai, ollama, together, mistral')
        return
      }
      const baseURL = args[3] ?? ''
      try {
        os.registerProvider(name, { apiKey, baseURL })
        // 持久化
        config.providers = config.providers ?? {}
        config.providers[name] = { apiKey, baseURL: baseURL || undefined }
        saveConfig()
        log(`Provider "${name}" 已注册并保存`)
      } catch (e) {
        logError(`注册失败: ${e instanceof Error ? e.message : e}`)
      }
      break
    }

    case 'copilot': {
      logInfo('启动 GitHub Copilot OAuth 认证...')
      try {
        const auth = await authenticateCopilot(
          (userCode, verificationUri) => {
            console.log(`\n  请在浏览器中打开: ${c(C.underline + C.cyan, verificationUri)}`)
            console.log(`  输入验证码: ${c(C.bold + C.yellow, userCode)}\n`)
          },
        )
        config.copilotToken = auth.accessToken
        saveConfig()
        writeFileSync(TOKEN_FILE, auth.accessToken)

        const copilot = createCopilot(auth.accessToken)
        os.monitor.attachSubscriptionProvider(copilot.usage)
        log('Copilot 认证成功并已注册')

        // 如果没有活跃 agent，自动创建一个
        if (!activeAgent) {
          activeAgent = new Agent({
            name: 'default',
            role: 'standalone',
            systemPrompt: config.systemPrompt ?? 'You are a helpful assistant. Respond concisely.',
            provider: copilot,
            model: 'claude-haiku-4.5',
          })
          os.manager.register(activeAgent.id, activeAgent.role, 0)
          log('已创建默认 agent (claude-haiku-4.5)')
        }
      } catch (e) {
        logError(`Copilot 认证失败: ${e instanceof Error ? e.message : e}`)
      }
      break
    }

    case 'models': {
      const providerName = args[1]
      if (!providerName) {
        // 列出所有 provider 的模型
        const list = os.listProviders()
        for (const name of list.chat) {
          const provider = os.getProvider(name)
          if (!provider?.listModels) continue
          try {
            const models = await provider.listModels()
            console.log(c(C.bold, `\n  ${name}:`))
            for (const m of models.slice(0, 20)) {
              console.log(`    ${c(C.cyan, m)}`)
            }
            if (models.length > 20) {
              console.log(c(C.gray, `    ... 还有 ${models.length - 20} 个`))
            }
          } catch {
            console.log(c(C.gray, `\n  ${name}: (无法获取模型列表)`))
          }
        }
        console.log()
        return
      }
      const provider = os.getProvider(providerName)
      if (!provider) {
        logError(`Provider "${providerName}" 未注册`)
        return
      }
      if (!provider.listModels) {
        logWarn(`Provider "${providerName}" 不支持列出模型`)
        return
      }
      const models = await provider.listModels()
      console.log(c(C.bold, `\n  ${providerName} 可用模型:`))
      for (const m of models) {
        console.log(`    ${c(C.cyan, m)}`)
      }
      console.log()
      break
    }

    default:
      logWarn(`未知子命令: /provider ${sub}`)
  }
}

// ============================================================
//  /agent
// ============================================================

const agents = new Map<string, Agent>()

async function handleAgentCommand(args: string[]): Promise<void> {
  const sub = args[0]?.toLowerCase()

  switch (sub) {
    case 'list':
    case 'ls':
    case undefined: {
      console.log(c(C.bold, '\n  Agent 列表:'))
      if (agents.size === 0) {
        console.log(c(C.gray, '    (空) 使用 /agent create <name> 创建\n'))
        return
      }
      for (const [name, agent] of agents) {
        const active = agent === activeAgent ? c(C.green, ' ●') : '  '
        const model = agent.model ? c(C.gray, ` [${agent.model}]`) : ''
        const status = c(C.gray, ` (${agent.status})`)
        console.log(`  ${active} ${c(C.cyan, name)}${model}${status}`)
      }
      console.log()
      break
    }

    case 'create': {
      const name = args[1] ?? 'agent-' + agents.size
      const role = (args[2] as 'coordinator' | 'worker' | 'standalone') ?? 'standalone'

      // 寻找可用 provider
      const list = os.listProviders()
      let provider = activeAgent?.provider
      let model = config.defaultModel ?? activeAgent?.model

      if (!provider && list.chat.length > 0) {
        provider = os.getProvider(list.chat[0]) ?? undefined
      }

      const agent = new Agent({
        name,
        role,
        systemPrompt: config.systemPrompt ?? 'You are a helpful assistant. Respond concisely.',
        provider,
        model,
        tools: [
          (await import('./os/tools/bash.ts')).bashTool,
          (await import('./os/tools/file-read.ts')).fileReadTool,
          (await import('./os/tools/file-write.ts')).fileWriteTool,
          (await import('./os/tools/web-fetch.ts')).webFetchTool,
        ],
        maxTurns: config.maxTurns ?? 20,
      })
      os.manager.register(agent.id, agent.role, agent.getDepth())
      agents.set(name, agent)
      activeAgent = agent
      log(`Agent "${name}" 已创建 (${role})${model ? ' [' + model + ']' : ''}`)
      break
    }

    case 'switch': {
      const name = args[1]
      if (!name) {
        logError('用法: /agent switch <name>')
        return
      }
      const agent = agents.get(name)
      if (!agent) {
        logError(`Agent "${name}" 不存在。使用 /agent list 查看`)
        return
      }
      activeAgent = agent
      conversationHistory = [...agent.messages.filter(m => m.role !== 'system')]
      log(`已切换到 agent "${name}"`)
      break
    }

    case 'tree': {
      console.log(c(C.bold, '\n  Agent 层级树:'))
      for (const [name, agent] of agents) {
        const tree = agent.getHierarchy()
        printTree(tree, '    ', name === (activeAgent?.name ?? ''))
      }
      console.log()
      break
    }

    case 'info': {
      if (!activeAgent) {
        logWarn('没有活跃的 agent')
        return
      }
      const a = activeAgent
      console.log(c(C.bold, '\n  当前 Agent:'))
      console.log(`    名称:     ${c(C.cyan, a.name)}`)
      console.log(`    ID:       ${c(C.gray, a.id)}`)
      console.log(`    角色:     ${a.role}`)
      console.log(`    状态:     ${a.status}`)
      console.log(`    模型:     ${a.model ?? c(C.gray, '(未设置)')}`)
      console.log(`    Provider: ${a.provider?.name ?? c(C.gray, '(未设置)')}`)
      console.log(`    工具:     ${a.tools.map(t => t.name).join(', ') || c(C.gray, '(无)')}`)
      console.log(`    Token:    ${a.totalTokens} / ${a.maxBudgetTokens}`)
      console.log(`    轮次:     ${a.toolUses} tool calls`)
      console.log(`    深度:     ${a.getDepth()}`)
      console.log(`    子 Agent: ${a.children.length}`)
      console.log()
      break
    }

    default:
      logWarn(`未知子命令: /agent ${sub}`)
  }
}

function printTree(node: { id: string; name: string; role: string; status: string; model?: string; children: unknown[] }, indent: string, isActive: boolean): void {
  const marker = isActive ? c(C.green, '●') : c(C.gray, '○')
  const model = node.model ? c(C.gray, ` [${node.model}]`) : ''
  console.log(`${indent}${marker} ${c(C.cyan, node.name)} (${node.role})${model} — ${node.status}`)
  for (const child of node.children as typeof node[]) {
    printTree(child, indent + '  ', false)
  }
}

// ============================================================
//  /model
// ============================================================

function handleModelCommand(args: string[]): void {
  if (!activeAgent) {
    logError('没有活跃的 agent')
    return
  }
  const model = args[0]
  if (!model) {
    logInfo(`当前模型: ${activeAgent.model ?? '(未设置)'}`)
    logInfo('用法: /model <model-name>')
    return
  }
  activeAgent.model = model
  config.defaultModel = model
  saveConfig()
  log(`模型已切换为: ${model}`)
}

// ============================================================
//  /difficulty
// ============================================================

function handleDifficultyCommand(text: string): void {
  if (!text.trim()) {
    logError('用法: /difficulty <text>')
    return
  }
  const a = assessDifficulty(text)
  const taskType = inferTaskType(text)

  const barWidth = 30
  const filled = Math.round((a.score / 100) * barWidth)
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled)

  const levelColors: Record<string, string> = {
    trivial: C.gray,
    easy: C.green,
    moderate: C.yellow,
    challenging: C.yellow + C.bold,
    hard: C.red,
    expert: C.magenta + C.bold,
  }

  console.log(c(C.bold, '\n  难度评估:'))
  console.log(`    等级:     ${c(levelColors[a.level] ?? C.white, a.level.toUpperCase())}`)
  console.log(`    分数:     ${c(C.bold, String(a.score))} / 100  [${c(levelColors[a.level] ?? '', bar)}]`)
  console.log(`    类型:     ${taskType}`)
  console.log(`    依据:     ${a.rationale}`)
  console.log(c(C.bold, '    维度:'))
  console.log(`      文本范围:     ${factorBar(a.factors.textScope, 15)}`)
  console.log(`      技术深度:     ${factorBar(a.factors.technicalDepth, 25)}`)
  console.log(`      多步复杂度:   ${factorBar(a.factors.multiStepComplexity, 20)}`)
  console.log(`      模糊度:       ${factorBar(a.factors.ambiguity, 15)}`)
  console.log(`      算法强度:     ${factorBar(a.factors.algorithmicIntensity, 25)}`)
  console.log()
}

function factorBar(value: number, max: number): string {
  const w = 15
  const f = Math.round((value / max) * w)
  return `${value}/${max} [${'▓'.repeat(f)}${'░'.repeat(w - f)}]`
}

// ============================================================
//  /goal
// ============================================================

function handleGoalCommand(args: string[]): void {
  const sub = args[0]

  switch (sub) {
    case 'create': {
      if (!activeAgent) { logError('没有活跃的 agent'); return }
      const goalText = args.slice(1).join(' ')
      if (!goalText) { logError('用法: /goal create <目标描述>'); return }
      const node = os.manager.createGoal(
        activeAgent.id,
        goalText,
        [{ id: 'step-1', description: '待规划', status: 'pending', reusable: true }],
      )
      log(`目标已创建: ${node.id.slice(0, 8)}`)
      break
    }

    case undefined:
    case 'tree': {
      const tree = os.manager.getGoalTree()
      if (tree.length === 0) {
        logInfo('暂无目标。使用 /goal create <描述> 创建')
        return
      }
      console.log(c(C.bold, '\n  目标树:'))
      for (const node of tree) {
        printGoalNode(node, '    ')
      }
      console.log()
      break
    }

    default:
      logWarn(`未知子命令: /goal ${sub}`)
  }
}

function printGoalNode(node: { id: string; goal: string; status: string; plan: { id: string; description: string; status: string }[]; children: unknown[] }, indent: string): void {
  const statusIcon: Record<string, string> = {
    pending: c(C.gray, '○'),
    active: c(C.cyan, '◉'),
    completed: c(C.green, '✓'),
    blocked: c(C.yellow, '⊘'),
    suspended: c(C.yellow, '⏸'),
    failed: c(C.red, '✗'),
    revised: c(C.magenta, '↻'),
    abandoned: c(C.gray, '✗'),
  }
  const icon = statusIcon[node.status] ?? '?'
  console.log(`${indent}${icon} ${node.goal} ${c(C.gray, `[${node.status}]`)}`)
  for (const step of node.plan) {
    const stepIcon = step.status === 'done' ? c(C.green, '✓') : step.status === 'in-progress' ? c(C.cyan, '►') : c(C.gray, '·')
    console.log(`${indent}  ${stepIcon} ${step.description}`)
  }
  for (const child of node.children as typeof node[]) {
    printGoalNode(child, indent + '  ')
  }
}

// ============================================================
//  /config
// ============================================================

function handleConfigCommand(args: string[]): void {
  if (args[0] === 'set') {
    const key = args[1]
    const value = args.slice(2).join(' ')
    if (!key) { logError('用法: /config set <key> <value>'); return }
    switch (key) {
      case 'systemPrompt': config.systemPrompt = value; break
      case 'maxTurns': config.maxTurns = parseInt(value, 10); break
      case 'defaultModel': config.defaultModel = value; break
      case 'defaultProvider': config.defaultProvider = value; break
      default: logError(`未知配置项: ${key}`); return
    }
    saveConfig()
    log(`${key} = ${value}`)
    return
  }

  console.log(c(C.bold, '\n  当前配置:'))
  console.log(`    defaultProvider: ${config.defaultProvider ?? c(C.gray, '(未设置)')}`)
  console.log(`    defaultModel:    ${config.defaultModel ?? c(C.gray, '(未设置)')}`)
  console.log(`    systemPrompt:    ${truncate(config.systemPrompt ?? '(默认)', 50)}`)
  console.log(`    maxTurns:        ${config.maxTurns ?? 20}`)
  console.log(`    stream:          ${streamMode}`)
  console.log(`    copilotToken:    ${config.copilotToken ? c(C.green, '已配置') : c(C.gray, '未配置')}`)
  console.log(`    providers:       ${Object.keys(config.providers ?? {}).join(', ') || c(C.gray, '(空)')}`)
  console.log(`    配置文件:        ${c(C.gray, CONFIG_FILE)}`)
  console.log()
}

// ============================================================
//  Banner
// ============================================================

function printBanner(): void {
  console.log(`
${c(C.bold + C.cyan, '  ╔══════════════════════════════════════╗')}
${c(C.bold + C.cyan, '  ║')}${c(C.bold + C.white, '        Byte CLI v0.1.0               ')}${c(C.bold + C.cyan, '║')}
${c(C.bold + C.cyan, '  ║')}${c(C.gray, '   多 Agent 项目托管终端前端          ')}${c(C.bold + C.cyan, '║')}
${c(C.bold + C.cyan, '  ╚══════════════════════════════════════╝')}
`)

  if (!config.copilotToken && (!config.providers || Object.keys(config.providers).length === 0)) {
    console.log(c(C.yellow, '  ⚠ 还没有注册任何 Provider。开始:'))
    console.log(c(C.gray, '    /provider copilot          — GitHub Copilot 登录'))
    console.log(c(C.gray, '    /provider add openrouter <key> — OpenRouter API'))
    console.log()
  }
}

// ============================================================
//  REPL 主循环
// ============================================================

async function main(): Promise<void> {
  config = loadConfig()
  os = createOS()

  printBanner()
  await initProviders()

  // 如果有 copilot token 且没有 active agent，自动创建
  if (config.copilotToken && !activeAgent) {
    try {
      const copilot = createCopilot(config.copilotToken)
      os.monitor.attachSubscriptionProvider(copilot.usage)
      activeAgent = new Agent({
        name: 'default',
        role: 'standalone',
        systemPrompt: config.systemPrompt ?? 'You are a helpful assistant. Respond concisely.',
        provider: copilot,
        model: config.defaultModel ?? 'claude-haiku-4.5',
      })
      os.manager.register(activeAgent.id, activeAgent.role, 0)
      agents.set('default', activeAgent)
      log(`默认 agent 已就绪 [${activeAgent.model}]`)
    } catch (e) {
      logError(`Copilot token 无效或已过期，请使用 /provider copilot 重新登录`)
    }
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '',
    terminal: true,
  })

  function prompt(): void {
    const agentName = activeAgent ? c(C.cyan, activeAgent.name) : c(C.gray, 'no-agent')
    const modelName = activeAgent?.model ? c(C.gray, `[${activeAgent.model}]`) : ''
    process.stdout.write(`\n  ${agentName}${modelName} ${c(C.bold, '❯')} `)
  }

  prompt()

  rl.on('line', async (line: string) => {
    const trimmed = line.trim()

    if (!trimmed) {
      prompt()
      return
    }

    if (trimmed.startsWith('/')) {
      const shouldContinue = await handleCommand(trimmed)
      if (!shouldContinue) {
        console.log(c(C.gray, '\n  再见 👋\n'))
        rl.close()
        process.exit(0)
      }
    } else {
      await chat(trimmed)
    }

    prompt()
  })

  rl.on('close', () => {
    process.exit(0)
  })
}

main().catch((err) => {
  console.error(c(C.red, `启动失败: ${err.message}`))
  process.exit(1)
})
