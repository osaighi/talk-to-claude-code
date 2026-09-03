import { createHash, randomBytes } from 'node:crypto'
import { readFile, readdir, unlink } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { sessionsDir, socketDir } from './paths.js'
import type { LiveSession } from './registry.js'

/**
 * The CLI's cross-session inbox speaks newline-delimited JSON over a Unix
 * socket. The first line authenticates; every later line is a frame. Its own
 * debug log documents the shape:
 *
 *   {"type":"auth","token":"..."}
 *   {"type":"user","message":{"role":"user","content":"hello"}}
 */
interface AuthFrame {
  type: 'auth'
  token: string
}

interface UserFrame {
  type: 'user'
  message: { role: 'user'; content: string }
  msg_id?: string
  from?: string
  priority?: string
}

interface ControlFrame {
  type: 'control'
  action: string
  [key: string]: unknown
}

type OutboundFrame = AuthFrame | UserFrame | ControlFrame

/** Delivery outcome reported back by the recipient, if it reports one at all. */
export type DeliveryStatus = 'held' | 'denied' | 'expired' | 'delivered'

export interface SendResult {
  msgId: string
  /** Undefined when the recipient sent no receipt within the wait window. */
  status?: DeliveryStatus
  reason?: string
}

const KEY_FILE = /^(\d+)\.([0-9a-f]{64})\.key$/
const PEER_TOKEN = /^[0-9a-f]{32}$/
/** Characters the CLI leaves unescaped when encoding a socket address. */
const ADDRESS_SAFE = /[^A-Za-z0-9:_/.\\-]/gu

/**
 * Encode a socket path into a `uds:` address, matching the CLI's encoder so the
 * address survives its own validation on the way back.
 */
export function udsAddress(socketPath: string): string {
  const encoder = new TextEncoder()
  const escaped = socketPath.replace(ADDRESS_SAFE, ch =>
    Array.from(encoder.encode(ch), byte => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join(''),
  )
  return `uds:${escaped}`
}

/**
 * The auth key for a socket lives at <pid>.<sha256 of the canonical socket
 * path>.key, so the hash tells us which file to read without guessing.
 */
async function readPeerToken(socketPath: string, pid: number): Promise<string | undefined> {
  const hash = createHash('sha256').update(path.resolve(socketPath)).digest('hex')
  const dir = sessionsDir()

  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return undefined
  }

  // Prefer the key published by the owning pid; fall back to any key that
  // matches the socket hash, which is what the CLI does for stale owners.
  const candidates = entries
    .map(file => ({ file, match: KEY_FILE.exec(file) }))
    .filter((e): e is { file: string; match: RegExpExecArray } => e.match !== null && e.match[2] === hash)
    .sort((a, b) => (Number(b.match[1]) === pid ? 1 : 0) - (Number(a.match[1]) === pid ? 1 : 0))

  for (const { file } of candidates) {
    try {
      const parsed = JSON.parse(await readFile(path.join(dir, file), 'utf8')) as { peerToken?: unknown }
      if (typeof parsed.peerToken === 'string' && PEER_TOKEN.test(parsed.peerToken)) return parsed.peerToken
    } catch {
      // Unreadable or malformed key file — try the next candidate.
    }
  }
  return undefined
}

/**
 * Listens for delivery receipts. The recipient only replies to an address that
 * sits in the same directory as its own socket and ends in `.sock`, so this
 * binds inside the shared cc-socks directory.
 */
export class ReceiptListener {
  private server?: net.Server
  private socketPath?: string
  private readonly waiters = new Map<string, (r: { status: DeliveryStatus; reason?: string }) => void>()

