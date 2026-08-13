#!/usr/bin/env node
// End-to-end check: drive the MCP server over stdio exactly as a client would.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const target = process.argv[2]
if (!target) {
  console.error('usage: node scripts/e2e.mjs <session> [prompt]')
  process.exit(1)
}
const prompt = process.argv[3] ?? 'Reply with exactly: MCP_PONG. Nothing else.'

const transport = new StdioClientTransport({
  command: 'node',
  args: [path.join(root, 'dist', 'index.js')],
  // Drop the parent session's own inbox so the self-guard does not misfire.
  env: { ...process.env, CLAUDE_CODE_MESSAGING_SOCKET: '' },
})
const client = new Client({ name: 'e2e-probe', version: '0.0.1' })
await client.connect(transport)

const tools = await client.listTools()
console.log('tools:', tools.tools.map(t => t.name).join(', '), '\n')

const listed = await client.callTool({ name: 'list_sessions', arguments: {} })
console.log('--- list_sessions ---')
console.log(listed.content[0].text, '\n')

console.log(`--- ask '${target}' ---`)
const started = Date.now()
const answer = await client.callTool({
  name: 'ask',
  arguments: { session: target, message: prompt, timeout_seconds: 120 },
})
console.log(answer.content[0].text)
console.log(`\n(isError=${answer.isError === true}, ${((Date.now() - started) / 1000).toFixed(1)}s)`)

await client.close()
