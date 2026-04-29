/**
 * GitHub Copilot Provider
 *
 * 通过 GitHub OAuth Device Flow 认证，使用 Copilot API 调用模型。
 * API 格式兼容 OpenAI Chat Completions，但需要特殊 headers。
 *
 * 认证流程（照搬 opencode）：
 * 1. POST github.com/login/device/code → 获取 user_code + device_code
 * 2. 用户在浏览器输入 user_code 授权
 * 3. 轮询 POST github.com/login/oauth/access_token → 获取 access_token
 * 4. 用 access_token 调用 api.githubcopilot.com
 *
 * Copilot 计费：
 * - 通过 GitHub 订阅（Pro/Pro+/Enterprise）计费，不按 token 收费
 * - 但有速率限制和 token 额度
 * - 与 OpenRouter 的 per-token 计费完全独立
 */

import type {
  ModelProvider,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  TokenUsage,
} from './types.ts'
import { LatencyTracker } from './types.ts'
import { SubscriptionBillingTracker } from './usage.ts'
import { ProxyAgent, fetch as undiciFetch } from 'undici'

// ============================================================
//  常量
// ============================================================

/** opencode 注册的 GitHub OAuth App Client ID */
const GITHUB_CLIENT_ID = 'Ov23li8tweQw6odWQebz'
const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code'
const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const COPILOT_API_BASE = 'https://api.githubcopilot.com'
const USER_AGENT = 'byte-cp/0.1.0'

// ============================================================
//  代理
// ============================================================

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

function doFetch(url: string, init: Record<string, unknown>): Promise<Response> {
  const agent = getProxyAgent()
  if (agent) init.dispatcher = agent
  return undiciFetch(url, init as never) as unknown as Promise<Response>
}

// ============================================================
//  OAuth Device Flow
// ============================================================

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

export interface CopilotAuth {
  /** GitHub OAuth access token — 长期有效，不需要 refresh */
  accessToken: string
}

/**
 * Step 1: 请求设备码
 * 返回 user_code 和 verification_uri，用户需要在浏览器中输入
 */
export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const res = await doFetch(GITHUB_DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      scope: 'read:user',
    }),
  })

  if (!res.ok) {
    throw new Error(`GitHub device code request failed: ${res.status} ${await res.text()}`)
  }

  return (await res.json()) as DeviceCodeResponse
}

/**
 * Step 2: 轮询等待用户授权
 * 用户在浏览器完成授权后，此函数返回 access_token
 *
 * @param deviceCode  requestDeviceCode() 返回的 device_code
 * @param interval    轮询间隔（秒），来自 requestDeviceCode() 的 interval
 * @param expiresIn   超时时间（秒），来自 requestDeviceCode() 的 expires_in
 * @param onPoll      每次轮询时回调（用于显示进度）
 */
export async function pollForToken(
  deviceCode: string,
  interval: number,
  expiresIn: number,
  onPoll?: (status: string) => void,
): Promise<CopilotAuth> {
  const deadline = Date.now() + expiresIn * 1000
  let pollInterval = (interval + 1) * 1000 // 加 1 秒安全边际

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollInterval))

    const res = await doFetch(GITHUB_ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    })

    const data = (await res.json()) as Record<string, string>

    if (data.access_token) {
      return { accessToken: data.access_token }
    }

    if (data.error === 'authorization_pending') {
      onPoll?.('等待用户授权...')
      continue
    }

    if (data.error === 'slow_down') {
      // GitHub 要求放慢轮询
      pollInterval += 5000
      onPoll?.('放慢轮询速度...')
      continue
    }

    if (data.error === 'expired_token') {
      throw new Error('设备码已过期，请重新发起认证')
    }

    if (data.error === 'access_denied') {
      throw new Error('用户拒绝了授权')
    }

    throw new Error(`OAuth 错误: ${data.error} - ${data.error_description ?? ''}`)
  }

  throw new Error('轮询超时，用户未在规定时间内完成授权')
}

/**
 * 一步完成 OAuth Device Flow
 * 打印 user_code 和 verification_uri，等用户授权
 */
export async function authenticateCopilot(
  onPrompt?: (userCode: string, verificationUri: string) => void,
): Promise<CopilotAuth> {
  const deviceData = await requestDeviceCode()

  if (onPrompt) {
    onPrompt(deviceData.user_code, deviceData.verification_uri)
  } else {
    console.log(`\n请在浏览器中打开: ${deviceData.verification_uri}`)
    console.log(`输入授权码: ${deviceData.user_code}\n`)
  }

  return pollForToken(
    deviceData.device_code,
    deviceData.interval,
    deviceData.expires_in,
    (status) => console.log(`  [Copilot Auth] ${status}`),
  )
}

// ============================================================
//  Copilot 模型发现
// ============================================================

