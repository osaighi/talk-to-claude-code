import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import { createServer } from './server.js'
import { voiceAsk, voiceReply } from './voice.js'

export interface HttpOptions {
  host: string
  port: number
  /** Base path clients POST to, e.g. /mcp. */
  path: string
  /**
   * Shared secret. Accepted either as `Authorization: Bearer <token>` or as an
   * extra path segment (`<path>/<token>`) — ChatGPT's no-auth custom connectors
   * cannot attach a static header, so a secret URL is the practical option there.
   */
  token?: string
}

function tokenMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected)
  const b = Buffer.from(provided)
  return a.length === b.length && timingSafeEqual(a, b)
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(payload)
}

function sendText(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(body)
}

/**
 * Voice endpoints, spoken aloud by Siri.
 *
 * Everything is plain text and every call returns quickly: a Shortcut loops on
 * /voice/reply and speaks each update, which is what turns a long task into a
 * running commentary instead of silence.
 *
 *   POST|GET /voice/ask?session=&message=   deliver a prompt, answer if quick
 *   GET       /voice/reply?session=&since=  next chunk of progress
 */
async function handleVoice(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const params = url.searchParams
  let body: Record<string, unknown> = {}
  if (req.method === 'POST') {
    const parsed = await readBody(req).catch(() => undefined)
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>
  }
  const field = (name: string) => {
    const value = body[name] ?? params.get(name)
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  }

  const session = field('session')
  if (!session) {
    sendText(res, 400, 'Tell me which session to use.')
    return
  }

  try {
    if (url.pathname.startsWith('/voice/ask')) {
      const message = field('message')
      if (!message) {
        sendText(res, 400, 'Tell me what to ask.')
        return
      }
      sendText(res, 200, await voiceAsk(session, message, Number(field('wait') ?? 20)))
      return
    }
    if (url.pathname.startsWith('/voice/reply')) {
      sendText(res, 200, await voiceReply(session, field('since'), Number(field('wait') ?? 15)))
      return
    }
    sendText(res, 404, 'Unknown voice command.')
  } catch (err) {
    sendText(res, 200, `Something went wrong: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > 4_000_000) throw new Error('request body too large')
    chunks.push(buf)
  }
  if (chunks.length === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Serve MCP over Streamable HTTP.
 *
 * Binds to loopback by default: the intended deployment is behind an
 * outbound-only tunnel, not a directly exposed port.
 */
export async function serveHttp(options: HttpOptions): Promise<http.Server> {
  const transports = new Map<string, StreamableHTTPServerTransport>()

  /** Returns true when the request carries the shared secret. */
  const authorize = (req: http.IncomingMessage, url: URL): boolean => {
    if (!options.token) return true

    const header = req.headers.authorization
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      if (tokenMatches(options.token, header.slice(7).trim())) return true
    }
    // Accept the secret as any path segment, so both /mcp/<token> and
    // /voice/reply/<token> work — Siri Shortcuts and ChatGPT's no-auth
    // connectors can carry a secret in the URL but not in a header.
    const segments = url.pathname.split('/').filter(Boolean)
    if (segments.some(segment => tokenMatches(options.token!, segment))) return true
    const query = url.searchParams.get('token')
    return query !== null && tokenMatches(options.token, query)
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'content-type, authorization, mcp-session-id, mcp-protocol-version',
          'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
          'access-control-expose-headers': 'mcp-session-id',
        })
        res.end()
        return
      }

      if (url.pathname === '/healthz') {
        send(res, 200, { ok: true })
        return
      }

      // Plain-text surface for Siri Shortcuts: MCP's JSON-RPC handshake is not
      // usable from Shortcuts, and CarPlay only ever offers voice.
      if (url.pathname.startsWith('/voice/')) {
        if (!authorize(req, url)) {
          sendText(res, 401, 'Unauthorized.')
          return
        }
        await handleVoice(req, res, url)
        return
      }

      if (!url.pathname.startsWith(options.path)) {
        send(res, 404, { error: 'not found' })
        return
      }
      if (!authorize(req, url)) {
        send(res, 401, { error: 'unauthorized' })
        return
      }

      res.setHeader('access-control-expose-headers', 'mcp-session-id')

      const sessionId = req.headers['mcp-session-id']
      const existing = typeof sessionId === 'string' ? transports.get(sessionId) : undefined

      if (existing) {
        await existing.handleRequest(req, res, req.method === 'POST' ? await readBody(req) : undefined)
        return
      }

      // A session id we no longer hold — the server restarted, or a dropped
      // connection expired the session. Answer 404, the spec's "reinitialise"
      // signal, so the client opens a fresh session instead of seeing a hard
      // error and giving up. Treating this stale id as a new initialize (the
      // old behaviour) made the SDK reject it and surfaced as a lost connection.
      if (typeof sessionId === 'string' && sessionId.length > 0) {
        send(res, 404, {
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session expired — reinitialize.' },
          id: null,
        })
        return
      }
      if (req.method !== 'POST') {
        send(res, 400, { error: 'missing mcp-session-id' })
        return
      }

      // A POST with no session id at all is an initialize; give it its own server.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: id => {
          transports.set(id, transport)
        },
        onsessionclosed: id => {
          transports.delete(id)
        },
      })
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId)
      }

      await createServer().connect(transport)
      await transport.handleRequest(req, res, await readBody(req))
    } catch (err) {
      if (!res.headersSent) send(res, 500, { error: String(err instanceof Error ? err.message : err) })
      else res.end()
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  return server
}
