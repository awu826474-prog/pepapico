/**
 * GitHub Copilot Provider 测试
 *
 * 使用你的 GitHub Copilot Pro 订阅测试。
 *
 * 运行方式：
 *   node src/test-copilot.ts
 *
 * 首次运行会走 OAuth Device Flow：
 *   1. 终端显示一个 user_code（如 ABCD-1234）
 *   2. 自动用浏览器打开 https://github.com/login/device
 *   3. 输入 user_code，点击授权
 *   4. 回到终端，token 自动获取完成
 *
 * Token 会保存到 .copilot-token 文件，后续运行直接复用。
 *
 * 测试内容：
 *   1. 认证 + token 持久化
 *   2. 列出可用模型
 *   3. 非流式对话（GPT-4o）
 *   4. 流式对话（Claude Sonnet）
 *   5. 双计费体系统一报告
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import {
  CopilotProvider,
  authenticateCopilot,
  UsageMonitor,
} from './provider/index.ts'
import type { CopilotAuth, CopilotModelInfo } from './provider/index.ts'

const TOKEN_FILE = '.copilot-token'

// ============================================================
//  辅助
// ============================================================

async function getOrCreateToken(): Promise<string> {
  // 尝试从文件读取已保存的 token
  if (existsSync(TOKEN_FILE)) {
    const saved = readFileSync(TOKEN_FILE, 'utf-8').trim()
    if (saved) {
      console.log(`✓ 从 ${TOKEN_FILE} 加载已保存的 token`)
      return saved
    }
  }

  // 走 OAuth Device Flow
  console.log('首次使用，需要 GitHub 授权...\n')
  const auth: CopilotAuth = await authenticateCopilot((userCode, verificationUri) => {
    console.log('╔══════════════════════════════════════════════╗')
    console.log('║  GitHub Copilot 授权                        ║')
    console.log('╠══════════════════════════════════════════════╣')
    console.log(`║  请在浏览器中打开:                          ║`)
    console.log(`║  ${verificationUri.padEnd(43)}║`)
    console.log(`║                                              ║`)
    console.log(`║  输入授权码: ${userCode.padEnd(33)}║`)
    console.log('╚══════════════════════════════════════════════╝')

    // 尝试自动打开浏览器
    try {
      if (process.platform === 'win32') {
        execSync(`start ${verificationUri}`, { stdio: 'ignore' })
      } else if (process.platform === 'darwin') {
        execSync(`open ${verificationUri}`, { stdio: 'ignore' })
      } else {
        execSync(`xdg-open ${verificationUri}`, { stdio: 'ignore' })
      }
      console.log('（已自动打开浏览器）\n')
    } catch {
      console.log('（请手动在浏览器中打开上面的链接）\n')
    }
  })

  // 保存 token
  writeFileSync(TOKEN_FILE, auth.accessToken)
  console.log(`✓ Token 已保存到 ${TOKEN_FILE}\n`)

  return auth.accessToken
}

// ============================================================
//  测试
// ============================================================

async function main() {
  console.log('=== GitHub Copilot Provider 测试 ===\n')

  // ---- 1. 认证 ----
  console.log('--- 1. 认证 ---')
  const token = await getOrCreateToken()
  console.log(`  Token: ${token.slice(0, 8)}...${token.slice(-4)}\n`)

  // ---- 2. 创建 Provider ----
  const copilot = new CopilotProvider({ token })
  const monitor = new UsageMonitor()
  monitor.attachCopilot(copilot.usage)

  // ---- 3. 列出模型 ----
  console.log('--- 2. 可用模型 ---')
  try {
    const models: CopilotModelInfo[] = await copilot.listModelsDetailed()
    console.log(`  共 ${models.length} 个模型:\n`)
    for (const m of models) {
      const caps: string[] = []
      if (m.supportsVision) caps.push('vision')
      if (m.supportsToolCalls) caps.push('tools')
      if (m.supportsStreaming) caps.push('stream')
      console.log(`  ${m.id.padEnd(30)} ${m.name.padEnd(25)} ctx=${m.maxContextTokens} out=${m.maxOutputTokens} [${caps.join(',')}]`)
    }
    console.log()
  } catch (e) {
    console.log(`  模型列表获取失败: ${(e as Error).message}\n`)
  }

  // ---- 4. 非流式对话 ----
  console.log('--- 3. 非流式对话 (gpt-4o) ---')
  try {
    const response = await copilot.chat({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: '你是一个简洁的助手。回答限制在 50 字以内。' },
        { role: 'user', content: '用一句话解释什么是多 Agent 协作系统。' },
      ],
      max_tokens: 200,
    })

    const reply = response.choices[0]?.message?.content ?? '(empty)'
    console.log(`  模型: ${response.model}`)
    console.log(`  回复: ${reply}`)
    if (response.usage) {
      console.log(`  Tokens: prompt=${response.usage.prompt_tokens} completion=${response.usage.completion_tokens} total=${response.usage.total_tokens}`)
    }
    if (response.latencyMs !== undefined) {
      console.log(`  延迟: ${response.latencyMs}ms`)
    }
    console.log()
  } catch (e) {
    console.log(`  非流式对话失败: ${(e as Error).message}\n`)
  }

  // ---- 5. 流式对话 ----
  console.log('--- 4. 流式对话 (claude-haiku-4.5) ---')
  try {
    process.stdout.write('  回复: ')
    let streamModel = ''
    let streamTTFT: number | undefined
    for await (const chunk of copilot.chatStream({
      model: 'claude-haiku-4.5',
      messages: [
        { role: 'system', content: '你是一个编程助手。回答简洁，限制在 80 字以内。' },
        { role: 'user', content: '用 TypeScript 写一个计算斐波那契数列第 n 项的函数。' },
      ],
      max_tokens: 300,
    })) {
      if (!streamModel && chunk.model) streamModel = chunk.model
      if (streamTTFT === undefined && chunk.latencyMs !== undefined) streamTTFT = chunk.latencyMs
      const text = chunk.choices?.[0]?.delta?.content
      if (text) process.stdout.write(text)
    }
    console.log(`\n  模型: ${streamModel}`)
    if (streamTTFT !== undefined) console.log(`  TTFT(首 token 延迟): ${streamTTFT}ms`)
    console.log()
  } catch (e) {
    console.log(`\n  流式对话失败: ${(e as Error).message}\n`)
    // 如果 claude-haiku-4-5 不可用，尝试 gpt-4o
    console.log('  降级尝试 gpt-4o 流式...')
    try {
      process.stdout.write('  回复: ')
      for await (const chunk of copilot.chatStream({
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: '用 TypeScript 写一个 fibonacci 函数，不超过 3 行。' },
        ],
        max_tokens: 200,
      })) {
        const text = chunk.choices?.[0]?.delta?.content
        if (text) process.stdout.write(text)
      }
      console.log('\n')
    } catch (e2) {
      console.log(`\n  gpt-4o 流式也失败: ${(e2 as Error).message}\n`)
    }
  }

  // ---- 6. 双计费体系报告 ----
  console.log('--- 5. 双计费体系统一报告 ---')
  console.log(monitor.printReport())

  // ---- 7. Copilot 详细统计 ----
  console.log('--- 6. Copilot 使用 & 延迟统计 ---')
  const stats = copilot.usage.getStats()
  console.log(`计费模型: ${stats.billingModel}`)
  console.log(`Provider: ${stats.providerName}`)
  console.log(`调用次数（计费维度）: ${stats.requestCount} 次`)
  console.log('Token 监控（不参与计费）:', JSON.stringify(stats.monitoredTokens, null, 2))
  const lat = stats.latency
  if (lat.count > 0) {
    console.log(`延迟: avg=${lat.avgMs}ms / p95=${lat.p95Ms}ms / min=${lat.minMs}ms / max=${lat.maxMs}ms`)
  }

  console.log('\n=== 所有测试完成 ===')
}

main().catch((e) => {
  console.error('测试失败:', e)
  process.exit(1)
})
