/**
 * 多模型多供应商测试脚本
 * 1. OpenRouter: deepseek/deepseek-chat-v3-0324
 * 2. OpenRouter: deepseek/deepseek-v3.2
 * 3. grsai NanoBanana: 图片发送与接收
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createOpenRouter, createNanoBanana } from './provider/index.ts'
import type { ImageGenerateProgress } from './provider/index.ts'

const OPENROUTER_KEY =
  process.env.OPENROUTER_API_KEY ||
  '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'
const GRSAI_KEY =
  process.env.GRSAI_API_KEY || 'sk-4bd8883789a54808a667fb97b3f35e9f'

// ---- Test: OpenRouter 多模型切换 ----

async function testChatModel(modelId: string) {
  console.log(`\n${'='.repeat(50)}`)
  console.log(`模型: ${modelId}`)
  console.log(`发送: 你好，请用一句话介绍你自己\n`)

  const provider = createOpenRouter(OPENROUTER_KEY)

  const response = await provider.chat({
    model: modelId,
    messages: [{ role: 'user', content: '你好，请用一句话介绍你自己' }],
    max_tokens: 200,
  })

  const reply = response.choices[0]?.message?.content
  console.log(`回复: ${reply}`)
  console.log(
    `Tokens: ${response.usage?.prompt_tokens}→${response.usage?.completion_tokens} (${response.usage?.total_tokens})`,
  )
  console.log(`✓ ${modelId} 测试通过`)
}

// ---- Test: NanoBanana 图片发送 + 接收 ----

async function testNanoBanana() {
  console.log(`\n${'='.repeat(50)}`)
  console.log(`供应商: grsai NanoBanana`)
  console.log(`模型: nano-banana-fast`)

  // 读取小猪佩奇图片 → base64
  const imgPath = resolve('docs/reference/img/images (1).jpg')
  const imgBuf = readFileSync(imgPath)
  const b64 = `data:image/jpeg;base64,${imgBuf.toString('base64')}`
  console.log(`发送图片: ${imgPath} (${(imgBuf.length / 1024).toFixed(1)} KB)`)
  console.log(`提示词: 把这只小猪佩奇变成赛博朋克风格\n`)

  const provider = createNanoBanana(GRSAI_KEY)

  let finalResult: ImageGenerateProgress | null = null

  for await (const progress of provider.generate({
    model: 'nano-banana-fast',
    prompt: '把这只小猪佩奇变成赛博朋克风格',
    urls: [b64],
    imageSize: '1K',
  })) {
    if (progress.progress !== undefined) {
      process.stdout.write(`\r进度: ${progress.progress}% [${progress.status}]`)
    }
    finalResult = progress
  }

  console.log('') // 换行

  if (finalResult?.status === 'succeeded' && finalResult.results?.length) {
    console.log(`\n生成成功！`)
    for (const r of finalResult.results) {
      if (r.url) console.log(`  图片URL: ${r.url}`)
      if (r.content) console.log(`  描述: ${r.content}`)
    }
    console.log(`✓ NanoBanana 图片发送+接收测试通过`)
  } else {
    console.log(`\n生成结果:`, JSON.stringify(finalResult, null, 2))
    if (finalResult?.status === 'failed') {
      console.log(
        `✗ 失败: ${finalResult.failure_reason} - ${finalResult.error}`,
      )
    }
  }
}

// ---- Main ----

async function main() {
  console.log('=== 多模型多供应商切换测试 ===')

  // Test 1: DeepSeek Chat V3
  await testChatModel('deepseek/deepseek-chat-v3-0324')

  // Test 2: DeepSeek V3.2
  await testChatModel('deepseek/deepseek-v3.2')

  // Test 3: NanoBanana 图片
  await testNanoBanana()

  console.log(`\n${'='.repeat(50)}`)
  console.log('所有测试完成')
}

main().catch((err) => {
  console.error('\n测试失败:', err.message)
  process.exit(1)
})
