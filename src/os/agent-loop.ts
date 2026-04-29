/**
 * AgentLoop — Agentic 循环引擎（v2: 并行 + 信号驱动 + 权限确认）
 *
 * 核心变化：
 * 1. 任务完成后 agent 回到 idle 等待下一个信号（不是 done）
 * 2. 多个子 agent 的工具调用并行执行（Promise.allSettled）
 * 3. 工具执行前经过 PermissionGuard 权限检查
 * 4. 支持自主模式——agent 被信号唤醒后自动执行任务
 */

import { Agent } from './agent.ts'
import type { Tool, ToolContext, ToolResult } from './tool.ts'
import { toToolDefinitions } from './tool.ts'
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ToolCall,
} from '../provider/types.ts'
import type { PermissionGuard } from './permission-guard.ts'

// ---- 重试配置 ----

const MAX_API_RETRIES = 3
const RETRY_BASE_DELAY_MS = 1000
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504])

export interface AgentLoopOptions {
  /** 用户输入 */
  userMessage: string
  /** 可选：附加到用户消息的上下文 */
  context?: string
  /** 中止信号 */
  signal?: AbortSignal
  /** 权限守卫（不提供则跳过权限检查） */
  permissionGuard?: PermissionGuard
  /** 是否在完成后回到 idle（默认 true） */
  returnToIdle?: boolean
  /** 是否自主模式触发（影响权限检查行为） */
  autonomous?: boolean
}

export interface AgentLoopResult {
  /** 最终文本响应 */
  response: string
  /** 消耗 token */
  totalTokens: number
  /** 工具调用次数 */
  toolUses: number
  /** 循环轮次 */
  turns: number
  /** 耗时 ms */
  durationMs: number
  /** 是否因权限被拒绝而终止 */
  abortedByPermission: boolean
}

/**
 * 运行 Agent 循环
 * 完成后 agent 回到 idle（可被再次唤醒）
 */
export async function runAgentLoop(
  agent: Agent,
  options: AgentLoopOptions,
): Promise<AgentLoopResult> {
  if (!agent.provider) {
    throw new Error(`Agent "${agent.name}" has no provider`)
  }
  if (!agent.model) {
    throw new Error(`Agent "${agent.name}" has no model`)
  }

  agent.setStatus('running')
  agent.startTime = Date.now()

  // 构建初始消息
  const systemContent = agent.buildSystemMessage()
  agent.messages = [
    { role: 'system', content: systemContent },
    {
      role: 'user',
      content: options.context
        ? `${options.userMessage}\n\n${options.context}`
        : options.userMessage,
    },
  ]

  const toolDefs = agent.tools.length > 0 ? toToolDefinitions(agent.tools) : undefined
  const toolMap = new Map(agent.tools.map((t) => [t.name, t]))

  let turns = 0
  let abortedByPermission = false

  try {
    while (turns < agent.maxTurns) {
      // 检查中止
      if (options.signal?.aborted) {
        agent.setStatus('killed')
        break
      }

      // 检查 token 预算
      if (agent.totalTokens >= agent.maxBudgetTokens) {
        agent.log(`Token 预算已耗尽 (${agent.totalTokens}/${agent.maxBudgetTokens})`)
        break
      }

      turns++
      agent.log(`[轮次 ${turns}/${agent.maxTurns}] 调用模型 ${agent.model}`)

      // 构建请求
      const request: ChatRequest = {
        model: agent.model,
        messages: agent.messages,
        tools: toolDefs,
        tool_choice: toolDefs ? 'auto' : undefined,
      }

      // 调用模型（带重试）
      const response = await callWithRetry(agent, request, options.signal)

      // 计数
      if (response.usage) {
        agent.totalTokens += response.usage.total_tokens
      }

      // 记录延迟
      if (response.latencyMs !== undefined) {
        agent.log(`  模型延迟: ${response.latencyMs}ms`)
      }

      const choice = response.choices[0]
      if (!choice) {
        agent.log('模型返回空响应')
        break
      }

      const assistantMsg = choice.message
      agent.messages.push(assistantMsg)

      // 输出文本
      if (assistantMsg.content && typeof assistantMsg.content === 'string') {
        agent.emit({
          type: 'progress',
          agentId: agent.id,
          content: assistantMsg.content,
        })
      }

      // 无 tool_calls → 结束循环
      if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
        agent.log('模型结束响应（无工具调用）')
        break
      }

      // 执行工具调用（带权限检查 + 并行执行）
      const execResult = await executeToolCalls(
        agent,
        assistantMsg.tool_calls,
        toolMap,
        options.signal,
        options.permissionGuard,
        options.autonomous,
      )

      if (execResult.aborted) {
        abortedByPermission = true
        agent.log('Agent 因权限拒绝而终止')
        // 添加一条消息告知模型
        agent.messages.push({
          role: 'user',
          content: '[系统] 操作因权限被拒绝而终止。',
        })
        break
      }

      // 将工具结果追加到消息历史
      for (const tr of execResult.results) {
        agent.messages.push(tr)
      }

      agent.toolUses += assistantMsg.tool_calls.length
    }

    // 完成后回到 idle（不是 done），除非被 kill
    if (agent.status === 'running') {
      const returnToIdle = options.returnToIdle ?? true
      agent.setStatus(returnToIdle ? 'idle' : 'done')
    }
  } catch (err) {
    agent.setStatus('failed')
    agent.log(`Agent 错误: ${err instanceof Error ? err.message : String(err)}`)
    throw err
  }

  // 汇报给父 agent
  if (agent.parent) {
    agent.reportToParent()
  }

  const durationMs = Date.now() - agent.startTime
  return {
    response: agent.getLastAssistantMessage(),
    totalTokens: agent.totalTokens,
    toolUses: agent.toolUses,
    turns,
    durationMs,
    abortedByPermission,
  }
}

