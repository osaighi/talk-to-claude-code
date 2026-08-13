#!/usr/bin/env node
// Dev probe: verifies discovery and auth-key derivation without sending anything.
import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { listSessions } from '../dist/registry.js'
import { sessionsDir } from '../dist/paths.js'

const sessions = await listSessions()
const keyFiles = await readdir(sessionsDir()).catch(() => [])

console.log(`live sessions: ${sessions.length}\n`)
for (const s of sessions) {
  console.log(`- ${s.name ?? '(unnamed)'}  [${s.sessionId.slice(0, 8)}]  pid=${s.pid}`)
  console.log(`    cwd=${s.cwd}  status=${s.status ?? '?'}  version=${s.version ?? '?'}`)
  console.log(`    socket=${s.socketPath ?? '(none)'}`)
  console.log(`    remoteControl=${s.bridgeSessionId ?? '(not mirrored)'}`)
  if (s.socketPath) {
    const hash = createHash('sha256').update(path.resolve(s.socketPath)).digest('hex')
    const match = keyFiles.find(f => f === `${s.pid}.${hash}.key`)
    console.log(`    keyFile=${match ?? 'NOT FOUND'}  (derived hash ${hash.slice(0, 16)}…)`)
  }
  console.log()
}
