/**
 * ModelRouter — 模型路由调度器
 *
 * 根据任务类型 / 难度 / 标签自动为 Agent 分配 provider + model
 * 照搬 cc 的 coordinator 模式中"为 worker 分配模型"的思路
 */

import type { ModelProvider, ImageProvider } from '../provider/types.ts'
import {
  getProvider,
  getImageProvider,
  listProviders,
} from '../provider/registry.ts'

// ---- 任务类型 ----

export type TaskType = 'chat' | 'code' | 'search' | 'image' | 'analysis' | 'general'

// ---- 难度等级（6 级，动态多维评估）----

/**
 * 难度等级：6 级细化分层，通过多维度评分动态计算，不预设静态阈值
 *
 * trivial     (0-12)  : 极简，如"什么是变量"
 * easy        (13-28) : 基础，如"写一个反转字符串的函数"
 * moderate    (29-48) : 中等，如"实现带删除的二叉搜索树"
 * challenging (49-64) : 较难，如"O(1) LRU 缓存实现"
 * hard        (65-80) : 困难，如"设计分布式限流器"
 * expert      (81-100): 专家，如"带因果一致性的 CRDT 系统设计"
 */
export type DifficultyLevel =
  | 'trivial'
  | 'easy'
  | 'moderate'
  | 'challenging'
  | 'hard'
  | 'expert'

// ---- 难度评估 ----

export interface DifficultyFactors {
  /** 文本量与问题范围 (0-15) */
  textScope: number
  /** 技术词汇密度 (0-25) */
  technicalDepth: number
  /** 多步骤/条件链复杂度 (0-20) */
  multiStepComplexity: number
  /** 开放性/模糊度 (0-15) */
  ambiguity: number
  /** 算法/系统强度 (0-25) */
  algorithmicIntensity: number
}

export interface DifficultyAssessment {
  level: DifficultyLevel
  /** 总分 0-100，可用于跨次比较和排序 */
  score: number
  factors: DifficultyFactors
  /** 评估依据摘要 */
  rationale: string
}

// ---- 技术词汇库 ----

const _TERMS_PROG = [
  'function', 'class', 'interface', 'async', 'promise', 'closure', 'prototype', 'recursion',
  'pointer', 'memory', 'runtime', 'compile', 'thread', 'socket', 'middleware', 'callback',
  'iterator', 'generator', 'decorator', 'polymorphism', 'inheritance', 'encapsulation',
  '函数', '类', '接口', '异步', '递归', '线程', '进程', '中间件', '迭代器', '封装', '闭包',
]
const _TERMS_ALGO = [
  'dynamic programming', 'greedy', 'backtracking', 'divide and conquer', 'binary search',
  'topological sort', 'shortest path', 'minimum spanning tree', 'sliding window', 'two pointer',
  'union find', 'segment tree', 'trie', 'heap', 'hash table', 'graph traversal',
  '动态规划', '贪心', '回溯', '二分', '拓扑', '最短路', '哈希', '线段树', '并查集', '图遍历',
]
const _TERMS_SYS = [
  'distributed', 'consensus', 'replication', 'sharding', 'load balancing', 'fault tolerant',
  'high availability', 'cap theorem', 'acid', 'eventual consistency', 'microservice',
  'message queue', 'event sourcing', 'cqrs', 'rate limit', 'circuit breaker',
  '分布式', '共识', '分片', '负载均衡', '高可用', '微服务', '消息队列', '限流', '熔断',
]
const _TERMS_COMPLEXITY = [
  'o(n)', 'o(log n)', 'o(1)', 'o(n²)', 'o(n log n)', 'time complexity', 'space complexity',
  'amortized', 'np-hard', 'np-complete', 'polynomial', 'exponential',
  '时间复杂度', '空间复杂度', '均摊',
]
const _TERMS_MATH = [
  'proof', 'theorem', 'lemma', 'derivative', 'integral', 'matrix', 'vector',
  'probability', 'gradient', 'convex', 'linear programming', 'eigenvalue',
  '证明', '定理', '导数', '积分', '矩阵', '概率', '梯度', '凸优化',
]
const _MULTI_STEP = [
  'first', 'then', 'after', 'finally', 'step by step', 'pipeline',
  'multiple', 'sequence', 'chain', 'workflow', 'stage', 'phase',
  '首先', '然后', '接着', '最后', '步骤', '流程', '多个', '依次', '阶段',
]
const _AMBIGUITY = [
  'best way', 'optimal', 'efficient way', 'how should', 'recommend', 'suggest',
  'trade-off', 'pros and cons', 'design', 'architecture', 'strategy', 'pattern',
  '最好', '最优', '如何', '应该', '建议', '推荐', '设计', '架构', '权衡',
]
const _INTENSITY = [
  'production ready', 'scalable', 'concurrent', 'thread-safe', 'fault tolerant',
  'high performance', 'real-time', 'low latency', 'large scale', 'design system',
  '生产可用', '高并发', '线程安全', '容错', '高性能', '实时', '低延迟', '大规模', '系统设计',
]

