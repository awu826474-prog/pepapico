/**
 * Agent OS 集成测试
 *
 * 测试场景：
 * 1. 创建 Coordinator Agent（使用 DeepSeek 模型）
 * 2. Coordinator 配备 sub_agent 工具 + file_read + web_fetch
 * 3. ModelRouter 根据任务类型自动选择模型
 * 4. 端到端运行：用户提问 → Coordinator → 调用工具 → 返回结果
 */

import {
  Agent,
  runAgentLoop,
  ModelRouter,
  inferTaskType,
  inferDifficulty,
  webFetchTool,
  fileReadTool,
  bashTool,
} from './os/index.ts'
import { createOpenRouter } from './provider/index.ts'

// ---- 配置 ----
const OPENROUTER_KEY =
  process.env.OPENROUTER_API_KEY ||
  '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'

async function main() {
  console.log('=== Agent OS 集成测试 ===\n')

  // ---- 1. 注册 Provider ----
  const openrouter = createOpenRouter(OPENROUTER_KEY)
  console.log('✓ Provider 注册完成: openrouter')

  // ---- 2. 配置 ModelRouter ----
  const router = new ModelRouter()
  router
    .setFallback('openrouter', 'deepseek/deepseek-chat-v3-0324')
    .addRule({
      taskType: ['code', 'analysis'],
      difficulty: 'hard',
      provider: 'openrouter',
      model: 'deepseek/deepseek-chat-v3-0324',
      priority: 10,
    })
    .addRule({
      taskType: ['chat', 'general'],
      provider: 'openrouter',
      model: 'deepseek/deepseek-v3.2',
      priority: 5,
    })

  console.log('✓ ModelRouter 配置完成')
  console.log('  规则数:', router.getRules().length)

  // ---- 3. 测试 ModelRouter 推断 ----
  const testTexts = [
    '帮我写一个排序算法的函数',
    '今天天气怎么样',
    '画一只猫',
    '分析一下这段代码的性能问题并且重构',
  ]

  console.log('\n--- ModelRouter 推断测试 ---')
  for (const text of testTexts) {
    const taskType = inferTaskType(text)
    const difficulty = inferDifficulty(text)
    const result = router.route({ taskType, difficulty })
    console.log(`  "${text}"`)
    console.log(`    → 类型=${taskType}, 难度=${difficulty}, 模型=${result.model}`)
  }

  // ---- 4. 创建 Agent 并运行 ----
  console.log('\n--- Agent 端到端测试 ---')

  // 用 ModelRouter 为任务选择模型
  const userTask = '请读取 package.json 文件并告诉我这个项目的名称和依赖'
  const taskType = inferTaskType(userTask)
  const difficulty = inferDifficulty(userTask)
  const routing = router.route({ taskType, difficulty })

  console.log(`任务: "${userTask}"`)
  console.log(`路由: 类型=${taskType}, 难度=${difficulty}, 模型=${routing.model}`)

  const agent = new Agent({
    name: 'coordinator',
    role: 'coordinator',
    systemPrompt: `你是一个项目管理 Agent。你可以使用工具来读取文件、获取网页内容、执行命令。
请使用可用的工具来完成用户的任务，然后给出简洁的回答。
注意：只使用一次或两次工具就回答，不要过度调用。`,
    tools: [fileReadTool, webFetchTool, bashTool],
    provider: openrouter,
    model: routing.model,
    maxTurns: 5,
  })

  // 订阅事件
  agent.on((event) => {
    switch (event.type) {
      case 'log':
        console.log(`  [LOG] ${event.message}`)
        break
      case 'tool_call':
        console.log(`  [TOOL] 调用 ${event.toolName}`)
        break
      case 'tool_result': {
        const preview = (event.output as string).slice(0, 100)
        console.log(`  [TOOL] 结果: ${preview}${event.output.length > 100 ? '...' : ''}`)
        break
      }
      case 'status_change':
        console.log(`  [STATUS] ${event.from} → ${event.to}`)
        break
    }
  })

  try {
    const result = await runAgentLoop(agent, { userMessage: userTask })

    console.log('\n--- 结果 ---')
    console.log(`回复: ${result.response}`)
    console.log(`Tokens: ${result.totalTokens}`)
    console.log(`工具调用: ${result.toolUses} 次`)
    console.log(`轮次: ${result.turns}`)
    console.log(`耗时: ${result.durationMs}ms`)
    console.log('✓ Agent 测试通过')
  } catch (err) {
    console.error('✗ Agent 测试失败:', err)
  }

  // ---- 5. 测试 Agent 层级关系 ----
  console.log('\n--- Agent 层级树 ---')
  console.log(JSON.stringify(agent.getHierarchy(), null, 2))

  console.log('\n=== 所有测试完成 ===')
}

main().catch(console.error)
