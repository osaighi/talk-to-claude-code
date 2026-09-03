import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ReceiptListener, renameSession, sendUserMessage } from './peer.js'
import { assertWritable, isReadOnly } from './policy.js'
import { listSessions, resolveSession, type LiveSession } from './registry.js'
import { findDeliveredAt, formatTurns, readTurns, type Turn } from './transcript.js'
import { brief, logCall } from './log.js'

/** Shared across every MCP session this process serves. */
export const receipts = new ReceiptListener()

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] }
}

function failure(err: unknown) {
  return { content: [{ type: 'text' as const, text: String(err instanceof Error ? err.message : err) }], isError: true }
}

function describe(session: LiveSession): string {
  const bits = [
    `name: ${session.label}`,
    ...(session.title && session.title !== session.name ? [`registry name: ${session.name}`] : []),
    `id: ${session.sessionId}`,
    `pid: ${session.pid}`,
    `cwd: ${session.cwd}`,
    `status: ${session.status ?? 'unknown'}`,
    `reachable: ${session.socketPath ? 'yes' : 'no (no messaging socket)'}`,
    `remote control: ${session.remoteControlled ? session.bridgeSessionId : 'not mirrored'}`,
  ]
  if (session.version) bits.push(`version: ${session.version}`)
  return bits.join('\n  ')
}

