import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Append-only record of every tool call.
 *
 * Without it there is no way to see what a hosted client actually invoked —
 * only what it was supposed to. Writes to <project>/.run/calls.log by default;
 * set CLAUDE_REMOTE_MCP_LOG to relocate it, or to "off" to disable.
 */
const configured = process.env.CLAUDE_REMOTE_MCP_LOG
const target =
  configured === 'off'
    ? undefined
    : (configured ??
      path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), '.run', 'calls.log'))

let ready: Promise<void> | undefined

export function logCall(tool: string, detail: Record<string, unknown>): void {
  if (!target) return
  const line = `${JSON.stringify({ ts: new Date().toISOString(), tool, ...detail })}\n`
  ready ??= mkdir(path.dirname(target), { recursive: true }).then(() => {})
  void ready.then(() => appendFile(target, line)).catch(() => {})
}

/** Trim long free text so the log stays readable. */
export function brief(value: unknown, max = 160): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text === undefined) return ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export const logPath = target
