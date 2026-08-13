import { open, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { projectsDir } from './paths.js'

/** One line of a session transcript. Only the fields we care about are typed. */
interface TranscriptEntry {
  type?: string
  uuid?: string
  timestamp?: string
  isSidechain?: boolean
  message?: {
    role?: string
    content?: string | Array<{ type?: string; text?: string; name?: string }>
  }
}

export interface Turn {
  role: 'user' | 'assistant'
  timestamp?: string
  text: string
  /** Tools the assistant invoked in this turn, if any. */
  tools?: string[]
}

/** Read at most `maxBytes` from the end of a file, dropping any partial first line. */
async function tailBytes(file: string, maxBytes: number): Promise<string> {
  const handle = await open(file, 'r')
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - maxBytes)
    const length = size - start
    if (length === 0) return ''
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    const text = buffer.toString('utf8')
    // A non-zero offset almost certainly lands mid-line; discard that fragment.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
  } finally {
    await handle.close()
  }
}

const transcriptCache = new Map<string, string>()

/** Locate a session's transcript: <projects>/<cwd-slug>/<sessionId>.jsonl. */
export async function findTranscript(sessionId: string): Promise<string | undefined> {
  const cached = transcriptCache.get(sessionId)
  if (cached) return cached

  const root = projectsDir()
  let projects: string[]
  try {
    projects = await readdir(root)
  } catch {
    return undefined
  }

  for (const project of projects) {
    const candidate = path.join(root, project, `${sessionId}.jsonl`)
    try {
      if ((await stat(candidate)).isFile()) {
        transcriptCache.set(sessionId, candidate)
        return candidate
      }
    } catch {
      // Not in this project directory.
    }
  }
  return undefined
}

function textOf(entry: TranscriptEntry): { text: string; tools: string[] } {
  const content = entry.message?.content
  if (typeof content === 'string') return { text: content, tools: [] }
  if (!Array.isArray(content)) return { text: '', tools: [] }

  const parts: string[] = []
  const tools: string[] = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block?.type === 'tool_use' && typeof block.name === 'string') tools.push(block.name)
  }
  return { text: parts.join('\n').trim(), tools }
}

export interface ReadOptions {
  /** Only return turns strictly newer than this ISO timestamp. */
  since?: string
  /** Cap on returned turns, counted from the end. */
  limit?: number
  /** Include the user side of the conversation as well as the assistant's. */
  includeUser?: boolean
}

/**
 * Read recent conversation turns from a session's transcript.
 *
 * Sidechain entries (subagent work) are skipped, as are tool-result messages —
 * those are plumbing rather than conversation.
 */
export async function readTurns(sessionId: string, options: ReadOptions = {}): Promise<Turn[]> {
  const file = await findTranscript(sessionId)
  if (!file) return []

  const raw = await tailBytes(file, 4_000_000)
  const turns: Turn[] = []

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let entry: TranscriptEntry
    try {
      entry = JSON.parse(line) as TranscriptEntry
    } catch {
      continue
    }
    if (entry.isSidechain) continue
    if (entry.type !== 'assistant' && entry.type !== 'user') continue
    if (entry.type === 'user' && !options.includeUser) continue
    if (options.since && entry.timestamp && entry.timestamp <= options.since) continue

    const { text, tools } = textOf(entry)
    // Tool results arrive as user entries with no text; drop them.
    if (!text && tools.length === 0) continue

    turns.push({
      role: entry.type,
      timestamp: entry.timestamp,
      text,
      ...(tools.length > 0 ? { tools } : {}),
    })
  }

  const limit = options.limit ?? 20
  return turns.slice(-limit)
}

/**
 * Find when a prompt we delivered actually landed in the session.
 *
 * Anchoring on wall-clock is wrong when the target is mid-task: a queued peer
 * message waits its turn, so everything the session emits meanwhile belongs to
 * the *previous* prompt and would be reported as if it were the answer.
 * Matching the delivered message gives an exact anchor instead.
 */
export async function findDeliveredAt(sessionId: string, body: string): Promise<string | undefined> {
  const file = await findTranscript(sessionId)
  if (!file) return undefined

  const needle = body.trim().slice(0, 120)
  if (!needle) return undefined
  const raw = await tailBytes(file, 2_000_000)

  for (const line of raw.split('\n').reverse()) {
    if (!line.includes('"peer"')) continue
    let entry: TranscriptEntry & { origin?: { kind?: string } }
    try {
      entry = JSON.parse(line) as TranscriptEntry & { origin?: { kind?: string } }
    } catch {
      continue
    }
    if (entry.type !== 'user' || entry.origin?.kind !== 'peer') continue
    const content = entry.message?.content
    const text = typeof content === 'string' ? content : JSON.stringify(content ?? '')
    if (text.includes(needle)) return entry.timestamp
  }
  return undefined
}

/** Render turns as readable text for a tool result. */
export function formatTurns(turns: Turn[]): string {
  if (turns.length === 0) return '(no new output)'
  return turns
    .map(turn => {
      const label = turn.role === 'assistant' ? 'assistant' : 'user'
      const tools = turn.tools?.length ? `\n[tools: ${turn.tools.join(', ')}]` : ''
      return `--- ${label}${turn.timestamp ? ` @ ${turn.timestamp}` : ''} ---\n${turn.text}${tools}`
    })
    .join('\n\n')
}
