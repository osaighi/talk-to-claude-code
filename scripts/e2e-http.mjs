#!/usr/bin/env node
// Exercises the Streamable HTTP transport: auth rejection, bearer auth, secret-path auth.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = 8791
const TOKEN = 'test-secret-0123456789'
const BASE = `http://127.0.0.1:${PORT}/mcp`

const child = spawn('node', [path.join(root, 'dist', 'index.js'), '--http', '--port', String(PORT)], {
  env: { ...process.env, CLAUDE_REMOTE_MCP_TOKEN: TOKEN, CLAUDE_CODE_MESSAGING_SOCKET: '' },
  stdio: ['ignore', 'inherit', 'inherit'],
})

const ready = async () => {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/healthz`)
      if (res.ok) return
    } catch {}
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error('server never became ready')
}

async function connect(url, headers) {
  const client = new Client({ name: 'http-probe', version: '0.0.1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }))
  return client
}

try {
  await ready()

  // 1. No credentials at all.
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  })
  console.log(`no token          -> HTTP ${res.status} ${res.status === 401 ? 'OK (rejected)' : 'UNEXPECTED'}`)

  // 2. Wrong bearer.
  const bad = await fetch(BASE, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer wrong-token-value00',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  })
  console.log(`wrong bearer      -> HTTP ${bad.status} ${bad.status === 401 ? 'OK (rejected)' : 'UNEXPECTED'}`)

  // 3. Correct bearer.
  const viaHeader = await connect(BASE, { authorization: `Bearer ${TOKEN}` })
  const tools = await viaHeader.listTools()
  console.log(`bearer auth       -> OK, tools: ${tools.tools.map(t => t.name).join(', ')}`)
  const listed = await viaHeader.callTool({ name: 'list_sessions', arguments: {} })
  console.log(`list_sessions     -> ${listed.content[0].text.split('\n')[0]}`)
  await viaHeader.close()

  // 4. Secret in the URL, which is what a ChatGPT no-auth connector can use.
  const viaPath = await connect(`${BASE}/${TOKEN}`)
  const t2 = await viaPath.listTools()
  console.log(`secret-path auth  -> OK, ${t2.tools.length} tools`)
  await viaPath.close()
} finally {
  child.kill('SIGTERM')
}
