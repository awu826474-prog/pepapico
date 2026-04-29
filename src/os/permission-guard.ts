/**
 * PermissionGuard — 权限交互确认系统
 *
 * 在 Agent 执行危险工具调用前，拦截并请求确认。
 *
 * 风险分级：
 * - low:      只读操作，自动放行
 * - medium:   一般写操作，可配置自动放行
 * - high:     危险写操作（删除、覆盖），需要确认
 * - critical: 不可逆操作（rm -rf、git push --force），必须确认
 *
 * 工作流：
 * 1. agent-loop 在执行工具前调用 guard.check()
 * 2. guard 根据工具+输入分析风险等级
 * 3. 若需确认 → 发出 PermissionRequest 事件，挂起等待
 * 4. 前端（CLI/TUI）收到事件后展示给用户
 * 5. 用户决定后调用 guard.resolve() 继续或拒绝
 */

// ---- 风险等级 ----

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'

// ---- 权限请求 ----

export interface PermissionRequest {
  /** 请求唯一 ID */
  id: string
  /** 发起 agent ID */
  agentId: string
  /** 工具名称 */
  tool: string
  /** 工具输入参数 */
  input: Record<string, unknown>
  /** 风险等级 */
  risk: RiskLevel
  /** 人类可读的操作描述 */
  description: string
  /** 风险原因说明 */
  reason: string
  /** 时间戳 */
  timestamp: number
}

/** 权限决策 */
export type PermissionDecision =
  | { action: 'allow' }
  | { action: 'allow_session'; tool: string }  // 本次会话内同工具不再询问
  | { action: 'deny'; reason?: string }
  | { action: 'deny_and_abort' }               // 拒绝并中止整个 agent

// ---- 危险命令模式 ----

const CRITICAL_BASH_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force)/,         // rm -rf, rm --force
  /\bgit\s+push\s+.*--force/,                             // git push --force
  /\bgit\s+reset\s+--hard/,                               // git reset --hard
  /\bdrop\s+(table|database|schema)/i,                    // SQL DROP
  /\btruncate\s+table/i,                                  // SQL TRUNCATE
  /\bformat\s+[a-zA-Z]:/i,                                // format drive
  /\bdd\s+if=/,                                            // dd
  /\bmkfs\b/,                                              // mkfs
  /\bnpx?\s+.*--no-verify/,                               // bypass hooks
]

const HIGH_BASH_PATTERNS = [
  /\brm\s/,                                                // any rm
  /\bgit\s+(push|commit\s+--amend)/,                      // git push, amend
  /\bcurl\s+.*-X\s*(POST|PUT|DELETE|PATCH)/i,             // destructive HTTP
  /\bchmod\s/,                                             // permission change
  /\bchown\s/,                                             // ownership change
  /\bkill\b/,                                              // process kill
  /\bnpm\s+(publish|unpublish)/,                           // npm publish
  /\bdocker\s+(rm|rmi|stop|kill)/,                         // docker destructive
]

const SENSITIVE_FILE_PATHS = [
  /\.env/,
  /\.ssh/,
  /id_rsa/,
  /\.git\/config/,
  /package\.json$/,
  /tsconfig\.json$/,
  /docker-compose/,
  /Dockerfile/,
  /\.github\/workflows/,
]

// ---- PermissionGuard ----

let requestCounter = 0

export class PermissionGuard {
  /** 自动放行的风险等级阈值（低于等于此级别自动放行） */
  private autoApproveLevel: RiskLevel
  /** 本会话内永久放行的工具 */
  private sessionApproved = new Set<string>()
  /** 待决策队列 */
  private pending = new Map<string, {
    request: PermissionRequest
    resolve: (decision: PermissionDecision) => void
  }>()
  /** 事件回调 */
  private onRequest?: (request: PermissionRequest) => void
  /** 工具风险等级覆盖 */
  private toolRiskOverrides = new Map<string, RiskLevel>()

  constructor(options?: { autoApproveLevel?: RiskLevel }) {
    this.autoApproveLevel = options?.autoApproveLevel ?? 'low'
  }

  /** 设置权限请求回调（前端注册） */
  setRequestHandler(handler: (request: PermissionRequest) => void): void {
    this.onRequest = handler
  }

  /** 设置自动放行等级 */
  setAutoApproveLevel(level: RiskLevel): void {
    this.autoApproveLevel = level
  }

  /** 覆盖工具风险等级 */
  setToolRisk(tool: string, risk: RiskLevel): void {
    this.toolRiskOverrides.set(tool, risk)
  }

