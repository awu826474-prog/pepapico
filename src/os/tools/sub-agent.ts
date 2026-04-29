/**
 * 内置工具：SubAgent
 * 照搬 cc AgentTool — 协调者生成子 Agent
 */

import type { Tool, ToolResult, ToolContext } from '../tool.ts'
import { Agent } from '../agent.ts'
import { runAgentLoop } from '../agent-loop.ts'
import type { ModelProvider } from '../../provider/types.ts'

/**
 * 创建 SubAgent 工具
 * 需要传入父 agent 引用和可用 provider 映射
 */
export function createSubAgentTool(
  parentAgent: Agent,
  providerMap: Map<string, { provider: ModelProvider; model: string }>,
): Tool {
  return {
    name: 'sub_agent',
    description:
      '创建并运行一个子 Agent 来完成子任务。子 Agent 会独立运行，完成后汇报结果。适合将复杂任务拆分为并行的子任务。',
    tags: ['agent', 'coordinator'],
    readOnly: true,

    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '子 Agent 名称（如 "researcher", "implementer"）',
          required: true,
        },
        task: {
          type: 'string',
          description: '分配给子 Agent 的任务描述（必须自包含，包含所有必要信息）',
          required: true,
        },
        provider: {
          type: 'string',
          description: '使用的 provider 名称（不指定则使用默认）',
        },
        model: {
          type: 'string',
          description: '使用的模型名称（不指定则使用默认）',
        },
      },
      required: ['name', 'task'],
    },

    async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const name = input.name as string
      const task = input.task as string
      const providerName = input.provider as string | undefined
      const modelName = input.model as string | undefined

      if (!name || !task) {
        return { output: '错误：name 和 task 是必需参数', error: true }
      }

      // 解析 provider + model
      let provider: ModelProvider | undefined
      let model: string | undefined

      if (providerName && providerMap.has(providerName)) {
        const entry = providerMap.get(providerName)!
        provider = entry.provider
        model = modelName ?? entry.model
      } else {
        // 使用第一个可用的 provider 作为默认
        const first = providerMap.values().next()
        if (!first.done) {
          provider = first.value.provider
          model = modelName ?? first.value.model
        }
      }

      if (!provider || !model) {
        return { output: '错误：没有可用的 provider', error: true }
      }

      // 创建子 agent
      const child = parentAgent.createChild({
        name,
        role: 'worker',
        systemPrompt: `你是一个 Worker Agent，名称为 "${name}"。你的任务是完成分配给你的工作并汇报结果。\n\n请专注完成任务，输出清晰的结果。`,
        provider,
        model,
        maxTurns: 10,
        tools: [], // Worker 暂不给工具，后续扩展
      })

      try {
        const result = await runAgentLoop(child, {
          userMessage: task,
          signal: context.signal,
        })

        return {
          output: `子 Agent "${name}" 完成\n模型: ${model}\n耗时: ${result.durationMs}ms\nTokens: ${result.totalTokens}\n轮次: ${result.turns}\n\n--- 结果 ---\n${result.response}`,
          metadata: {
            agentId: child.id,
            totalTokens: result.totalTokens,
            durationMs: result.durationMs,
          },
        }
      } catch (err) {
        return {
          output: `子 Agent "${name}" 执行失败: ${err instanceof Error ? err.message : String(err)}`,
          error: true,
        }
      }
    },
  }
}
