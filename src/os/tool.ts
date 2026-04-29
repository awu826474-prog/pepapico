/**
 * 工具系统 — 照搬 cc Tool 接口核心设计
 * 统一的 call / prompt / inputSchema 接口
 */

// ---- 工具输入 Schema（简化版 JSON Schema） ----

export interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  description?: string
  required?: boolean
  enum?: string[]
  default?: unknown
}

export interface ToolInputSchema {
  type: 'object'
  properties: Record<string, ToolParameter>
  required?: string[]
}

// ---- 工具结果 ----

export interface ToolResult {
  /** 返回给模型的文本结果 */
  output: string
  /** 是否出错 */
  error?: boolean
  /** 附加元数据 */
  metadata?: Record<string, unknown>
}

// ---- 工具执行上下文 ----

export interface ToolContext {
  /** 当前工作目录 */
  cwd: string
  /** 调用此工具的 Agent ID */
  agentId: string
  /** 发出进度回调 */
  onProgress?: (message: string) => void
  /** 中止信号 */
  signal?: AbortSignal
}

// ---- 工具接口（照搬 cc 的 Tool 核心设计） ----

export interface Tool<TInput = Record<string, unknown>> {
  /** 工具唯一名称 */
  readonly name: string

  /** 人类可读描述 */
  readonly description: string

  /** 输入参数 Schema（给模型做 function calling） */
  readonly inputSchema: ToolInputSchema

  /** 工具分类标签 */
  readonly tags?: string[]

  /** 是否只读（不修改文件系统/环境） */
  readonly readOnly?: boolean

  /** 执行工具 */
  call(input: TInput, context: ToolContext): Promise<ToolResult>

  /** 生成给模型看的 prompt 描述（可动态） */
  prompt?(): string
}

// ---- 工具注册表 ----

const toolRegistry = new Map<string, Tool>()

export function registerTool(tool: Tool): void {
  toolRegistry.set(tool.name, tool)
}

export function getTool(name: string): Tool | undefined {
  return toolRegistry.get(name)
}

export function getAllTools(): Tool[] {
  return [...toolRegistry.values()]
}

export function getToolsByTag(tag: string): Tool[] {
  return [...toolRegistry.values()].filter((t) => t.tags?.includes(tag))
}

/** 将 Tool[] 转换为 OpenAI function calling 格式的 ToolDefinition[] */
export function toToolDefinitions(
  tools: Tool[],
): { type: 'function'; function: { name: string; description: string; parameters: ToolInputSchema } }[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.prompt?.() ?? t.description,
      parameters: t.inputSchema,
    },
  }))
}
