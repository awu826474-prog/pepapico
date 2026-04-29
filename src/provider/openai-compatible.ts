/**
 * OpenAI 兼容 API Provider
 * 支持 OpenAI / OpenRouter / DeepSeek / Groq / 本地 Ollama 等所有兼容 API
 */

import type {
  ModelProvider,
  ProviderConfig,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
} from './types.ts'
import { LatencyTracker } from './types.ts'
import { ProxyAgent, fetch as undiciFetch } from 'undici'

/** 检测环境代理 URL */
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

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name: string
  private config: ProviderConfig
  readonly latency = new LatencyTracker()

  constructor(name: string, config: ProviderConfig) {
    this.name = name
    this.config = {
      timeout: 60_000,
      ...config,
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body = { ...request, stream: false }
    const t0 = Date.now()
    const res = await this.fetch('/chat/completions', body)

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`[${this.name}] API error ${res.status}: ${errText}`)
    }

    const response = (await res.json()) as ChatResponse
    const latencyMs = Date.now() - t0
    response.latencyMs = latencyMs
    this.latency.record(latencyMs)
    return response
  }

  async *chatStream(request: ChatRequest): AsyncIterable<ChatStreamChunk> {
    const body = { ...request, stream: true }
    const t0 = Date.now()
    let ttft: number | undefined   // Time To First Token
    const res = await this.fetch('/chat/completions', body)

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`[${this.name}] API error ${res.status}: ${errText}`)
    }

    if (!res.body) {
      throw new Error(`[${this.name}] Response body is null`)
    }

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
          if (!trimmed || !trimmed.startsWith('data: ')) continue
          const data = trimmed.slice(6)
          if (data === '[DONE]') {
            const totalMs = Date.now() - t0
            this.latency.record(totalMs)
            return
          }
          try {
            const chunk = JSON.parse(data) as ChatStreamChunk
            if (ttft === undefined) {
              ttft = Date.now() - t0
              chunk.latencyMs = ttft // TTFT on first chunk
            }
            yield chunk
          } catch {
            // skip malformed JSON
          }
        }
      }
    } finally {
      reader.releaseLock()
      // If [DONE] was never seen (e.g. connection cut), still record
      if (ttft !== undefined) {
        // already recorded in [DONE] branch above
      } else {
        this.latency.record(Date.now() - t0)
      }
    }
  }

  async listModels(): Promise<string[]> {
    const res = await this.fetch('/models', undefined, 'GET')
    if (!res.ok) return []
    const json = (await res.json()) as { data?: { id: string }[] }
    return json.data?.map((m) => m.id) ?? []
  }

  private fetch(
    path: string,
    body: unknown,
    method: 'GET' | 'POST' = 'POST',
  ): Promise<Response> {
    const url = `${this.config.baseURL.replace(/\/+$/, '')}${path}`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
      ...this.config.headers,
    }

    const agent = getProxyAgent()
    const opts: Record<string, unknown> = {
      method,
      headers,
      body: method === 'POST' ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.config.timeout!),
    }
    if (agent) opts.dispatcher = agent

    return undiciFetch(url, opts as never) as unknown as Promise<Response>
  }
}