  /**
   * 检查工具调用权限
   *
   * @returns 如果自动放行，返回 { action: 'allow' }；
   *          如果需要确认，挂起并等待 resolve() 调用。
   */
  async check(
    agentId: string,
    tool: string,
    input: Record<string, unknown>,
  ): Promise<PermissionDecision> {
    // 会话内已放行
    if (this.sessionApproved.has(tool)) {
      return { action: 'allow' }
    }

    // 评估风险
    const risk = this.assessRisk(tool, input)

    // 自动放行
    if (this.shouldAutoApprove(risk)) {
      return { action: 'allow' }
    }

    // 需要确认 — 创建请求并挂起
    const request: PermissionRequest = {
      id: `perm-${++requestCounter}-${Date.now()}`,
      agentId,
      tool,
      input,
      risk,
      description: this.describeAction(tool, input),
      reason: this.explainRisk(tool, input, risk),
      timestamp: Date.now(),
    }

    return new Promise<PermissionDecision>((resolve) => {
      this.pending.set(request.id, { request, resolve })
      this.onRequest?.(request)
    })
  }

  /**
   * 提交权限决策（前端调用）
   */
  resolve(requestId: string, decision: PermissionDecision): void {
    const entry = this.pending.get(requestId)
    if (!entry) return
    this.pending.delete(requestId)

    if (decision.action === 'allow_session') {
      this.sessionApproved.add(decision.tool)
    }

    entry.resolve(decision)
  }

  /** 获取待决策列表 */
  getPending(): PermissionRequest[] {
    return [...this.pending.values()].map((e) => e.request)
  }

  /** 重置会话放行 */
  resetSession(): void {
    this.sessionApproved.clear()
  }

  // ---- 风险评估 ----

  /** 评估工具调用的风险等级 */
  assessRisk(tool: string, input: Record<string, unknown>): RiskLevel {
    // 先检查手动覆盖
    const override = this.toolRiskOverrides.get(tool)
    if (override) return override

    switch (tool) {
      case 'bash':
        return this.assessBashRisk(input)
      case 'file_write':
        return this.assessFileWriteRisk(input)
      case 'file_read':
        return 'low'
      case 'web_fetch':
        return this.assessWebFetchRisk(input)
      case 'sub_agent':
        return 'medium' // 创建子 agent 需要注意
      default:
        return 'medium' // 未知工具默认 medium
    }
  }

  private assessBashRisk(input: Record<string, unknown>): RiskLevel {
    const command = String(input.command ?? input.raw ?? '')

    for (const pattern of CRITICAL_BASH_PATTERNS) {
      if (pattern.test(command)) return 'critical'
    }
    for (const pattern of HIGH_BASH_PATTERNS) {
      if (pattern.test(command)) return 'high'
    }

    // 一般命令 → medium
    return 'medium'
  }

  private assessFileWriteRisk(input: Record<string, unknown>): RiskLevel {
    const path = String(input.path ?? input.filePath ?? '')

    for (const pattern of SENSITIVE_FILE_PATHS) {
      if (pattern.test(path)) return 'high'
    }

    return 'medium'
  }

  private assessWebFetchRisk(input: Record<string, unknown>): RiskLevel {
    const method = String(input.method ?? 'GET').toUpperCase()
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) return 'high'
    return 'low'
  }

  // ---- 描述生成 ----

  private describeAction(tool: string, input: Record<string, unknown>): string {
    switch (tool) {
      case 'bash': {
        const cmd = String(input.command ?? input.raw ?? '').slice(0, 200)
        return `执行命令: ${cmd}`
      }
      case 'file_write': {
        const path = String(input.path ?? input.filePath ?? '?')
        const size = String(input.content ?? '').length
        return `写入文件: ${path} (${size} 字符)`
      }
      case 'web_fetch': {
        const url = String(input.url ?? '?')
        const method = String(input.method ?? 'GET')
        return `HTTP ${method}: ${url}`
      }
      case 'sub_agent':
        return `创建子 Agent: ${String(input.name ?? '?')}`
      default:
        return `调用工具 ${tool}: ${JSON.stringify(input).slice(0, 200)}`
    }
  }

  private explainRisk(tool: string, input: Record<string, unknown>, risk: RiskLevel): string {
    const level = { low: '低', medium: '中', high: '高', critical: '极高' }[risk]

    switch (risk) {
      case 'critical':
        return `⚠️ 风险等级: ${level} — 此操作不可逆，可能导致数据丢失或系统变更`
      case 'high':
        return `⚠ 风险等级: ${level} — 此操作会修改文件系统或外部状态`
      case 'medium':
        return `△ 风险等级: ${level} — 此操作会修改本地文件`
      default:
        return `○ 风险等级: ${level} — 只读操作`
    }
  }

  private shouldAutoApprove(risk: RiskLevel): boolean {
    const levels: RiskLevel[] = ['low', 'medium', 'high', 'critical']
    return levels.indexOf(risk) <= levels.indexOf(this.autoApproveLevel)
  }
}
