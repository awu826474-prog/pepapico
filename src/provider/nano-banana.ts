/**
 * NanoBanana 图像生成 Provider
 * 支持 grsai 的 nano-banana 系列模型
 */

import type {
  ImageProvider,
  ImageGenerateRequest,
  ImageGenerateProgress,
  ProviderConfig,
} from './types.ts'
import { ProxyAgent, fetch as undiciFetch } from 'undici'

function getProxyUrl(): string | undefined {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    undefined
  )
}

let proxyAgent: ProxyAgent | undefined
function getProxyAgent(): ProxyAgent | undefined {
  const url = getProxyUrl()
  if (!url) return undefined
  if (!proxyAgent) proxyAgent = new ProxyAgent(url)
  return proxyAgent
}

export class NanoBananaProvider implements ImageProvider {
  readonly name: string
  private config: ProviderConfig

  constructor(name: string, config: ProviderConfig) {
    this.name = name
    this.config = {
      timeout: 120_000, // 图像生成较慢
      ...config,
    }
  }

  async *generate(
    request: ImageGenerateRequest,
  ): AsyncIterable<ImageGenerateProgress> {
    const body = {
      model: request.model,
      prompt: request.prompt,
      urls: request.urls,
      aspectRatio: request.aspectRatio ?? 'auto',
      imageSize: request.imageSize ?? '1K',
      shutProgress: false,
    }

    const res = await this.fetch('/v1/draw/nano-banana', body)

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`[${this.name}] API error ${res.status}: ${errText}`)
    }

    if (!res.body) {
      throw new Error(`[${this.name}] Response body is null`)
    }

    // 流式 SSE 解析
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue

          // 尝试 SSE "data: ..." 格式
          let jsonStr = trimmed
          if (trimmed.startsWith('data: ')) {
            jsonStr = trimmed.slice(6)
          }
          if (jsonStr === '[DONE]') return

          try {
            const parsed = JSON.parse(jsonStr) as ImageGenerateProgress
            yield parsed
            if (parsed.status === 'succeeded' || parsed.status === 'failed') {
              return
            }
          } catch {
            // 可能是非 JSON 行，跳过
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  async getResult(taskId: string): Promise<ImageGenerateProgress> {
    const res = await this.fetch('/v1/draw/result', { id: taskId })

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`[${this.name}] API error ${res.status}: ${errText}`)
    }

    const json = (await res.json()) as {
      code: number
      msg: string
      data: ImageGenerateProgress
    }

    if (json.code !== 0) {
      throw new Error(`[${this.name}] result error: ${json.msg}`)
    }

    return json.data
  }

  private fetch(path: string, body: unknown): Promise<Response> {
    const url = `${this.config.baseURL.replace(/\/+$/, '')}${path}`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
      ...this.config.headers,
    }

    const agent = getProxyAgent()
    const opts: Record<string, unknown> = {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeout!),
    }
    if (agent) opts.dispatcher = agent

    return undiciFetch(url, opts as never) as unknown as Promise<Response>
  }
}
