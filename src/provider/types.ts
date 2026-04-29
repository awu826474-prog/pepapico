/**
 * 统一 Provider 类型定义
 * 所有模型 API 适配器遵循此接口
 */

// ---- 消息类型 ----

export type ContentPartText = {
  type: 'text'
  text: string
}

export type ContentPartImage = {
  type: 'image_url'
  image_url: {
    url: string // base64 data URI 或 http(s) URL
    detail?: 'auto' | 'low' | 'high'
  }
}

export type ContentPart = ContentPartText | ContentPartImage

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ChatMessage {
  role: MessageRole
  content: string | ContentPart[]
  name?: string
  tool_call_id?: string // role=tool 时关联的 tool_call id
  tool_calls?: ToolCall[] // role=assistant 时模型返回的工具调用
}

// ---- Tool / Function Calling ----

export interface ToolFunction {
  name: string
  description?: string
  parameters: Record<string, unknown> // JSON Schema
}

export interface ToolDefinition {
  type: 'function'
  function: ToolFunction
}

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string // JSON string
  }
}

// ---- 请求 ----

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } }
  temperature?: number
  max_tokens?: number
  top_p?: number
  stream?: boolean
  stop?: string | string[]
  response_format?: { type: 'text' | 'json_object' }
}

// ---- 响应 ----

export interface ChatChoice {
  index: number
  message: ChatMessage
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null
}

export interface TokenUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export interface ChatResponse {
  id: string
  model: string
  choices: ChatChoice[]
  usage?: TokenUsage
  created: number
  /** 请求延迟（毫秒），由 Provider 自动填充 */
  latencyMs?: number
}

// ---- 流式响应 ----

export interface StreamDelta {
  role?: MessageRole
  content?: string
  tool_calls?: Partial<ToolCall>[]
}

export interface ChatStreamChunk {
  id: string
  model: string
  choices: {
    index: number
    delta: StreamDelta
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null
  }[]
  usage?: TokenUsage
  /** 首 token 延迟（TTFT）或总延迟，由 Provider 在流结束时填充 */
  latencyMs?: number
}

// ---- 延迟统计 ----

export interface LatencyStats {
  /** 请求总数 */
  count: number
  /** 总延迟（ms） */
  totalMs: number
  /** 最小延迟（ms） */
  minMs: number
  /** 最大延迟（ms） */
  maxMs: number
  /** 平均延迟（ms） */
  avgMs: number
  /** P95 延迟（ms） */
  p95Ms: number
  /** 所有延迟记录（用于计算百分位数） */
  samples: number[]
}

/** 延迟跟踪器 — 可嵌入任何 Provider 或 UsageTracker */
export class LatencyTracker {
  private samples: number[] = []

  record(ms: number): void {
    this.samples.push(ms)
  }

  getStats(): LatencyStats {
    if (this.samples.length === 0) {
      return { count: 0, totalMs: 0, minMs: 0, maxMs: 0, avgMs: 0, p95Ms: 0, samples: [] }
    }
    const sorted = [...this.samples].sort((a, b) => a - b)
    const total = sorted.reduce((s, v) => s + v, 0)
    const p95Idx = Math.min(Math.ceil(sorted.length * 0.95) - 1, sorted.length - 1)
    return {
      count: sorted.length,
      totalMs: total,
      minMs: sorted[0],
      maxMs: sorted[sorted.length - 1],
      avgMs: Math.round(total / sorted.length),
      p95Ms: sorted[p95Idx],
      samples: [...this.samples],
    }
  }

  reset(): void {
    this.samples = []
  }
}

// ---- Provider 配置 ----

export interface ProviderConfig {
  apiKey: string
  baseURL: string
  defaultModel?: string
  headers?: Record<string, string>
  timeout?: number // ms
}

// ---- Provider 接口 ----

export interface ModelProvider {
  readonly name: string

  /** 非流式对话 */
  chat(request: ChatRequest): Promise<ChatResponse>

  /** 流式对话，返回 AsyncIterable of chunks */
  chatStream(request: ChatRequest): AsyncIterable<ChatStreamChunk>

  /** 列出可用模型（如果 API 支持） */
  listModels?(): Promise<string[]>
}

// ---- 图像生成类型 ----

export interface ImageGenerateRequest {
  model: string
  prompt: string
  urls?: string[] // 参考图 URL 或 base64
  aspectRatio?: string
  imageSize?: '1K' | '2K' | '4K'
}

export interface ImageGenerateResult {
  url: string
  content: string
}

export interface ImageGenerateProgress {
  id: string
  progress: number
  status: 'running' | 'succeeded' | 'failed'
  results?: ImageGenerateResult[]
  failure_reason?: string
  error?: string
}

export interface ImageProvider {
  readonly name: string

  /** 提交图像生成任务（流式进度） */
  generate(request: ImageGenerateRequest): AsyncIterable<ImageGenerateProgress>

  /** 通过任务 ID 查询结果 */
  getResult(taskId: string): Promise<ImageGenerateProgress>
}
