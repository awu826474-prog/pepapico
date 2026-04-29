/**
 * 计费体系 — 多 Provider 统一 Usage 监控
 *
 * 两类计费模型完全独立，不可混用：
 *
 * ┌──────────────────────────────────────────────────────────┐
 * │ TokenBillingTracker  (按 token 计费)                      │
 * │   OpenRouter / OpenAI / DeepSeek / Groq 等               │
 * │   每个 API Key 独立实例，按 token 数×单价计算美元费用       │
 * ├──────────────────────────────────────────────────────────┤
 * │ SubscriptionBillingTracker  (订阅制 / 按次计费)            │
 * │   GitHub Copilot / Cursor 等                              │
 * │   计费单位：调用次数（月费订阅）                            │
 * │   token 仅作配额感知监控，不参与计费                        │
 * └──────────────────────────────────────────────────────────┘
 *
 * UsageMonitor 可管理任意数量的 token 计费 provider
 * 和任意数量的订阅制 provider，统一出报告
 */

import type { TokenUsage, LatencyStats } from './types.ts'
import { LatencyTracker } from './types.ts'

// ============================================================
//  按 Token 计费（通用：OpenRouter / OpenAI / DeepSeek / Groq 等）
// ============================================================

export interface TokenBillingStats {
  readonly billingModel: 'per_token'
  providerName: string
  totalPromptTokens: number
  totalCompletionTokens: number
  totalTokens: number
  requestCount: number
  /** 估算费用（美元）— 需调用方传入 costUSD 才准确 */
  estimatedCostUSD: number
  latency: LatencyStats
}

/**
 * 按 token 计费跟踪器
 * 每个 API Key / Provider 独立实例，互不干扰
 */
export class TokenBillingTracker {
  readonly billingModel = 'per_token' as const
  readonly providerName: string
  private _prompt = 0
  private _completion = 0
  private _total = 0
  private _requests = 0
  private _costUSD = 0
  readonly latency = new LatencyTracker()

  constructor(providerName: string) {
    this.providerName = providerName
  }

  record(usage: TokenUsage, costUSD?: number, latencyMs?: number): void {
    this._prompt += usage.prompt_tokens
    this._completion += usage.completion_tokens
    this._total += usage.total_tokens
    this._requests++
    if (costUSD !== undefined) this._costUSD += costUSD
    if (latencyMs !== undefined) this.latency.record(latencyMs)
  }

  getStats(): TokenBillingStats {
    return {
      billingModel: 'per_token',
      providerName: this.providerName,
      totalPromptTokens: this._prompt,
      totalCompletionTokens: this._completion,
      totalTokens: this._total,
      requestCount: this._requests,
      estimatedCostUSD: this._costUSD,
      latency: this.latency.getStats(),
    }
  }

  reset(): void {
    this._prompt = 0; this._completion = 0; this._total = 0
    this._requests = 0; this._costUSD = 0
    this.latency.reset()
  }
}

/** 向后兼容别名 */
export type OpenRouterUsageStats = TokenBillingStats
export class OpenRouterUsageTracker extends TokenBillingTracker {
  constructor(name = 'openrouter') { super(name) }
}

// ============================================================
//  订阅制 / 按次计费（GitHub Copilot 等）
// ============================================================

export interface SubscriptionBillingStats {
  readonly billingModel: 'subscription'
  providerName: string
  /** 已调用次数 — 真正的计费维度 */
  requestCount: number
  /** Token 监控（不参与计费，仅用于配额感知） */
  monitoredTokens: {
    prompt: number
    completion: number
    total: number
    cached: number
    reasoning: number
  }
  latency: LatencyStats
}

/**
 * 订阅制计费跟踪器
 * 计费维度是调用次数（月费订阅覆盖），token 数仅供监控
 */
export class SubscriptionBillingTracker {
  readonly billingModel = 'subscription' as const
  readonly providerName: string
  private _requests = 0
  private _tokens = { prompt: 0, completion: 0, total: 0, cached: 0, reasoning: 0 }
  readonly latency = new LatencyTracker()

  constructor(providerName: string) {
    this.providerName = providerName
  }

  /**
   * 记录一次调用
   * @param usage    API 返回的 token 使用（可选，不影响计费）
   * @param latencyMs 本次请求延迟（ms）
   */
  record(
    usage?: TokenUsage & {
      prompt_tokens_details?: { cached_tokens?: number }
      reasoning_tokens?: number
    },
    latencyMs?: number,
  ): void {
    this._requests++
    if (usage) {
      this._tokens.prompt += usage.prompt_tokens
      this._tokens.completion += usage.completion_tokens
      this._tokens.total += usage.total_tokens
      this._tokens.cached += usage.prompt_tokens_details?.cached_tokens ?? 0
      this._tokens.reasoning += usage.reasoning_tokens ?? 0
    }
    if (latencyMs !== undefined) this.latency.record(latencyMs)
  }

  getStats(): SubscriptionBillingStats {
    return {
      billingModel: 'subscription',
      providerName: this.providerName,
      requestCount: this._requests,
      monitoredTokens: { ...this._tokens },
      latency: this.latency.getStats(),
    }
  }

  reset(): void {
    this._requests = 0
    this._tokens = { prompt: 0, completion: 0, total: 0, cached: 0, reasoning: 0 }
    this.latency.reset()
  }
}

