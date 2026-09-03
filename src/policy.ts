import type { LiveSession } from './registry.js'

/**
 * Write access is deliberately conservative: reading the fleet is always
 * allowed, but anything that pushes work into a session can be narrowed, and
 * the session hosting this server is never a valid target.
 *
 *   CLAUDE_REMOTE_MCP_READONLY=1     disable every write tool
 *   CLAUDE_REMOTE_MCP_ALLOW=a,b      only these sessions accept writes
 *   CLAUDE_REMOTE_MCP_DENY=c,d       these sessions never accept writes
 *   CLAUDE_REMOTE_MCP_ALLOW_SELF=1   permit writing to our own host session
 */
function list(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean)
}

function flag(name: string): boolean {
  const value = process.env[name]
  return value === '1' || value === 'true'
}

export function isReadOnly(): boolean {
  return flag('CLAUDE_REMOTE_MCP_READONLY')
}

/**
 * The session that launched this server passes its inbox path down to child
 * processes, which is how we recognise ourselves and refuse to build a loop.
 */
function isHostSession(session: LiveSession): boolean {
  const own = process.env.CLAUDE_CODE_MESSAGING_SOCKET
  return own !== undefined && session.socketPath === own
}

function matches(session: LiveSession, entries: string[]): boolean {
  const identifiers = [
    session.name?.toLowerCase(),
    session.title?.toLowerCase(),
    session.sessionId.toLowerCase(),
    String(session.pid),
  ].filter(
    (value): value is string => value !== undefined,
  )
  return entries.some(entry => identifiers.includes(entry))
}

/** Throw with an actionable message if this session may not be written to. */
export function assertWritable(session: LiveSession): void {
  const label = session.label

  if (isReadOnly()) {
    throw new Error('This server is running read-only (CLAUDE_REMOTE_MCP_READONLY=1). No messages can be sent.')
  }
  if (isHostSession(session) && !flag('CLAUDE_REMOTE_MCP_ALLOW_SELF')) {
    throw new Error(
      `Refusing to message '${label}': it is the session hosting this MCP server, ` +
        'so the message would feed back into this conversation. Set CLAUDE_REMOTE_MCP_ALLOW_SELF=1 to override.',
    )
  }

  const deny = list('CLAUDE_REMOTE_MCP_DENY')
  if (deny.length > 0 && matches(session, deny)) {
    throw new Error(`Session '${label}' is listed in CLAUDE_REMOTE_MCP_DENY.`)
  }

  const allow = list('CLAUDE_REMOTE_MCP_ALLOW')
  if (allow.length > 0 && !matches(session, allow)) {
    throw new Error(
      `Session '${label}' is not in CLAUDE_REMOTE_MCP_ALLOW (${allow.join(', ')}), so it cannot be messaged.`,
    )
  }
}
