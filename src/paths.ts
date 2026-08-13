import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

/**
 * Claude Code keeps its per-user state under CLAUDE_CONFIG_DIR, defaulting to
 * ~/.claude. Everything this server reads hangs off that root.
 */
export function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude')
}

/** Registry of live sessions: one <pid>.json per running CLI, plus <pid>.<sha256>.key files. */
export function sessionsDir(): string {
  return path.join(configDir(), 'sessions')
}

/** Transcripts, bucketed by a slug of the session's cwd. */
export function projectsDir(): string {
  return path.join(configDir(), 'projects')
}

/**
 * Where the CLI binds its cross-session messaging sockets.
 *
 * Mirrors the CLI's own resolution: $XDG_RUNTIME_DIR/cc-socks/<pid>.sock, falling
 * back to a uid-scoped directory under /tmp when that path would exceed the
 * ~104-byte sun_path limit.
 */
export function socketDir(): string {
  const runtime = process.env.XDG_RUNTIME_DIR
  if (runtime) {
    const candidate = path.join(runtime, 'cc-socks')
    // +/ + up to 7 digits of pid + .sock still has to fit in sun_path.
    if (Buffer.byteLength(path.join(candidate, '9999999.sock')) <= 103) return candidate
  }
  const base = process.env.TERMUX_VERSION && process.env.PREFIX
    ? path.join(process.env.PREFIX, 'tmp')
    : tmpdir()
  return path.join(base, `cc-socks-${process.getuid?.() ?? 0}`)
}

export function defaultSocketPathFor(pid: number): string {
  return path.join(socketDir(), `${pid}.sock`)
}
