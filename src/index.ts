#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { serveHttp } from './http.js'
import { createServer, receipts } from './server.js'

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index !== -1 && index + 1 < process.argv.length) return process.argv[index + 1]
  const inline = process.argv.find(arg => arg.startsWith(`${name}=`))
  return inline?.slice(name.length + 1)
}

async function main() {
  await receipts.start()

  const wantsHttp = process.argv.includes('--http') || process.env.CLAUDE_REMOTE_MCP_HTTP === '1'

  if (wantsHttp) {
    const token = process.env.CLAUDE_REMOTE_MCP_TOKEN
    if (!token && process.env.CLAUDE_REMOTE_MCP_NO_AUTH !== '1') {
      throw new Error(
        'HTTP mode needs a shared secret: set CLAUDE_REMOTE_MCP_TOKEN, or set CLAUDE_REMOTE_MCP_NO_AUTH=1 to run open. ' +
          'This server can queue prompts into local Claude Code sessions, so an unauthenticated endpoint hands that to anyone who can reach it.',
      )
    }

    const host = flagValue('--host') ?? process.env.CLAUDE_REMOTE_MCP_HOST ?? '127.0.0.1'
    const port = Number(flagValue('--port') ?? process.env.CLAUDE_REMOTE_MCP_PORT ?? 8787)
    const path = flagValue('--path') ?? process.env.CLAUDE_REMOTE_MCP_PATH ?? '/mcp'

    await serveHttp({ host, port, path, token })
    process.stderr.write(
      `talk-to-claude-code listening on http://${host}:${port}${path}` +
        `${token ? ` (auth: Bearer token, or ${path}/<token>)` : ' (UNAUTHENTICATED)'}\n`,
    )
  } else {
    await createServer().connect(new StdioServerTransport())
  }

  const shutdown = async () => {
    await receipts.stop().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(err => {
  process.stderr.write(`talk-to-claude-code failed to start: ${String(err instanceof Error ? err.message : err)}\n`)
  process.exit(1)
})