/**
 * 并行运行多个子 agent
 * 所有子 agent 同时启动，各自独立运行，全部完成后返回
 */
export async function runChildrenParallel(
  parent: Agent,
  children: Agent[],
  tasks: { agent: Agent; message: string; context?: string }[],
  options?: { signal?: AbortSignal; permissionGuard?: PermissionGuard },
): Promise<AgentLoopResult[]> {
  parent.log(`并行启动 ${tasks.length} 个子 agent`)

  const promises = tasks.map(async (task) => {
    return runAgentLoop(task.agent, {
      userMessage: task.message,
      context: task.context,
      signal: options?.signal,
      permissionGuard: options?.permissionGuard,
      returnToIdle: true,
    })
  })

  const results = await Promise.allSettled(promises)

  return results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value
    // 失败的子 agent 返回错误结果
    const agent = tasks[i].agent
    agent.setStatus('failed')
    return {
      response: `子 agent "${agent.name}" 失败: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
      totalTokens: agent.totalTokens,
      toolUses: agent.toolUses,
      turns: 0,
      durationMs: Date.now() - agent.startTime,
      abortedByPermission: false,
    }
  })
}

/**
 * 带指数退避的模型 API 调用重试
 * 仅对网络错误和可重试 HTTP 状态码（429/5xx）重试
 */
async function callWithRetry(
  agent: Agent,
  request: ChatRequest,
  signal?: AbortSignal,
): Promise<ChatResponse> {
  let lastError: unknown
  for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error('已中止')
    try {
      return await agent.provider!.chat(request)
    } catch (err) {
      lastError = err
      const msg = err instanceof Error ? err.message : String(err)
      // 判断是否可重试
      const isRetryable =
        /ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|socket hang up/i.test(msg) ||
        RETRYABLE_STATUS_CODES.has(extractStatusCode(msg))
      if (!isRetryable || attempt >= MAX_API_RETRIES) throw err
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt)
      agent.log(`  API 调用失败 (${msg})，${delay}ms 后重试 (${attempt + 1}/${MAX_API_RETRIES})`)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw lastError
}

/** 从错误消息中提取 HTTP 状态码 */
function extractStatusCode(msg: string): number {
  const m = msg.match(/\b(4\d{2}|5\d{2})\b/)
  return m ? Number(m[1]) : 0
}

/**
 * 执行一组 tool_calls，带权限检查 + 独立工具并行执行
 *
 * 并行策略：
 * - 只读工具（readOnly=true）可并行执行
 * - 写操作工具按顺序执行（保证一致性）
 * - 权限检查在执行前进行
 */
async function executeToolCalls(
  agent: Agent,
  toolCalls: ToolCall[],
  toolMap: Map<string, Tool>,
  signal?: AbortSignal,
  permissionGuard?: PermissionGuard,
  autonomous?: boolean,
): Promise<{ results: ChatMessage[]; aborted: boolean }> {
  const results: ChatMessage[] = []

  // 分类：只读 vs 写操作
  const readOnlyCalls: { tc: ToolCall; tool: Tool | undefined }[] = []
  const writeCalls: { tc: ToolCall; tool: Tool | undefined }[] = []

  for (const tc of toolCalls) {
    const tool = toolMap.get(tc.function.name)
    if (tool?.readOnly) {
      readOnlyCalls.push({ tc, tool })
    } else {
      writeCalls.push({ tc, tool })
    }
  }

  // 并行执行只读工具
  if (readOnlyCalls.length > 0) {
    const readResults = await Promise.all(
      readOnlyCalls.map((entry) =>
        executeSingleTool(agent, entry.tc, entry.tool, signal, permissionGuard, autonomous),
      ),
    )
    for (const r of readResults) {
      if (r.aborted) return { results, aborted: true }
      results.push(r.message)
    }
  }

  // 顺序执行写操作工具
  for (const entry of writeCalls) {
    const r = await executeSingleTool(agent, entry.tc, entry.tool, signal, permissionGuard, autonomous)
    if (r.aborted) return { results, aborted: true }
    results.push(r.message)
  }

  return { results, aborted: false }
}

/** 执行单个工具调用（含权限检查） */
async function executeSingleTool(
  agent: Agent,
  tc: ToolCall,
  tool: Tool | undefined,
  signal?: AbortSignal,
  permissionGuard?: PermissionGuard,
  autonomous?: boolean,
): Promise<{ message: ChatMessage; aborted: boolean }> {
  agent.emit({
    type: 'tool_call',
    agentId: agent.id,
    toolName: tc.function.name,
    input: tc.function.arguments,
  })

  let input: Record<string, unknown>
  try {
    input = JSON.parse(tc.function.arguments)
  } catch {
    input = { raw: tc.function.arguments }
  }

  // ---- 权限检查 ----
  if (permissionGuard && tool) {
    // 自主模式下，检查工具是否在自动放行列表中
    const isAutoApproved = autonomous && agent.autonomous.autoApproveTools.includes(tool.name)

    if (!isAutoApproved) {
      const decision = await permissionGuard.check(agent.id, tc.function.name, input)

      if (decision.action === 'deny') {
        const result: ToolResult = {
          output: `权限被拒绝: ${decision.reason ?? '用户拒绝了此操作'}`,
          error: true,
        }
        agent.emit({
          type: 'tool_result',
          agentId: agent.id,
          toolName: tc.function.name,
          output: result.output,
          error: true,
        })
        return {
          message: { role: 'tool', tool_call_id: tc.id, content: result.output },
          aborted: false,
        }
      }

      if (decision.action === 'deny_and_abort') {
        return {
          message: { role: 'tool', tool_call_id: tc.id, content: '操作被拒绝，Agent 终止' },
          aborted: true,
        }
      }
    }
  }

  // ---- 执行工具 ----
  let result: ToolResult

  if (!tool) {
    result = {
      output: `工具 "${tc.function.name}" 不存在`,
      error: true,
    }
  } else {
    const context: ToolContext = {
      cwd: process.cwd(),
      agentId: agent.id,
      onProgress: (msg) =>
        agent.emit({ type: 'progress', agentId: agent.id, content: msg }),
      signal,
    }

    try {
      result = await tool.call(input, context)
    } catch (err) {
      result = {
        output: `工具执行出错: ${err instanceof Error ? err.message : String(err)}`,
        error: true,
      }
    }
  }

  agent.emit({
    type: 'tool_result',
    agentId: agent.id,
    toolName: tc.function.name,
    output: result.output,
    error: result.error,
  })

  return {
    message: { role: 'tool', tool_call_id: tc.id, content: result.output },
    aborted: false,
  }
}