/**
 * 多维度动态难度评估
 * 每次调用都重新计算，适合随对话上下文动态更新。
 * 随着对话轮次增加、问题细化，重复调用即可刷新评估结果。
 */
export function assessDifficulty(text: string): DifficultyAssessment {
  const lower = text.toLowerCase()
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length

  // ① 文本量与问题范围 (0-15)
  let textScope = 0
  if (wordCount >= 15) textScope = 3
  if (wordCount >= 50) textScope = 6
  if (wordCount >= 120) textScope = 9
  if (wordCount >= 250) textScope = 12
  if (wordCount >= 500) textScope = 15

  // ② 技术词汇密度 (0-25)
  const allTerms = [..._TERMS_PROG, ..._TERMS_ALGO, ..._TERMS_SYS, ..._TERMS_COMPLEXITY, ..._TERMS_MATH]
  const termHits = allTerms.filter((t) => lower.includes(t)).length
  let technicalDepth = 0
  if (termHits >= 1) technicalDepth = 5
  if (termHits >= 3) technicalDepth = 10
  if (termHits >= 6) technicalDepth = 15
  if (termHits >= 10) technicalDepth = 20
  if (termHits >= 15) technicalDepth = 25

  // ③ 多步骤/条件链 (0-20)
  const stepHits = _MULTI_STEP.filter((m) => lower.includes(m)).length
  const condCount = (lower.match(/\b(if|when|unless|except|otherwise|但如果|当|除非)\b/g) ?? []).length
  let multiStepComplexity = 0
  if (stepHits >= 1) multiStepComplexity = 4
  if (stepHits >= 2) multiStepComplexity = 8
  if (stepHits >= 4) multiStepComplexity = 13
  if (stepHits >= 6) multiStepComplexity = 17
  if (condCount >= 2) multiStepComplexity = Math.min(20, multiStepComplexity + 4)
  if (condCount >= 4) multiStepComplexity = Math.min(20, multiStepComplexity + 3)

  // ④ 开放性/模糊度 (0-15)
  const ambigHits = _AMBIGUITY.filter((m) => lower.includes(m)).length
  let ambiguity = 0
  if (ambigHits >= 1) ambiguity = 4
  if (ambigHits >= 2) ambiguity = 8
  if (ambigHits >= 4) ambiguity = 12
  if (ambigHits >= 6) ambiguity = 15

  // ⑤ 算法/系统强度 (0-25)
  const intensityHits = _INTENSITY.filter((m) => lower.includes(m)).length
  const complexityHits = _TERMS_COMPLEXITY.filter((t) => lower.includes(t)).length
  const algoHits = _TERMS_ALGO.filter((t) => lower.includes(t)).length
  const sysHits = _TERMS_SYS.filter((t) => lower.includes(t)).length
  const totalIntensity = intensityHits + complexityHits + algoHits
  let algorithmicIntensity = 0
  if (totalIntensity >= 1) algorithmicIntensity = 6
  if (totalIntensity >= 2) algorithmicIntensity = 12
  if (totalIntensity >= 4) algorithmicIntensity = 18
  if (totalIntensity >= 6) algorithmicIntensity = 22
  if (sysHits >= 2) algorithmicIntensity = Math.min(25, algorithmicIntensity + 5)

  const factors: DifficultyFactors = { textScope, technicalDepth, multiStepComplexity, ambiguity, algorithmicIntensity }
  const score = textScope + technicalDepth + multiStepComplexity + ambiguity + algorithmicIntensity

  let level: DifficultyLevel
  let rationale: string
  if (score <= 12) {
    level = 'trivial'; rationale = '极简问题，基本无技术要求'
  } else if (score <= 28) {
    level = 'easy'; rationale = '基础问题，涉及少量技术知识'
  } else if (score <= 48) {
    level = 'moderate'; rationale = '中等复杂度，需要具体技术实现'
  } else if (score <= 64) {
    level = 'challenging'; rationale = '较高复杂度，涉及多步骤或算法设计'
  } else if (score <= 80) {
    level = 'hard'; rationale = '困难，涉及系统设计或复杂算法'
  } else {
    level = 'expert'; rationale = '专家级，分布式/高并发/理论证明等领域'
  }

  return { level, score, factors, rationale }
}

/**
 * 快速难度推断（assessDifficulty 的包装）
 * 动态计算，不缓存，可随上下文演进重复调用
 */
export function inferDifficulty(text: string): DifficultyLevel {
  return assessDifficulty(text).level
}