/** Re-read a session's registry record so we see fresh status transitions. */
async function refresh(session: LiveSession): Promise<LiveSession> {
  const current = await listSessions()
  return current.find(s => s.sessionId === session.sessionId) ?? session
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Anchor replies on the moment the session actually dequeued our prompt, not
 * on when we sent it — otherwise output from whatever it was already doing gets
 * reported as the answer.
 *
 * A queued message only reaches the transcript when the session picks it up, so
 * this is opportunistic: it resolves at once against an idle session and gives
 * up quickly against a busy one rather than burning the caller's time budget.
 */
async function anchorFor(session: LiveSession, message: string, fallback: string): Promise<string | undefined> {
  for (let i = 0; i < 8; i++) {
    const at = await findDeliveredAt(session.sessionId, message)
    if (at) return at
    await sleep(375)
  }
  return undefined
}

/**
 * Prompts delivered to a busy session, still waiting their turn in its queue.
 *
 * Until the session dequeues one, everything it emits belongs to earlier work.
 * Reporting those turns as the answer is the mis-attribution this guards
 * against: get_reply re-checks this on every poll and only starts reading from
 * the moment our prompt was actually picked up.
 */
const pendingDelivery = new Map<string, { text: string; sentAt: string }>()

/**
 * The last prompt delivered to each session, to catch a client re-sending one.
 *
 * Clients do re-send — after a short return, or when they lose track of a call.
 * Two copies of the same request queue up behind each other, so the answers
 * arrive shifted by one and every later poll reports the wrong one. Refusing the
 * duplicate while the first is still in flight is cheaper than untangling that.
 */
const lastSend = new Map<string, { text: string; sentAt: string; cursor: string }>()

/** How long after a prompt a still-silent session counts as starting up, not finished. */
const STARTUP_GRACE_MS = 12_000

/**
 * MCP clients cancel a request after 60s by default — the SDK's
 * DEFAULT_REQUEST_TIMEOUT_MSEC. A tool that blocks longer never returns an
 * answer, it returns a timeout error, and a client that retries then re-sends
 * the whole prompt. So every call here stays comfortably under that ceiling and
 * hands back a cursor instead of waiting.
 */
const MAX_WAIT_SECONDS = 45

/**
 * get_reply is capped tighter than the client deadline allows, so each return is
 * an opportunity for the client to say something to a user who may be driving.
 *
 * Do not shorten this further. Halving the wait doubles the number of polls a
 * task needs, and clients abandon the loop somewhere in that sequence: at 25-30s
 * one client polled 16 and 18 times to completion, at 12s it stopped after 3 and
 * missed an answer that landed five seconds later.
 */
const NARRATION_WAIT_SECONDS = 30

/**
 * Floor on how long a poll waits, whatever the client asks for.
 *
 * Clients pick their own values and pick them short — one asked for 12s and 15s
 * against a documented default of 25 — which multiplies the polls a task needs
 * and the chances of the loop being abandoned. This costs nothing when there is
 * nothing to wait for: the wait is a ceiling, and an idle session settles and
 * returns in about a second regardless.
 */
const MIN_WAIT_SECONDS = 20

/**
 * This server is a conduit between the user and another agent. A client that
 * paraphrases in either direction corrupts the channel, so the expectation is
 * stated in the server instructions, restated on the parameter the client is
 * about to fill in, and restated again on the answer it is about to report.
 */
const ROUTING_RULE =
  'WHEN TO USE THIS: any question or instruction about the user\'s own projects, code, repositories, ' +
  'machine, builds, deployments or work in progress belongs to a session — relay it. You do not know ' +
  'what is on their disk, and neither does a web search. Do not answer from your own knowledge, do not ' +
  'search the web, and do not ask clarifying questions the session could answer better: pass it through ' +
  'and let the session look. Answer in your own voice only when the user asks about you, or about how ' +
  'this connector itself works.\n\n'

const RELAY_DISCIPLINE =
  'Relay discipline: you are a conduit to another agent, not an intermediary who improves on either side. ' +
  "Pass the user's request through word for word, in their original language — never rephrase, translate, " +
  'shorten, expand, or bolt on context they did not write. Report the session\'s output back verbatim rather ' +
  'than summarising it: the user wants the other agent\'s words, not your rendition of them. Speak in your ' +
  'own voice only when the user asks you a question directly.'

/**
 * One short line describing a turn, meant to be read aloud. Voice clients get
 * a spoken update per turn, so it has to be a sentence, not a transcript dump.
 */
export function speak(turn: Turn): string {
  if (turn.tools?.length) {
    const unique = [...new Set(turn.tools)]
    return `Running ${unique.join(', ')}`
  }
  const line = turn.text.split('\n').find(l => l.trim().length > 0)?.trim() ?? ''
  return line.length > 140 ? `${line.slice(0, 140)}…` : line || 'Thinking'
}

/** Sits on the parameter the client is about to fill in — the highest-leverage spot. */
const VERBATIM =
  "The prompt to deliver, copied word for word from what the user wrote, in their original language. " +
  'Do not rephrase, translate, summarise, expand, or add framing of your own — the receiving agent must ' +
  "see the user's exact words. Only compose your own wording if the user explicitly asked you to."

/**
 * An unfinished result is the failure point in practice: clients treat it as an
 * answer and stop. So it is phrased as an unmet obligation, not as information —
 * and it says explicitly not to close the turn, because that is the behaviour
 * that strands the user.
 */
const CONTINUE_DIRECTIVE = (cursor: string, now?: string) =>
  'INCOMPLETE — this is not the answer. The session is still working.\n' +
  'REQUIRED, in this order:\n' +
  `  1. Tell the user out loud where things stand, in one short sentence${now ? `: "${now}"` : ''}. ` +
  'The user is often driving and hears nothing while you stay silent, so never chain these calls quietly.\n' +
  `  2. Then call get_reply again with since="${cursor}".\n` +
  'Repeat until state=finished. Never re-send the original prompt — it is already queued and would run twice.\n' +
  'If you do stop polling, say so plainly: report what you last saw as what you last saw, not as the outcome. ' +
  'The session keeps working after you stop looking, and it often finishes seconds later.'

/** Appended to a completed answer, where the client is about to decide how to report it. */
const RELAY_FOOTER = '\n\n(Report the session\'s answer above verbatim. Do not summarise or rewrite it.)'

interface Progress {
  turns: Awaited<ReturnType<typeof readTurns>>
  /** Pass back as `since` to continue without repeating what was already shown. */
  cursor: string
  /** True when the session finished this turn and is waiting for input again. */
  done: boolean
  status: string
  /** Seconds since the prompt was picked up, so each poll differs even with no output. */
  elapsedSeconds: number
}

/**
 * Watch a session until it settles or the budget runs out.
 *
 * A session flips away from `idle` while it works, so "finished" means back to
 * `idle` *and* no longer producing turns. Returning a cursor on every path is
 * what lets a caller poll in short hops instead of blocking on one long call —
 * a remote client driving this over a tunnel cannot afford to sit and wait.
 */
export async function collectSince(
  session: LiveSession,
  since: string,
  budgetMs: number,
  onActivity?: (summary: string, count: number) => void,
): Promise<Progress> {
  const deadline = Date.now() + budgetMs
  let turns = await readTurns(session.sessionId, { since, limit: 50 })
  let status = (await refresh(session)).status ?? 'unknown'
  let seen = turns.length
  let idleStreak = status === 'idle' ? 1 : 0

  // A session takes a moment to pick a queued message up, during which it still
  // reads as idle. Without this grace window a poll issued right after a send
  // would report "finished" before any work had started. An old cursor is past
  // the window, so an already-drained conversation still settles immediately.
  const sinceMs = Date.parse(since)
  const startingUp = () =>
    turns.length === 0 && Number.isFinite(sinceMs) && Date.now() - sinceMs < STARTUP_GRACE_MS

  // Settled means idle across consecutive polls with no new output — not
  // "produced something", since a finished turn whose output was already
  // consumed is equally finished.
  const settled = () => idleStreak >= 2 && !startingUp()

  while (!settled() && Date.now() < deadline) {
    await sleep(750)
    turns = await readTurns(session.sessionId, { since, limit: 50 })
    status = (await refresh(session)).status ?? 'unknown'
    if (turns.length > seen) {
      // Number each turn individually: sharing the batch total would emit
      // repeated step numbers for turns that arrived together.
      let step = seen
      for (const turn of turns.slice(seen)) onActivity?.(speak(turn), ++step)
      seen = turns.length
      idleStreak = 0
    } else {
      idleStreak = status === 'idle' ? idleStreak + 1 : 0
    }
  }

  return {
    turns,
    cursor: turns.at(-1)?.timestamp ?? since,
    done: settled(),
    status,
    elapsedSeconds: Number.isFinite(sinceMs) ? Math.max(0, Math.round((Date.now() - sinceMs) / 1000)) : 0,
  }
}

/** Shape of the handler `extra` we rely on, kept narrow to avoid SDK generics. */
interface HandlerExtra {
  _meta?: { progressToken?: string | number }
  sendNotification?: (n: { method: string; params: Record<string, unknown> }) => Promise<void>
}

/**
 * Stream per-turn updates to clients that asked for progress.
 *
 * This is the only push channel MCP offers during a call. Note the client must
 * opt into `resetTimeoutOnProgress` for these to extend its 60s deadline —
 * it defaults to false, so this complements short calls rather than replacing
 * them.
 */
function progressReporter(extra: HandlerExtra | undefined): ((summary: string, count: number) => void) | undefined {
  const token = extra?._meta?.progressToken
  if (token === undefined || !extra?.sendNotification) return undefined
  return (summary, count) => {
    void extra
      .sendNotification?.({
        method: 'notifications/progress',
        params: { progressToken: token, progress: count, message: summary },
      })
      .catch(() => {})
  }
}

/**
 * Lead with a machine-readable state line. A driving model has to decide
 * "poll again or stop" from this text alone, so the decision must not depend on
 * interpreting prose.
 */
function renderProgress(label: string, progress: Progress): string {
  // Elapsed time is in the header on purpose: with no new output the response
  // would otherwise be byte-identical poll after poll, and a model reading three
  // identical results concludes nothing is happening and gives up.
  const header =
    `[session=${label} state=${progress.done ? 'finished' : 'working'} ` +
    `status=${progress.status} elapsed=${progress.elapsedSeconds}s cursor="${progress.cursor}"]`

  // 'waiting' means the session wants something from a human — a permission
  // prompt or a plan to approve. Polling will never clear it, so say so.
  const blocked =
    progress.status === 'waiting'
      ? '\nThe session is waiting on human input (a permission prompt or a plan to approve). ' +
        'It cannot progress until the user acts on the machine or from Remote Control.'
      : ''

  if (progress.turns.length === 0) {
    return progress.done
      ? `${header}\nFinished, with no new output since that cursor.`
      : `${header}\nThe session has been working ${progress.elapsedSeconds}s and has not emitted a visible ` +
        'step yet. That is normal — it often reads and thinks for a minute before its first output, and a ' +
        'substantial task runs for five to ten minutes in total. Silence here is not a failure.\n' +
        `${CONTINUE_DIRECTIVE(progress.cursor)}${blocked}`
  }
  if (progress.done) {
    return `${header}\n\n${formatTurns(progress.turns)}${RELAY_FOOTER}`
  }
  // Front-load one speakable line: a voice client should be able to say where
  // things stand without reading the transcript aloud.
  const now = speak(progress.turns[progress.turns.length - 1]!)
  return (
    `${header}\nNow: ${now} (${progress.turns.length} step(s) so far)${blocked}\n\n` +
    `${formatTurns(progress.turns)}\n\n${CONTINUE_DIRECTIVE(progress.cursor, now)}`
  )
}

/**
 * Build a server instance. Streamable HTTP keeps one MCP session per client, and
 * an McpServer binds to a single transport, so each session gets its own.
 */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: 'talk-to-claude-code', version: '0.1.0' },
    {
      instructions:
        'Drives Claude Code CLI sessions running on this machine through their cross-session messaging socket. ' +
        'Messages land in the target session\'s prompt queue, so a Remote Control client (phone, claude.ai) ' +
        'watching that session stays in sync and can keep driving it at the same time.\n\n' +
        'Workflow: call list_sessions first — it names the sessions you can drive. For a quick ' +
        'question use ask. For real work use send_message, which returns a cursor, then call get_reply in a ' +
        'loop with that cursor until it reports finished. Sessions take minutes on substantial tasks, so ' +
        'expect several get_reply calls; each one returns the tools the session used, which is how you report ' +
        'progress. Never re-send a prompt because a call returned early — that queues the work twice.\n\n' +
        'Every call here returns within about 45 seconds by design, because MCP clients abort a request at 60. ' +
        'A short return is normal and is not a failure: state=working means the session is still busy and you ' +
        'must call get_reply again with the cursor. Sending the prompt again instead will run the work twice ' +
        'and still not produce an answer.\n\n' +
        'Keep it brief out loud. This is often driven by voice, so do not read identifiers, paths or version numbers aloud unless asked — names are enough. Tools take a detailed flag when the user wants more.\n\n' +
        'Speak between polls. The user may be driving and hears nothing while you chain tool calls silently, ' +
        'so each time get_reply returns state=working, say in one short sentence what the session is doing ' +
        'before calling it again. A minute of silence reads as a breakdown, even when work is progressing.\n\n' +
        'Be patient. These sessions edit code and run builds: five to ten minutes for one request is ordinary, ' +
        'and the first minute often produces no visible step at all. Several polls returning no new output do ' +
        'NOT mean it has stalled — the elapsed counter in each result shows it is still running. Give up only ' +
        'if the result says the session is waiting on human input, or if elapsed passes about fifteen minutes.\n\n' +
        ROUTING_RULE +
        RELAY_DISCIPLINE,
    },
  )

  server.registerTool(
    'list_sessions',
    {
      title: 'List Claude Code sessions',
      description:
        'Name the sessions you can drive. Returns one short line by default, because a voice client reads ' +
        'the whole result aloud. Ask for details only when the user wants them.',
      inputSchema: {
        detailed: z
          .boolean()
          .optional()
          .describe('Include cwd, status, version and Remote Control id for each session. Verbose — omit for voice.'),
        include_unreachable: z
          .boolean()
          .optional()
          .describe('Also name the sessions that cannot be messaged. They are only counted otherwise.'),
      },
    },
    async ({ detailed, include_unreachable }) => {
      try {
        const sessions = await listSessions()
        if (sessions.length === 0) return text('No live Claude Code sessions found.')

        const reachable = sessions.filter(s => s.socketPath)
        const blocked = sessions.filter(s => !s.socketPath)
        const mode = isReadOnly() ? ' (read-only: write tools disabled)' : ''

        if (detailed) {
          const shown = include_unreachable ? sessions : reachable
          const body = shown.map(s => `- ${describe(s)}`).join('\n\n')
          return text(`${shown.length} session(s):\n\n${body}${mode}`)
        }

        if (reachable.length === 0) {
          return text(
            `No session can be messaged. ${blocked.length} are running but predate the messaging socket — ` +
              'restart them on a current Claude Code.',
          )
        }

        // One speakable line. Unreachable sessions are a count, not a list:
        // naming them costs the user seconds of speech for nothing actionable.
        const names = reachable.map(s => s.label).join(', ')
        const rest = include_unreachable
          ? blocked.length > 0
            ? ` Not reachable: ${blocked.map(s => s.label).join(', ')}.`
            : ''
          : blocked.length > 0
            ? ` (${blocked.length} other${blocked.length > 1 ? 's' : ''} not reachable.)`
            : ''
        return text(`${reachable.length} session(s) you can drive: ${names}.${rest}${mode}`)
      } catch (err) {
        return failure(err)
      }
    },
  )

  server.registerTool(
    'session_status',
    {
      title: 'Get session status',
      description: 'Report the current state of one session, resolved by name, session id, or pid.',
      inputSchema: {
        session: z.string().describe('Session name, session id (or unique prefix), or pid.'),
      },
    },
    async ({ session }) => {
      try {
        return text(describe(await resolveSession(session)))
      } catch (err) {
        return failure(err)
      }
    },
  )

  server.registerTool(
    'read_transcript',
    {
      title: 'Read session transcript',
      description:
        'Read recent conversation turns from a session, including work it did while driven from a phone ' +
        'or from claude.ai. Subagent sidechains and tool plumbing are omitted.',
      inputSchema: {
        session: z.string().describe('Session name, session id (or unique prefix), or pid.'),
        limit: z.number().int().min(1).max(100).optional().describe('How many recent turns to return (default 20).'),
        include_user: z.boolean().optional().describe('Include user turns as well as assistant turns.'),
      },
    },
    async ({ session, limit, include_user }) => {
      try {
        const target = await resolveSession(session)
        const turns = await readTurns(target.sessionId, { limit, includeUser: include_user })
        return text(formatTurns(turns))
      } catch (err) {
        return failure(err)
      }
    },
  )

  server.registerTool(
    'send_message',
    {
      title: 'Send a message to a session',
      description:
        ROUTING_RULE +
        'Queue a prompt in a running session and return immediately with a cursor. The message enters that ' +
        'session as if typed, so it is also visible to any Remote Control client watching it. ' +
        'Follow up with get_reply, passing the cursor as `since`, to watch the session work. ' +
        'Prefer this over ask for anything long-running.',
      inputSchema: {
        session: z.string().describe('Session name, session id (or unique prefix), or pid.'),
        message: z.string().min(1).describe(VERBATIM),
      },
    },
    async ({ session, message }) => {
      logCall('send_message', { session, message: brief(message) })
      try {
        const target = await resolveSession(session)
        assertWritable(target)

        const label = target.label

        // Refuse an exact repeat while the first copy is still unanswered.
        const previous = lastSend.get(target.sessionId)
        if (previous && previous.text === message) {
          const busy = (await refresh(target)).status !== 'idle'
          if (busy || pendingDelivery.has(target.sessionId)) {
            const waited = Math.max(0, Math.round((Date.now() - Date.parse(previous.sentAt)) / 1000))
            logCall('send_message.duplicate', { session: label, waited })
            return text(
              `[session=${label} state=working elapsed=${waited}s cursor="${previous.cursor}"]\n` +
                'NOT SENT — this exact prompt is already running, delivered ' +
                `${waited}s ago. Sending it again would run the work twice and shift every later answer ` +
                `by one.\nCall get_reply with since="${previous.cursor}" instead.`,
            )
          }
        }

        const sentAt = new Date().toISOString()
        const result = await sendUserMessage(target, message, { receipts, receiptTimeoutMs: 3000 })

        if (result.status && result.status !== 'delivered') {
          logCall('send_message.result', { session: label, status: result.status })
          return text(`Message to '${label}' was ${result.status}. ${result.reason ?? ''}`.trim())
        }

        const anchor = await anchorFor(target, message, sentAt)
        const cursor = anchor ?? sentAt
        const queued = anchor === undefined
        if (queued) pendingDelivery.set(target.sessionId, { text: message, sentAt })
        else pendingDelivery.delete(target.sessionId)
        lastSend.set(target.sessionId, { text: message, sentAt, cursor })
        logCall('send_message.result', { session: label, cursor, anchored: anchor !== undefined, queued })

        return text(
          `[session=${label} state=${queued ? 'queued' : 'sent'} cursor="${cursor}"]\n` +
            (queued
              ? 'The session is finishing earlier work; your prompt waits its turn in the queue.\n'
              : '') +
            'Prompt delivered. You will NOT receive the answer here.\n' +
            `Next required call: get_reply session="${label}" since="${cursor}"\n` +
            'Repeat that call until it reports state=finished. Do not re-send this prompt.',
        )
      } catch (err) {
        return failure(err)
      }
    },
  )

  server.registerTool(
    'get_reply',
    {
      title: 'Poll a session for new output',
      description:
        'Watch a session and return whatever it produced since the given cursor, along with a fresh cursor. ' +
        'Blocks for at most wait_seconds, then returns what it has — so call it repeatedly to follow a long task. ' +
        'The result says whether the session finished or is still working. If it is still working, call this ' +
        'again with the returned cursor. Assistant turns list the tools the session used, which is the ' +
        'progress signal while a task is underway.',
      inputSchema: {
        session: z.string().describe('Session name, session id (or unique prefix), or pid.'),
        since: z
          .string()
          .optional()
          .describe('Cursor from a previous send_message/get_reply call. Omit to read from now on.'),
        wait_seconds: z
          .number()
          .int()
          .min(1)
          .max(NARRATION_WAIT_SECONDS)
          .optional()
          .describe(
            'How long to wait for activity before returning (default 25). Values below 20 are raised to 20: ' +
              'short waits mean more polls for the same task, and every extra poll is another chance to lose ' +
              'the thread. It returns as soon as the session settles, so a longer wait costs nothing.',
          ),
      },
    },
    async ({ session, since, wait_seconds }, extra) => {
      logCall('get_reply', { session, since, wait_seconds })
      try {
        const target = await resolveSession(session)
        const label = target.label
        let from = since ?? new Date().toISOString()

        // If the last prompt was still queued, everything before the session
        // picked it up belongs to the previous request. Re-check delivery here
        // and move the cursor forward rather than reporting the wrong answer.
        const pending = pendingDelivery.get(target.sessionId)
        if (pending) {
          const at = await findDeliveredAt(target.sessionId, pending.text)
          if (at) {
            pendingDelivery.delete(target.sessionId)
            if (at > from) from = at
          } else {
            const status = (await refresh(target)).status ?? 'unknown'
            if (status !== 'idle') {
              const waited = Math.max(0, Math.round((Date.now() - Date.parse(pending.sentAt)) / 1000))
              logCall('get_reply.result', { session: label, state: 'queued', waited })
              return text(
                `[session=${label} state=queued status=${status} elapsed=${waited}s cursor="${from}"]\n` +
                  'Your prompt is delivered but still waiting its turn — the session is finishing earlier ' +
                  'work, and anything it produces right now answers that, not you.\n' +
                  `${CONTINUE_DIRECTIVE(from)}`,
              )
            }
            // Idle without a trace of it: the message was consumed some other
            // way, or dropped. Stop withholding output on its account.
            pendingDelivery.delete(target.sessionId)
          }
        }

        const progress = await collectSince(
          target,
          from,
          Math.max(MIN_WAIT_SECONDS, Math.min(wait_seconds ?? 25, NARRATION_WAIT_SECONDS)) * 1000,
          progressReporter(extra as HandlerExtra),
        )
        logCall('get_reply.result', { session: label, state: progress.done ? 'finished' : 'working', turns: progress.turns.length })
        return text(renderProgress(label, progress))
      } catch (err) {
        return failure(err)
      }
    },
  )

  server.registerTool(
    'ask',
    {
      title: 'Ask a session and wait for its reply',
      description:
        ROUTING_RULE +
        'Send a prompt and wait for the answer in one call. Best for short questions. If the session is still ' +
        'working when the wait runs out, this returns the output so far plus a cursor — continue with get_reply ' +
        'rather than calling ask again, which would send the prompt a second time.',
      inputSchema: {
        session: z.string().describe('Session name, session id (or unique prefix), or pid.'),
        message: z.string().min(1).describe(VERBATIM),
        timeout_seconds: z
          .number()
          .int()
          .min(5)
          .max(NARRATION_WAIT_SECONDS)
          .optional()
          .describe(
            `How long to wait before returning partial output and a cursor (default 25, max ${NARRATION_WAIT_SECONDS}). ` +
              'Capped deliberately: MCP clients abort a request at 60s.',
          ),
      },
    },
    async ({ session, message, timeout_seconds }, extra) => {
      logCall('ask', { session, message: brief(message), timeout_seconds })
      try {
        const target = await resolveSession(session)
        assertWritable(target)

        const sentAt = new Date().toISOString()
        const result = await sendUserMessage(target, message, { receipts, receiptTimeoutMs: 3000 })
        const label = target.label

        if (result.status && result.status !== 'delivered') {
          logCall('ask.result', { session: label, status: result.status })
          return text(`Message to '${label}' was ${result.status}. ${result.reason ?? ''}`.trim())
        }

        const anchored = await anchorFor(target, message, sentAt)
        if (anchored === undefined) pendingDelivery.set(target.sessionId, { text: message, sentAt })
        else pendingDelivery.delete(target.sessionId)
        const since = anchored ?? sentAt
        const budget = Math.min(timeout_seconds ?? 25, NARRATION_WAIT_SECONDS) * 1000
        const progress = await collectSince(target, since, budget, progressReporter(extra as HandlerExtra))
        logCall('ask.result', { session: label, state: progress.done ? 'finished' : 'working', turns: progress.turns.length })
        return text(renderProgress(label, progress))
      } catch (err) {
        return failure(err)
      }
    },
  )

  server.registerTool(
    'rename_session',
    {
      title: 'Rename a session',
      description: 'Change a session\'s display name, as shown in its prompt box and session pickers.',
      inputSchema: {
        session: z.string().describe('Session name, session id (or unique prefix), or pid.'),
        name: z.string().min(1).max(80).describe('The new display name.'),
      },
    },
    async ({ session, name }) => {
      try {
        const target = await resolveSession(session)
        assertWritable(target)
        await renameSession(target, name)
        return text(`Renamed session ${target.sessionId.slice(0, 8)} to '${name}'.`)
      } catch (err) {
        return failure(err)
      }
    },
  )

  return server
}
