/**
 * 内置工具：FileRead
 * 照搬 cc FileReadTool — 读取文件内容
 */

import { readFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import type { Tool, ToolResult, ToolContext } from '../tool.ts'

export const fileReadTool: Tool = {
  name: 'file_read',
  description: '读取文件内容。支持指定行范围。',
  tags: ['file', 'read'],
  readOnly: true,

  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '文件路径（相对于工作目录或绝对路径）',
        required: true,
      },
      startLine: {
        type: 'number',
        description: '起始行号（1-based），不指定则从头开始',
      },
      endLine: {
        type: 'number',
        description: '结束行号（1-based，含），不指定则到文件末尾',
      },
    },
    required: ['path'],
  },

  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const filePath = input.path as string
    if (!filePath) {
      return { output: '错误：path 参数是必需的', error: true }
    }

    const absPath = resolve(context.cwd, filePath)

    try {
      const content = await readFile(absPath, 'utf-8')
      const lines = content.split('\n')

      const start = Math.max(1, (input.startLine as number) || 1) - 1
      const end = Math.min(lines.length, (input.endLine as number) || lines.length)

      const selected = lines.slice(start, end)
      const display = relative(context.cwd, absPath)

      let output = `${display} (${lines.length} 行)\n`
      if (start > 0 || end < lines.length) {
        output += `[显示 ${start + 1}-${end} 行]\n`
      }
      output += '\n' + selected.map((l, i) => `${start + i + 1} | ${l}`).join('\n')

      // 截断
      const maxLen = 10_000
      if (output.length > maxLen) {
        output = output.slice(0, maxLen) + `\n\n[内容已截断]`
      }

      return { output }
    } catch (err) {
      return {
        output: `读取文件失败: ${err instanceof Error ? err.message : String(err)}`,
        error: true,
      }
    }
  },
}