  async start(): Promise<void> {
    if (this.server) return
    const target = path.join(socketDir(), `cc-msg-${randomBytes(16).toString('hex')}.sock`)
    const server = net.createServer({ allowHalfOpen: true }, socket => this.handle(socket))
    server.on('error', () => {})

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(target, () => {
          server.removeListener('error', reject)
          resolve()
        })
      })
    } catch {
      // Receipts are an optimisation; sending still works without them.
      return
    }
    server.unref()
    this.server = server
    this.socketPath = target
  }

  /** Our reply address, or undefined if the listener could not bind. */
  get address(): string | undefined {
    return this.socketPath ? udsAddress(this.socketPath) : undefined
  }

  private handle(socket: net.Socket): void {
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk
      if (buffer.length > 1_048_576) {
        socket.destroy()
        buffer = ''
        return
      }
      let index: number
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.trim()) this.consume(line)
      }
    })
    socket.on('end', () => {
      if (buffer.trim()) this.consume(buffer)
      socket.end()
    })
    socket.on('error', () => {})
  }

  private consume(line: string): void {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    if (frame.action !== 'peer_message_status') return
    const status = frame.status
    const origId = frame.orig_msg_id
    if (typeof status !== 'string' || typeof origId !== 'string') return
    const waiter = this.waiters.get(origId)
    if (!waiter) return
    waiter({
      status: status as DeliveryStatus,
      reason: typeof frame.reason === 'string' ? frame.reason : undefined,
    })
  }

  /**
   * Wait for a receipt for one message. Resolves undefined on timeout — the
   * recipient only emits receipts when a message is gated, so silence usually
   * means it went straight through.
   */
  async await(msgId: string, timeoutMs: number): Promise<{ status: DeliveryStatus; reason?: string } | undefined> {
    if (!this.server || timeoutMs <= 0) return undefined
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.waiters.delete(msgId)
        resolve(undefined)
      }, timeoutMs)
      timer.unref?.()
      this.waiters.set(msgId, result => {
        clearTimeout(timer)
        this.waiters.delete(msgId)
        resolve(result)
      })
    })
  }

  async stop(): Promise<void> {
    const server = this.server
    const target = this.socketPath
    this.server = undefined
    this.socketPath = undefined
    if (server) await new Promise<void>(resolve => server.close(() => resolve()))
    if (target) await unlink(target).catch(() => {})
  }
}

/** Open the socket, authenticate, write the frames, and close. */
async function writeFrames(socketPath: string, frames: OutboundFrame[], timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`Timed out writing to ${socketPath} after ${timeoutMs}ms`))
    }, timeoutMs)

    socket.on('connect', () => {
      for (const frame of frames) socket.write(`${JSON.stringify(frame)}\n`)
      socket.end()
    })
    socket.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })
    socket.on('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

export interface SendOptions {
  /** How long to wait for a delivery receipt before returning. */
  receiptTimeoutMs?: number
  receipts?: ReceiptListener
}

/**
 * Deliver a user message to a running session's inbox. The message enters the
 * session's prompt queue exactly as if it had been typed, so it also shows up
 * in whatever Remote Control client is watching that session.
 */
export async function sendUserMessage(
  session: LiveSession,
  content: string,
  options: SendOptions = {},
): Promise<SendResult> {
  const socketPath = session.socketPath
  if (!socketPath) {
    throw new Error(
      `Session '${session.label}' cannot be messaged: it has no messaging socket. ` +
        `It runs Claude Code ${session.version ?? '(unknown)'}, and the cross-session inbox arrived in 2.1.229. ` +
        `You can still read it with read_transcript. To send to it, restart it on a current version — ` +
        `cd ${session.cwd} && claude --resume ${session.sessionId} — which keeps the conversation.`,
    )
  }

  const msgId = randomBytes(16).toString('hex')
  const token = await readPeerToken(socketPath, session.pid)
  const frames: OutboundFrame[] = []

  // Auth is only mandatory on Windows, but sending it always is what earns the
  // 'peer' role rather than being treated as an anonymous writer.
  if (token) frames.push({ type: 'auth', token })

  const from = options.receipts?.address
  frames.push({
    type: 'user',
    message: { role: 'user', content },
    msg_id: msgId,
    ...(from ? { from } : {}),
  })

  const pending = options.receipts?.await(msgId, options.receiptTimeoutMs ?? 0)
  await writeFrames(socketPath, frames, 10_000)
  const receipt = await pending

  return { msgId, status: receipt?.status, reason: receipt?.reason }
}

/** Ask a session to change its display name. */
export async function renameSession(session: LiveSession, name: string): Promise<void> {
  const socketPath = session.socketPath
  if (!socketPath) throw new Error(`Session '${session.label}' has no messaging socket.`)
  const token = await readPeerToken(socketPath, session.pid)
  const frames: OutboundFrame[] = []
  if (token) frames.push({ type: 'auth', token })
  frames.push({ type: 'control', action: 'rename', name })
  await writeFrames(socketPath, frames, 10_000)
}
