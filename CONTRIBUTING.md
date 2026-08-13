# Contributing

Issues and pull requests are welcome.

## Getting set up

```bash
npm install
npm run build
node scripts/probe.mjs      # discovery + auth-key derivation, sends nothing
```

`probe.mjs` is the fastest way to tell whether this still works against your Claude Code
version. If it lists your live sessions with `keyFile=` resolved, the hard part is working.

## The thing to keep in mind

This talks to an internal, undocumented interface of the Claude Code CLI. There is no
compatibility promise from upstream, so:

- **Fail visibly, never silently.** If the registry shape, the socket path, or the frame format
  changes, say so in the tool result. A wrong answer is worse than an error.
- **Record what you observed, not what you assumed.** The protocol notes in the README cite
  concrete evidence — a field name, a status value, a timing. Keep that standard; it is what
  makes the next breakage diagnosable.
- **Treat client behaviour as a constraint, not a bug.** Much of the design exists because MCP
  clients abort at 60s, cache tool lists, and stop polling when results repeat. Comments explain
  those trade-offs; please keep them current if you change the timing.

## Testing

There is no unit suite — the interesting behaviour is all integration. The scripts under
`scripts/` drive a real server against real sessions:

```bash
node scripts/e2e.mjs <session>        # stdio client, send + wait
node scripts/e2e-poll.mjs <session>   # send_message + get_reply loop
node scripts/e2e-http.mjs             # Streamable HTTP, incl. auth rejection
```

Spawn a throwaway session to test against rather than using one you care about. If you spawn it
from inside another Claude Code session, unset `CLAUDE_CODE_CHILD_SESSION` first — otherwise it
is treated as nested, session persistence is disabled, and it never registers a socket.

## Style

Match the surrounding code. Comments should explain *why* a non-obvious choice was made, not
restate what the line does.
