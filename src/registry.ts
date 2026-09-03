import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { defaultSocketPathFor, sessionsDir } from './paths.js'
import { readSessionTitle } from './transcript.js'

/** Shape of ~/.claude/sessions/<pid>.json, as written by the CLI's session registry. */
export interface SessionRecord {
  pid: number
  sessionId: string
  cwd: string
  startedAt?: number
  /** /proc/<pid>/stat field 22 on Linux; guards against pid reuse. */
  procStart?: string
  procStartFt?: string
  version?: string
  peerProtocol?: number
  kind?: string
  entrypoint?: string
  name?: string
  nameSource?: string
  status?: string
  updatedAt?: number
  statusUpdatedAt?: number
  /** Present only once the session has bound its cross-session inbox. */
  messagingSocketPath?: string
  /** The session's Remote Control session, if it is mirrored to claude.ai. */
  bridgeSessionId?: string
}

export interface LiveSession extends SessionRecord {
  /** Resolved socket path, present only when a socket actually exists on disk. */
  socketPath?: string
  /**
   * What the user actually calls this session, as shown in Remote Control.
   * The registry's `name` is derived from the working directory and is often
   * not the name the user would use.
   */
  title?: string
  /** Title if there is one, otherwise the derived name. */
  label: string
  /** True when this session is mirrored to claude.ai / the mobile app. */
  remoteControlled: boolean
}

const PID_JSON = /^(\d+)\.json$/

/**
 * Read /proc/<pid>/stat's starttime field the same way the CLI does. The comm
 * field is parenthesised and may itself contain spaces, so we split after the
 * last ')'.
 */
async function procStartOf(pid: number): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8')
    return raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19]
  } catch {
    return undefined
  }
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * A registry entry outlives its process when the CLI is killed abruptly, so a
 * record only counts as live if the pid is running *and* its start time still
 * matches the one recorded at registration.
 */
async function isLive(record: SessionRecord): Promise<boolean> {
  if (!pidExists(record.pid)) return false
  if (record.procStart === undefined) return true
  const actual = await procStartOf(record.pid)
  return actual === undefined || actual === record.procStart
}

async function resolveSocket(record: SessionRecord): Promise<string | undefined> {
  const candidate = record.messagingSocketPath ?? defaultSocketPathFor(record.pid)
  try {
    const st = await stat(candidate)
    return st.isSocket() ? candidate : undefined
  } catch {
    return undefined
  }
}

/** Enumerate every Claude Code session currently running for this user. */
export async function listSessions(): Promise<LiveSession[]> {
  const dir = sessionsDir()
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  const records = await Promise.all(
    entries.map(async (file): Promise<SessionRecord | undefined> => {
      if (!PID_JSON.test(file)) return undefined
      try {
        const parsed = JSON.parse(await readFile(path.join(dir, file), 'utf8')) as SessionRecord
        return typeof parsed?.pid === 'number' && typeof parsed?.sessionId === 'string'
          ? parsed
          : undefined
      } catch {
        return undefined
      }
    }),
  )

  const live: LiveSession[] = []
  for (const record of records) {
    if (!record || !(await isLive(record))) continue
    const title = await readSessionTitle(record.sessionId)
    live.push({
      ...record,
      title,
      label: title ?? record.name ?? record.sessionId.slice(0, 8),
      socketPath: await resolveSocket(record),
      remoteControlled: typeof record.bridgeSessionId === 'string',
    })
  }
  live.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  return live
}

/**
 * Resolve a user-supplied reference — display name, session UUID, or pid — to a
 * single live session. Names are matched case-insensitively and a session UUID
 * may be abbreviated as long as the prefix is unambiguous.
 */
export async function resolveSession(ref: string): Promise<LiveSession> {
  const sessions = await listSessions()
  if (sessions.length === 0) throw new Error('No live Claude Code sessions found.')

  const needle = ref.trim()
  const lower = needle.toLowerCase()
  const matches = sessions.filter(
    s =>
      String(s.pid) === needle ||
      s.sessionId === needle ||
      s.name?.toLowerCase() === lower ||
      s.title?.toLowerCase() === lower ||
      s.sessionId.startsWith(lower),
  )

  if (matches.length === 1) return matches[0]!
  if (matches.length === 0) {
    const known = sessions.map(s => s.label).join(', ')
    throw new Error(`No live session matches '${ref}'. Live sessions: ${known}`)
  }
  const ambiguous = matches.map(s => `${s.label} [${s.sessionId.slice(0, 8)}]`).join(', ')
  throw new Error(`'${ref}' is ambiguous — it matches ${ambiguous}. Use the pid or a longer session id.`)
}