// ---- 路由规则 ----

export interface RoutingRule {
  /** 匹配的任务类型 */
  taskType: TaskType | TaskType[]
  /** 匹配的难度范围（可选） */
  difficulty?: DifficultyLevel | DifficultyLevel[]
  /** 匹配的标签（可选，任意一个匹配即可） */
  tags?: string[]
  /** 路由目标：provider 名称 */
  provider: string
  /** 路由目标：model 名称 */
  model: string
  /** 优先级（数字越大优先级越高） */
  priority?: number
}

// ---- 路由请求 ----

export interface RoutingRequest {
  taskType: TaskType
  difficulty?: DifficultyLevel
  tags?: string[]
  /** 用户强制指定的 model（优先级最高） */
  preferredModel?: string
  /** 用户强制指定的 provider（优先级最高） */
  preferredProvider?: string
}

// ---- 路由结果 ----

export interface RoutingResult {
  provider: string
  model: string
  /** 匹配到的规则（null 表示 fallback） */
  matchedRule: RoutingRule | null
}

// ---- ModelRouter ----

export class ModelRouter {
  private rules: RoutingRule[] = []
  private fallbackProvider = ''
  private fallbackModel = ''

  constructor() {}

  /** 设置 fallback（无规则匹配时使用） */
  setFallback(provider: string, model: string): this {
    this.fallbackProvider = provider
    this.fallbackModel = model
    return this
  }

  /** 添加路由规则 */
  addRule(rule: RoutingRule): this {
    this.rules.push(rule)
    // 按优先级降序排序
    this.rules.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    return this
  }

  /** 批量添加规则 */
  addRules(rules: RoutingRule[]): this {
    for (const r of rules) this.addRule(r)
    return this
  }

  /** 路由：根据请求匹配最佳 provider + model */
  route(request: RoutingRequest): RoutingResult {
    // 1. 用户强制指定 — 最高优先级
    if (request.preferredProvider && request.preferredModel) {
      return {
        provider: request.preferredProvider,
        model: request.preferredModel,
        matchedRule: null,
      }
    }

    // 2. 规则匹配
    for (const rule of this.rules) {
      if (this.matchRule(rule, request)) {
        return {
          provider: rule.provider,
          model: rule.model,
          matchedRule: rule,
        }
      }
    }

    // 3. Fallback
    return {
      provider: this.fallbackProvider,
      model: this.fallbackModel,
      matchedRule: null,
    }
  }

  /** 获取 chat provider 实例 */
  resolveProvider(result: RoutingResult): ModelProvider {
    return getProvider(result.provider)
  }

  /** 获取 image provider 实例 */
  resolveImageProvider(result: RoutingResult): ImageProvider {
    return getImageProvider(result.provider)
  }

  /** 列出所有规则 */
  getRules(): RoutingRule[] {
    return [...this.rules]
  }

  private matchRule(rule: RoutingRule, request: RoutingRequest): boolean {
    // 匹配任务类型
    const types = Array.isArray(rule.taskType) ? rule.taskType : [rule.taskType]
    if (!types.includes(request.taskType)) return false

    // 匹配难度（如果规则指定了）
    if (rule.difficulty && request.difficulty) {
      const diffs = Array.isArray(rule.difficulty)
        ? rule.difficulty
        : [rule.difficulty]
      if (!diffs.includes(request.difficulty)) return false
    }

    // 匹配标签（如果规则指定了，至少一个匹配）
    if (rule.tags && rule.tags.length > 0 && request.tags) {
      const hasMatch = rule.tags.some((t) => request.tags!.includes(t))
      if (!hasMatch) return false
    }

    return true
  }
}

// ---- 简单的任务类型推断 ----

const IMAGE_KEYWORDS = ['画', '图', '图片', '生成图', 'draw', 'image', 'picture', 'photo', 'illustration']
const CODE_KEYWORDS = ['代码', '函数', '实现', '编程', 'code', 'function', 'implement', 'bug', 'fix', 'refactor']
const SEARCH_KEYWORDS = ['搜索', '查找', '网上', '网页', 'search', 'find', 'web', 'url', 'http']
const ANALYSIS_KEYWORDS = ['分析', '解释', '总结', '比较', 'analyze', 'explain', 'summarize', 'compare']

export function inferTaskType(text: string): TaskType {
  const lower = text.toLowerCase()

  if (IMAGE_KEYWORDS.some((k) => lower.includes(k))) return 'image'
  if (CODE_KEYWORDS.some((k) => lower.includes(k))) return 'code'
  if (SEARCH_KEYWORDS.some((k) => lower.includes(k))) return 'search'
  if (ANALYSIS_KEYWORDS.some((k) => lower.includes(k))) return 'analysis'

  return 'general'
}
