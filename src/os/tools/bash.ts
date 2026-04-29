/**
 * 内置工具：Bash
 * 照搬 cc BashTool — 执行 shell 命令
 */

import { execFile } from 'node:child_process'
import type { Tool, ToolResult, ToolContext } from '../tool.ts'

export const bashTool: Tool = {
  name: 'bash',
  description:
    '执行 shell 命令。Windows 下使用 PowerShell，Linux/macOS 下使用 bash。返回命令的 stdout 和 stderr。',
  tags: ['execute', 'shell'],
  readOnly: false,

  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: '要执行的 shell 命令',
        required: true,
      },
      cwd: {
        type: 'string',
        description: '工作目录（默认使用当前目录）',
      },
      timeout: {
        type: 'number',
        description: '超时时间（毫秒），默认 30000',
      },
    },
    required: ['command'],
  },

  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const command = input.command as string
    if (!command || typeof command !== 'string') {
      return { output: '错误：command 参数是必需的', error: true }
    }

    const cwd = (input.cwd as string) || context.cwd
    const timeout = (input.timeout as number) || 30_000

    // 根据平台选择 shell
    const isWindows = process.platform === 'win32'
    const shell = isWindows ? 'powershell.exe' : '/bin/bash'
    const shellArgs = isWindows ? ['-NoProfile', '-Command', command] : ['-c', command]

    return new Promise<ToolResult>((resolve) => {
      const proc = execFile(shell, shellArgs, {
        cwd,
        timeout,
        maxBuffer: 1024 * 1024, // 1MB
        signal: context.signal,
      }, (err, stdout, stderr) => {
        if (err && !stdout && !stderr) {
          resolve({
            output: `命令执行失败: ${err.message}`,
            error: true,
          })
          return
        }

        let output = ''
        if (stdout) output += stdout
        if (stderr) output += (output ? '\n--- stderr ---\n' : '') + stderr

        // 截断过长输出
        const maxLen = 8000
        if (output.length > maxLen) {
          output = output.slice(0, maxLen) + `\n\n[输出已截断，共 ${output.length} 字符]`
        }

        resolve({
          output: output || '(无输出)',
          error: !!err,
          metadata: { exitCode: err ? (err as NodeJS.ErrnoException).code : 0 },
        })
      })
    })
  },
}
