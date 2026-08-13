import { sendUserMessage } from './peer.js'
import { assertWritable } from './policy.js'
import { resolveSession } from './registry.js'
import { collectSince, speak } from './server.js'
import { brief, logCall } from './log.js'

/**
 * Spoken-word surface, driven by Siri Shortcuts.
 *
 * CarPlay only offers voice, and ChatGPT's voice mode cannot reach MCP
 * connectors at all, so this bypasses MCP entirely: plain text in, plain text
 * out, short enough to be read aloud while driving.
 */

/**
 * Last position read out per session, so a Shortcut can simply keep asking
 * "what's new" without tracking a cursor it would have to parse and store.
 */
const cursors = new Map<string, string>()

/** Strip markup that a speech synthesiser would read out as noise. */
function speakable(input: string): string {
  return input
    .replace(/```[\s\S]*?```/g, ' code block omitted. ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Keep an utterance short enough to stay listenable at the wheel. */
function trim(text: string, max = 700): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(', '))
  return `${cut.slice(0, stop > max / 2 ? stop + 1 : max)} … Ask for the rest if you want it.`
}

function answerFrom(turns: Awaited<ReturnType<typeof collectSince>>['turns']): string {
  const spoken = turns.filter(t => t.role === 'assistant' && t.text.trim()).at(-1)
  return spoken ? trim(speakable(spoken.text)) : ''
}

/** Deliver a prompt and answer immediately if the session is quick about it. */
export async function voiceAsk(session: string, message: string, waitSeconds: number): Promise<string> {
  logCall('voice.ask', { session, message: brief(message) })
  const target = await resolveSession(session)
  assertWritable(target)

  const sentAt = new Date().toISOString()
  const result = await sendUserMessage(target, message)
  if (result.status && result.status !== 'delivered') {
    return `The session did not accept that: it was ${result.status}.`
  }

  cursors.set(target.sessionId, sentAt)
  const progress = await collectSince(target, sentAt, Math.max(5, Math.min(waitSeconds, 40)) * 1000)
  cursors.set(target.sessionId, progress.cursor)

  if (progress.done) {
    const answer = answerFrom(progress.turns)
    return answer || 'Done, but it did not say anything.'
  }
  const last = progress.turns.at(-1)
  return last
    ? `Working on it. ${speak(last)}. Ask me for an update in a moment.`
    : 'Sent. It has not started yet. Ask me for an update in a moment.'
}

/** Next slice of progress, phrased to be spoken. */
export async function voiceReply(session: string, since: string | undefined, waitSeconds: number): Promise<string> {
  logCall('voice.reply', { session, since })
  const target = await resolveSession(session)
  const from = since ?? cursors.get(target.sessionId) ?? new Date().toISOString()

  const progress = await collectSince(target, from, Math.max(5, Math.min(waitSeconds, 40)) * 1000)
  cursors.set(target.sessionId, progress.cursor)

  if (progress.status === 'waiting') {
    return 'It is waiting for you to approve something. You will have to do that on the machine or from Remote Control.'
  }
  if (progress.done) {
    const answer = answerFrom(progress.turns)
    return answer || 'Nothing new. It is finished and idle.'
  }
  const last = progress.turns.at(-1)
  return last ? `Still working. ${speak(last)}.` : 'Still working. Nothing new yet.'
}