export interface CopilotModelInfo {
  id: string
  name: string
  version: string
  supportedEndpoints: string[]
  maxContextTokens: number
  maxOutputTokens: number
  supportsVision: boolean
  supportsToolCalls: boolean
  supportsStreaming: boolean
}

/**
 * 从 Copilot API 获取可用模型列表
 */
export async function listCopilotModels(token: string): Promise<CopilotModelInfo[]> {
  const res = await doFetch(`${COPILOT_API_BASE}/models`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
  })

  if (!res.ok) {
    throw new Error(`Copilot models API failed: ${res.status} ${await res.text()}`)
  }

  const json = (await res.json()) as {
    data: {
      id: string
      name: string
      version: string
      supported_endpoints?: string[]
      capabilities?: {
        limits?: {
          max_context_window_tokens?: number
          max_output_tokens?: number
        }
        supports?: {
          vision?: boolean
          tool_calls?: boolean
          streaming?: boolean
        }
      }
    }[]
  }

  return json.data.map((m) => ({
    id: m.id,
    name: m.name,
    version: m.version,
    supportedEndpoints: m.supported_endpoints ?? [],
    maxContextTokens: m.capabilities?.limits?.max_context_window_tokens ?? 0,
    maxOutputTokens: m.capabilities?.limits?.max_output_tokens ?? 0,
    supportsVision: m.capabilities?.supports?.vision ?? false,
    supportsToolCalls: m.capabilities?.supports?.tool_calls ?? false,
    supportsStreaming: m.capabilities?.supports?.streaming ?? true,
  }))
}

// ============================================================
//  CopilotProvider — 实现 ModelProvider 接口
// ============================================================

export interface CopilotProviderConfig {
  /** GitHub OAuth token（来自 Device Flow 或直接提供） */
  token: string
  /** Copilot API 基础 URL（默认 https://api.githubcopilot.com） */
  baseURL?: string
  /** 请求超时（ms） */
  timeout?: number
  /** 是否标记为 agent 请求 */
  isAgent?: boolean
}

export class CopilotProvider implements ModelProvider {
  readonly name = 'copilot'
  private config: Required<Omit<CopilotProviderConfig, 'isAgent'>> & { isAgent: boolean }
  readonly usage = new SubscriptionBillingTracker('copilot')
  /** 延迟跟踪器 — 复用 usage.latency，保证 UsageMonitor 能读取 */
  get latency() { return this.usage.latency }

  constructor(config: CopilotProviderConfig) {
    this.config = {
      baseURL: COPILOT_API_BASE,
      timeout: 120_000,
      isAgent: false,
      ...config,
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body = { ...request, stream: false }
    const t0 = Date.now()
    const res = await this.fetch('/chat/completions', body)

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`[Copilot] API error ${res.status}: ${errText}`)
    }

    const response = (await res.json()) as ChatResponse
    const latencyMs = Date.now() - t0
    response.latencyMs = latencyMs
    this.usage.record(response.usage as never, latencyMs)
    return response
  }

  async *chatStream(request: ChatRequest): AsyncIterable<ChatStreamChunk> {
    const body = { ...request, stream: true }
    const t0 = Date.now()
    let ttft: number | undefined
    const res = await this.fetch('/chat/completions', body)

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`[Copilot] API error ${res.status}: ${errText}`)
    }

    if (!res.body) throw new Error('[Copilot] Response body is null')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let lastUsage: TokenUsage | undefined

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
            this.usage.record(lastUsage as never, Date.now() - t0)
            return
          }
          try {
            const chunk = JSON.parse(data) as ChatStreamChunk
            if (ttft === undefined) {
              ttft = Date.now() - t0
              chunk.latencyMs = ttft
            }
            if (chunk.usage) lastUsage = chunk.usage
            yield chunk
          } catch {
            // skip malformed JSON
          }
        }
      }
      this.usage.record(lastUsage as never, Date.now() - t0)
    } finally {
      reader.releaseLock()
    }
  }

  async listModels(): Promise<string[]> {
    const models = await listCopilotModels(this.config.token)
    return models.map((m) => m.id)
  }

  /** 获取详细模型信息 */
  async listModelsDetailed(): Promise<CopilotModelInfo[]> {
    return listCopilotModels(this.config.token)
  }

  private hasVisionContent(request: ChatRequest): boolean {
    return request.messages.some(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((p) => p.type === 'image_url'),
    )
  }

  private fetch(path: string, body: unknown): Promise<Response> {
    const url = `${this.config.baseURL.replace(/\/+$/, '')}${path}`

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.token}`,
      'User-Agent': USER_AGENT,
      'Openai-Intent': 'conversation-edits',
      'x-initiator': this.config.isAgent ? 'agent' : 'user',
    }

    // 如果请求包含图片，加上 vision header
    if (typeof body === 'object' && body !== null) {
      const req = body as ChatRequest
      if (this.hasVisionContent(req)) {
        headers['Copilot-Vision-Request'] = 'true'
      }
    }

    return doFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeout),
    })
  }
}
