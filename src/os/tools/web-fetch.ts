/**
 * 内置工具：WebFetch
 * 照搬 cc WebFetchTool — HTTP GET 获取网页内容
 */

import type { Tool, ToolInputSchema, ToolResult, ToolContext } from '../tool.ts'
import { ProxyAgent, fetch as undiciFetch } from 'undici'

function getProxyUrl(): string | undefined {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
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

export const webFetchTool: Tool = {
  name: 'web_fetch',
  description: '发送 HTTP 请求获取网页内容。返回网页的文本内容（HTML 标签会被去除）。',
  tags: ['search', 'web'],
  readOnly: true,

  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '要请求的 URL', required: true },
      method: { type: 'string', description: 'HTTP 方法', enum: ['GET', 'POST'], default: 'GET' },
      headers: { type: 'object', description: '自定义请求头' },
      body: { type: 'string', description: '请求体（POST 时使用）' },
    },
    required: ['url'],
  },

  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const url = input.url as string
    const method = (input.method as string) || 'GET'

    if (!url || typeof url !== 'string') {
      return { output: '错误：url 参数是必需的', error: true }
    }

    // 安全检查：只允许 http/https
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return { output: '错误：只支持 http:// 和 https:// 协议', error: true }
    }

    try {
      const agent = getProxyAgent()
      const opts: Record<string, unknown> = {
        method,
        headers: (input.headers as Record<string, string>) ?? {
          'User-Agent': 'Byte-cp/0.1 (WebFetch Tool)',
        },
        signal: context.signal ?? AbortSignal.timeout(30_000),
      }
      if (method === 'POST' && input.body) {
        opts.body = input.body as string
      }
      if (agent) opts.dispatcher = agent

      const res = await undiciFetch(url, opts as never)
      const text = await (res as unknown as Response).text()

      // 简单去除 HTML 标签
      const cleaned = stripHtml(text)

      // 截断过长内容
      const maxLen = 8000
      const output =
        cleaned.length > maxLen
          ? cleaned.slice(0, maxLen) + `\n\n[内容已截断，共 ${cleaned.length} 字符]`
          : cleaned

      return {
        output: `HTTP ${res.status}\n\n${output}`,
        metadata: { statusCode: res.status, contentLength: cleaned.length },
      }
    } catch (err) {
      return {
        output: `请求失败: ${err instanceof Error ? err.message : String(err)}`,
        error: true,
      }
    }
  },
}

/** 简单的 HTML 去标签 + 压缩空白 */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}
