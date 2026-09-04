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

/** Cached per transcript, keyed by its mtime so a rename is picked up. */
const titleCache = new Map<string, { mtimeMs: number; title?: string }>()

/**
 * The session's real title — what the user named it, and what Remote Control
 * and claude.ai display.
 *
 * The registry only carries a name derived from the working directory
 * (`tachify-33` for /root/tachify), which is not what the user calls it. The
 * title lives in the transcript instead, rewritten as a `custom-title` entry
 * every few turns, so the tail is enough to find the current one.
 */
export async function readSessionTitle(sessionId: string): Promise<string | undefined> {
  const file = await findTranscript(sessionId)
  if (!file) return undefined

  let mtimeMs: number
  try {
    mtimeMs = (await stat(file)).mtimeMs
  } catch {
    return undefined
  }
  const cached = titleCache.get(sessionId)
  if (cached && cached.mtimeMs === mtimeMs) return cached.title

  // A small tail: these entries are frequent, and this runs for every session
  // on every listing.
  const raw = await tailBytes(file, 512_000)
  let title: string | undefined
  for (const line of raw.split('\n').reverse()) {
    if (!line.includes('"custom-title"')) continue
    try {
      const entry = JSON.parse(line) as { type?: string; customTitle?: unknown }
      if (entry.type === 'custom-title' && typeof entry.customTitle === 'string' && entry.customTitle.trim()) {
        title = entry.customTitle.trim()
        break
      }
    } catch {
      // Truncated or malformed line; keep looking.
    }
  }
  titleCache.set(sessionId, { mtimeMs, title })
  return title
}

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

/**
 * Wording that solicits an answer without ending in a question mark.
 *
 * "Dis-moi lequel j'attaque." is a question in every sense that matters here,
 * and it ends with a full stop. Both languages this is used in are covered.
 */
const SOLICITATION =
  /\b(dis[- ]moi|dites[- ]moi|pr\u00e9viens[- ]moi|veux[- ]tu|voulez[- ]vous|souhaites[- ]tu|souhaitez[- ]vous|dois[- ]je|tu veux que|je te laisse choisir|\u00e0 toi de voir|let me know|tell me which|which one do you|do you want me|would you like me|shall i|should i proceed|your call)\b/i

/**
 * Does the session's closing turn put a question to the user?
 *
 * A session that ends its turn by asking something goes idle exactly like one
 * that finished the job, so without this the caller reports "finished" and the
 * user never learns a decision is pending. Nothing in the transcript marks it —
 * an asked question is ordinary assistant text — so detection is by wording,
 * over the last few lines only, where a closing question actually sits.
 */
export function asksForInput(turns: Turn[]): boolean {
  const last = [...turns].reverse().find(t => t.role === 'assistant' && t.text.trim())
  if (!last) return false
  const lines = last.text.split('\n').map(l => l.trim()).filter(Boolean).slice(-3)
  // Trailing markdown would hide the question mark from a naive endsWith.
  if (lines.some(l => /\?$/.test(l.replace(/[*_`~)\]]+$/, '').trim()))) return true
  return lines.some(l => SOLICITATION.test(l))
}

/** A questionnaire the session put up and is blocked on. */
export interface PendingQuestion {
  question: string
  header?: string
  multiSelect: boolean
  options: Array<{ label: string; description?: string }>
}

/**
 * The questionnaire a session is currently blocked on, if any.
 *
 * AskUserQuestion renders as a form in the session's own UI, which a relayed
 * client never sees: it only ever saw the tool's name go by. Reading the choices
 * out of the transcript is what lets the question be read aloud and answered
 * from a phone. A call with no matching tool_result is one still waiting.
 */
export async function readPendingQuestions(sessionId: string): Promise<PendingQuestion[]> {
  const file = await findTranscript(sessionId)
  if (!file) return []
  const raw = await tailBytes(file, 1_000_000)

  let pending: { id: string; questions: PendingQuestion[] } | undefined
  const answered = new Set<string>()

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let entry: TranscriptEntry
    try {
      entry = JSON.parse(line) as TranscriptEntry
    } catch {
      continue
    }
    const content = entry.message?.content
    if (!Array.isArray(content)) continue

    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type === 'tool_use' && block.name === 'AskUserQuestion') {
        const input = block.input as { questions?: unknown } | undefined
        const raw = Array.isArray(input?.questions) ? input.questions : []
        const questions = raw
          .filter((q): q is Record<string, unknown> => typeof q === 'object' && q !== null)
          .map(q => ({
            question: String(q.question ?? '').trim(),
            header: typeof q.header === 'string' ? q.header : undefined,
            multiSelect: q.multiSelect === true,
            options: (Array.isArray(q.options) ? q.options : [])
              .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
              .map(o => ({
                label: String(o.label ?? '').trim(),
                description: typeof o.description === 'string' ? o.description : undefined,
              }))
              .filter(o => o.label),
          }))
          .filter(q => q.question)
        if (questions.length > 0 && typeof block.id === 'string') pending = { id: block.id, questions }
      } else if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        answered.add(block.tool_use_id)
      }
    }
  }

  if (!pending || answered.has(pending.id)) return []
  return pending.questions
}

/** Render a questionnaire so it can be read aloud and answered in words. */
export function formatQuestions(questions: PendingQuestion[]): string {
  return questions
    .map(q => {
      const options = q.options.map((o, i) => `  ${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`)
      const note = q.multiSelect ? ' (several answers allowed)' : ''
      return `${q.header ? `[${q.header}] ` : ''}${q.question}${note}\n${options.join('\n')}`
    })
    .join('\n\n')
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
