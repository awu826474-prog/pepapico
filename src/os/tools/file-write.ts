/**
 * 内置工具：FileWrite
 * 照搬 cc FileWriteTool — 写入文件
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname, relative } from 'node:path'
import type { Tool, ToolResult, ToolContext } from '../tool.ts'

export const fileWriteTool: Tool = {
  name: 'file_write',
  description: '创建或覆盖文件。如果目录不存在会自动创建。',
  tags: ['file', 'write'],
  readOnly: false,

  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '文件路径（相对于工作目录或绝对路径）',
        required: true,
      },
      content: {
        type: 'string',
        description: '要写入的文件内容',
        required: true,
      },
    },
    required: ['path', 'content'],
  },

  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const filePath = input.path as string
    const content = input.content as string

    if (!filePath) return { output: '错误：path 参数是必需的', error: true }
    if (content === undefined) return { output: '错误：content 参数是必需的', error: true }

    const absPath = resolve(context.cwd, filePath)

    try {
      await mkdir(dirname(absPath), { recursive: true })
      await writeFile(absPath, content, 'utf-8')

      const display = relative(context.cwd, absPath)
      const lines = content.split('\n').length
      return {
        output: `已写入 ${display} (${lines} 行, ${content.length} 字符)`,
      }
    } catch (err) {
      return {
        output: `写入文件失败: ${err instanceof Error ? err.message : String(err)}`,
        error: true,
      }
    }
  },
}