// ============================================================
//  统一监控视图
// ============================================================

export interface UnifiedUsageReport {
  /** 所有按 token 计费 provider 的统计（每个 API Key 独立） */
  tokenProviders: TokenBillingStats[]
  /** 所有订阅制 provider 的统计 */
  subscriptionProviders: SubscriptionBillingStats[]
  combined: {
    totalTokens: number
    totalRequests: number
    totalEstimatedCostUSD: number
    latency: LatencyStats
  }
}

export class UsageMonitor {
  private tokenTrackers = new Map<string, TokenBillingTracker>()
  private subscriptionTrackers = new Map<string, SubscriptionBillingTracker>()

  /** 注册按 token 计费的 provider（支持多个不同 API Key，各自独立统计） */
  attachTokenProvider(tracker: TokenBillingTracker): void {
    this.tokenTrackers.set(tracker.providerName, tracker)
  }

  /** 注册订阅制 provider */
  attachSubscriptionProvider(tracker: SubscriptionBillingTracker): void {
    this.subscriptionTrackers.set(tracker.providerName, tracker)
  }

  /** 向后兼容 */
  attachOpenRouter(tracker: TokenBillingTracker): void { this.attachTokenProvider(tracker) }
  attachCopilot(tracker: SubscriptionBillingTracker): void { this.attachSubscriptionProvider(tracker) }

  getReport(): UnifiedUsageReport {
    const tokenProviders = [...this.tokenTrackers.values()].map((t) => t.getStats())
    const subscriptionProviders = [...this.subscriptionTrackers.values()].map((t) => t.getStats())

    const combinedLatency = new LatencyTracker()
    for (const t of this.tokenTrackers.values())
      for (const s of t.latency.getStats().samples) combinedLatency.record(s)
    for (const t of this.subscriptionTrackers.values())
      for (const s of t.latency.getStats().samples) combinedLatency.record(s)

    return {
      tokenProviders,
      subscriptionProviders,
      combined: {
        totalTokens:
          tokenProviders.reduce((s, p) => s + p.totalTokens, 0) +
          subscriptionProviders.reduce((s, p) => s + p.monitoredTokens.total, 0),
        totalRequests:
          tokenProviders.reduce((s, p) => s + p.requestCount, 0) +
          subscriptionProviders.reduce((s, p) => s + p.requestCount, 0),
        totalEstimatedCostUSD: tokenProviders.reduce((s, p) => s + p.estimatedCostUSD, 0),
        latency: combinedLatency.getStats(),
      },
    }
  }

  printReport(): string {
    const r = this.getReport()
    const HR = '─'.repeat(50)
    let out = ''

    if (r.tokenProviders.length > 0) {
      out += `┌${HR}┐\n`
      out += `│  按 Token 计费 Provider                            │\n`
      for (const p of r.tokenProviders) {
        out += `├${HR}┤\n`
        out += `│  [${p.providerName}]\n`
        out += `│    Prompt:     ${p.totalPromptTokens} tokens\n`
        out += `│    Completion: ${p.totalCompletionTokens} tokens\n`
        out += `│    总计:       ${p.totalTokens} tokens\n`
        out += `│    请求数:     ${p.requestCount}\n`
        out += `│    估算费用:   $${p.estimatedCostUSD.toFixed(6)}\n`
        if (p.latency.count > 0) {
          out += `│    延迟: avg=${p.latency.avgMs}ms / p95=${p.latency.p95Ms}ms / min=${p.latency.minMs}ms / max=${p.latency.maxMs}ms\n`
        }
      }
      out += `└${HR}┘\n`
    }

    if (r.subscriptionProviders.length > 0) {
      out += `┌${HR}┐\n`
      out += `│  订阅制 Provider（按次计费）                       │\n`
      for (const p of r.subscriptionProviders) {
        out += `├${HR}┤\n`
        out += `│  [${p.providerName}]\n`
        out += `│    调用次数（计费维度）: ${p.requestCount} 次\n`
        out += `│    Token 监控（不计费）:\n`
        out += `│      prompt:     ${p.monitoredTokens.prompt}\n`
        out += `│      completion: ${p.monitoredTokens.completion}\n`
        out += `│      cached:     ${p.monitoredTokens.cached}\n`
        if (p.monitoredTokens.reasoning > 0)
          out += `│      reasoning:  ${p.monitoredTokens.reasoning}\n`
        if (p.latency.count > 0) {
          out += `│    延迟: avg=${p.latency.avgMs}ms / p95=${p.latency.p95Ms}ms / min=${p.latency.minMs}ms / max=${p.latency.maxMs}ms\n`
        }
      }
      out += `└${HR}┘\n`
    }

    const cl = r.combined.latency
    out += `┌${HR}┐\n`
    out += `│  合计\n`
    out += `│    总请求数: ${r.combined.totalRequests}\n`
    out += `│    总 Token: ${r.combined.totalTokens}\n`
    out += `│    估算费用: $${r.combined.totalEstimatedCostUSD.toFixed(6)} (token 计费部分)\n`
    if (cl.count > 0)
      out += `│    综合延迟: avg=${cl.avgMs}ms / p95=${cl.p95Ms}ms / min=${cl.minMs}ms / max=${cl.maxMs}ms\n`
    out += `└${HR}┘\n`
    return out
  }
}
