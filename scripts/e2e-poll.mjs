#!/usr/bin/env node
// Exercises the incremental flow a remote client actually uses:
// send_message -> get_reply loop until finished.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const target = process.argv[2]
if (!target) {
  console.error('usage: node scripts/e2e-poll.mjs <session> [prompt]')
  process.exit(1)
}
const prompt =
  process.argv[3] ??
  'Look at the files in src/ of this project and tell me how many TypeScript files there are. Be brief.'

const client = new Client({ name: 'poll-probe', version: '0.0.1' })
await client.connect(
  new StdioClientTransport({
    command: 'node',
    args: [path.join(root, 'dist', 'index.js')],
    env: { ...process.env, CLAUDE_CODE_MESSAGING_SOCKET: '' },
  }),
)

const call = async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text

console.log('--- send_message ---')
const queued = await call('send_message', { session: target, message: prompt })
console.log(queued)

const cursor0 = /since="([^"]+)"/.exec(queued)?.[1]
if (!cursor0) throw new Error('send_message did not return a cursor')

let cursor = cursor0
for (let round = 1; round <= 12; round++) {
  const out = await call('get_reply', { session: target, since: cursor, wait_seconds: 10 })
  const finished = out.includes('state=finished')
  console.log(`\n--- get_reply #${round} (${finished ? 'finished' : 'working'}) ---`)
  console.log(out.length > 700 ? `${out.slice(0, 700)}…` : out)
  if (finished) break
  cursor = /cursor="([^"]+)"/.exec(out)?.[1] ?? cursor
}

await client.close()
