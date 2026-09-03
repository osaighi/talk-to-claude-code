# talk-to-claude-code

**Drive your Claude Code sessions by voice, hands-free, from any MCP client.**

Ask Grok — or Claude, or your own script — to give a task to a Claude Code session
running on your machine, hear what it is doing while it works, and get the answer read back. It
was built to work from a car: Grok's voice mode on CarPlay reaches custom MCP connectors, so the
whole loop runs without touching a keyboard.

It works by injecting messages into the target session's prompt queue as if they had been typed,
through the cross-session messaging inbox the CLI already uses to talk to its peers. Because the
prompt lands in the normal queue, a Remote Control client — your phone, or claude.ai/code — can
watch and drive the *same* session at the same time. There is no proxy, no patched binary, and
no interception of the Remote Control connection.

```
you (voice) ──> Grok ──> MCP ──> talk-to-claude-code ──> Claude Code session
                 ▲                                              │
                 └────── "Running Read… 4 steps so far" ─────────┘
```

The hard part is not the transport, it is keeping a remote model in the loop for the five to ten
minutes a real coding task takes. Most of the design exists for that: short polls that always
return a cursor, an elapsed counter so no two polls look alike, progress notifications, and
result text written to tell the client what to do next. See
[Driving a session](#driving-a-session).

> [!WARNING]
> **This lets whatever you connect it to run code on your machine.** It queues prompts into
> Claude Code sessions, and those sessions edit files and run shell commands. Anything that can
> reach this server — including a model that has been prompt-injected — inherits that reach.
> Do not expose it to the internet without a secret, and prefer narrowing it to one session with
> `CLAUDE_REMOTE_MCP_ALLOW`, or `CLAUDE_REMOTE_MCP_READONLY=1` when you only want observation.

> [!NOTE]
> Unofficial, and not affiliated with or endorsed by Anthropic. It talks to an **internal,
> undocumented** interface of the Claude Code CLI, reconstructed by inspection (see
> [Protocol notes](#protocol-notes)). It works against the versions listed under Requirements and
> may break on any update. `scripts/probe.mjs` is there to tell you quickly when it does.

## Why this channel

Claude Code has three separate remote surfaces. Only one of them is a good foundation:

| Channel | Transport | Redirectable? |
|---|---|---|
| Device bridge | `wss://bridge.claudeusercontent.com/devices/…` — JSON-RPC/MCP, exposes `device_bash` + `get_device_info` | Yes, via `CLAUDE_REMOTE_TOOLS_BRIDGE_URL` (the dial validator has an explicit loopback carve-out) |
| Remote Control | `POST {BASE_API_URL}/v1/sessions` + `wss://…/v2/ccr-sessions/…` | **No** — `getBridgeBaseUrlOverride()` / `getBridgeTokenOverride()` compile to `return undefined` in release builds |
| Cross-session inbox | Unix domain socket, NDJSON | n/a — it is local by construction |

Redirecting the device bridge only buys you `device_bash`, and routes your OAuth token through
a proxy. Redirecting Remote Control needs a binary patch or TLS interception, and breaks on
every CLI update.

The cross-session inbox is orthogonal to Remote Control: the phone talks to the session over the
bridge, this server talks to it over the socket, and both stay in sync because both end up in the
same transcript.

## Requirements

- Node 22+
- Claude Code **2.1.229 or newer** in the target sessions. Older sessions register themselves but
  do not bind a messaging socket, so they show up as `reachable: no` and cannot be driven.
  Restart them on a current version to make them reachable.

## Install

```bash
npm install
npm run build
```

Register it with Claude Code:

```bash
claude mcp add talk-to-claude-code -- node /path/to/talk-to-claude-code/dist/index.js
```

Or in an MCP client config:

```json
{
  "mcpServers": {
    "talk-to-claude-code": {
      "command": "node",
      "args": ["/path/to/talk-to-claude-code/dist/index.js"]
    }
  }
}
```

## Connecting Grok (the voice path)

Grok is the client this was built around, because it is the one that closes the loop end to end:
its voice mode reaches custom MCP connectors, it ships on CarPlay, and it polls patiently instead
of giving up after one call.

Grok calls your server from its own infrastructure, so it needs a public HTTPS URL. Run HTTP
mode behind a tunnel of your choice — Tailscale Funnel gives a stable hostname without a
domain, which matters because a connector has to be reconfigured every time the URL changes:

```bash
bash scripts/serve-tailscale.sh       # READONLY=1 to expose observation only
bash scripts/serve-tailscale.sh --stop
```

That generates a secret on first run and reuses it afterwards, starts the server, puts it behind
Funnel and prints the connector settings. The hostname is stable, so the connector is configured
once and later restarts stay invisible to it — worth the setup, because reconfiguring a connector
after every restart gets old fast.

Funnel only accepts ports 443, 8443 and 10000; the script defaults to 8443 and leaves any
existing mapping on 443 alone. Override with `FUNNEL_PORT=` and `PORT=`.

Without Tailscale, `scripts/serve-public.sh` does the same through a Cloudflare quick tunnel. It
needs no account, but the URL changes on every restart:

```bash
bash scripts/serve-public.sh
```

Then add it in the app: `grok.com/connectors` → New Connector → **Custom**. Give it the URL with
the **secret in the path**, and pick no authentication:

```
https://<your-host>:8443/mcp/<token>
```

That matters. On the bare `/mcp` URL the client's first request arrives with no credentials, the
server answers `401`, and clients read that as "this server wants OAuth" — Grok then asks for a
client ID, authorize and token endpoints, none of which exist here. Putting the secret in the URL
means no request is ever unauthenticated, so the OAuth prompt never appears. A `token=` query
parameter works too.

Over the API you can instead send a proper `Authorization` header:

```jsonc
tools: [{
  "type": "mcp",
  "server_label": "talk-to-claude-code",
  "server_url": "https://<your-host>/mcp",
  "authorization": "<your token>",
  "allowed_tools": ["list_sessions", "read_transcript"]   // optional: narrow what Grok may do
}]
```

`allowed_tools` is a useful second lock: it restricts Grok to a subset regardless of what the
server exposes, and composes with `CLAUDE_REMOTE_MCP_ALLOW` on this side.

### Other clients

Any MCP client works — the server is not Grok-specific. Two things decide whether a given one is
usable for the voice case, and both are worth checking before you invest time:

1. **Does its voice mode reach custom MCP connectors?** Several assistants expose connectors in
   text chat but not in voice, which makes them useless in a car no matter how the server is set
   up. Test in voice early.
2. **Does it keep polling?** A single request cannot outlive the client's deadline, so the client
   has to call `get_reply` repeatedly. One that stops after the first `state=working` will never
   see an answer to anything that takes more than a minute.

If your client fails the first test, the [`/voice` endpoints](#voice-endpoints-siri-shortcuts)
below sidestep MCP entirely.

## Before you expose it

This server queues prompts into local Claude Code sessions, and those sessions edit files and run
shell commands. Whatever you connect — and anything that successfully prompt-injects it —
inherits that reach.

A sensible posture for anything internet-facing:

```bash
CLAUDE_REMOTE_MCP_TOKEN="$(openssl rand -hex 24)" \
CLAUDE_REMOTE_MCP_ALLOW=my-scratch-session \
node dist/index.js --http
```

That pins it to one throwaway session. Use `CLAUDE_REMOTE_MCP_READONLY=1` when you only want the
client to observe, and prefer a tunnel that gives you a private hostname over one that publishes
a guessable URL.

## Transports

| Mode | Command | Use |
|---|---|---|
| stdio (default) | `node dist/index.js` | Claude Code, Claude Desktop, any local MCP client |
| Streamable HTTP | `node dist/index.js --http` | Grok and other hosted clients, behind a tunnel |

HTTP mode binds `127.0.0.1:8787/mcp` by default and refuses to start without
`CLAUDE_REMOTE_MCP_TOKEN` unless `CLAUDE_REMOTE_MCP_NO_AUTH=1` is set. Override with `--host`,
`--port`, `--path` or `CLAUDE_REMOTE_MCP_HOST` / `_PORT` / `_PATH`.

## Tools

| Tool | Purpose |
|---|---|
| `list_sessions` | Names the sessions you can drive, in one line. `detailed` adds cwd, status and ids |
| `session_status` | State of one session |
| `read_transcript` | Recent turns, including work done from a phone |
| `send_message` | Queue a prompt, return a cursor immediately |
| `get_reply` | Poll for output since a cursor; says whether the session finished |
| `ask` | Send and wait in one call, for short questions |
| `rename_session` | Change a session's display name |

Sessions are addressed by the name you gave them, the registry name, the session id (or a unique
prefix), or the pid. Results use the name you gave: the registry only carries one derived from the
working directory — `tachify-33` for a session you call `Tachyo` — which is no help when you are
naming a session out loud. The real title lives in the transcript and is read from there.

Results are written to be read aloud: short by default, with a `detailed` flag when the user
actually wants identifiers and paths. A voice client speaks the entire tool result, so a verbose
listing costs the user half a minute of talking to say nothing they can act on.

### Driving a session

A remote client cannot sit on one long blocking call — tunnels and tool-call
budgets cut it off, and the user sees nothing meanwhile. So work is followed in
short hops:

```
send_message  -> [session=my-session state=sent cursor="2026-08-13T07:55:29.595Z"]
get_reply     -> [session=my-session state=working  ... cursor="…31.919Z"]   # tool activity so far
get_reply     -> [session=my-session state=finished ... cursor="…35.729Z"]   # answer
```

Every result leads with a machine-readable state line, so the decision to poll
again never depends on reading prose. `state=working` means call `get_reply`
again with the returned cursor; `state=finished` means stop. Assistant turns
list the tools the session used, which is the progress signal during a long
task.

### Voice endpoints (Siri Shortcuts)

If your assistant cannot reach MCP connectors from its voice mode — several
cannot — this route skips MCP altogether. Siri runs hands-free in CarPlay
without any special entitlement, and a Shortcut can call a URL and speak the
reply. These endpoints exist for that: plain text in, plain text out, short
enough to be read aloud.

```
GET|POST /voice/ask?session=<name>&message=<text>&wait=20
GET      /voice/reply?session=<name>&wait=15
```

Auth is the same shared secret, accepted as a `Bearer` header, any path segment,
or a `token=` query parameter — Shortcuts cannot set headers easily, so the
query form is usually simplest.

`/voice/reply` remembers where it left off per session, so a Shortcut just keeps
asking "what's new" without tracking a cursor:

```
Shortcut "Ask Claude"
  1. Dictate Text                    -> spoken prompt
  2. Get contents of  …/voice/ask?session=my-session&token=…&message=[Dictated Text]
  3. Speak Text                      -> the reply, or "Working on it. Running Read."
  4. Repeat 8 times:
       Get contents of …/voice/reply?session=my-session&token=…
       Speak Text
       If it contains "Still working" -> continue, else Stop
```

Run this behind Tailscale rather than a public tunnel if you can: the phone
joins the tailnet, the endpoint stays off the public internet, and it still
works on cellular.

### Live progress

`ask` and `get_reply` emit `notifications/progress` while they wait, one per
turn the session produces, each carrying a short spoken-style line (`Running
Read`, `Checking the config…`). A client that surfaces them — a voice client in
particular — narrates the work as it happens instead of going quiet.

Two constraints shape this:

- MCP clients abort a request after 60s (`DEFAULT_REQUEST_TIMEOUT_MSEC`), and
  `resetTimeoutOnProgress` defaults to **false**, so progress notifications do
  not extend that deadline unless the client opts in. Every call here therefore
  stays under 45s and returns a cursor; progress complements short calls rather
  than replacing them.
- MCP has no way to push into a conversation between calls. Continuous
  narration comes from the client looping on `get_reply`, which is why the
  instructions insist on it.

### Relay discipline

The server is a conduit between the user and another agent, so a client that
paraphrases in either direction corrupts the channel. The expectation is stated
in three places, deliberately:

1. the server `instructions` sent at initialize,
2. the description of the `message` parameter on `send_message` and `ask` —
   the highest-leverage spot, since it sits where the client writes the value,
3. a footer on every completed answer, where the client is about to decide how
   to report back.

These are instructions, not enforcement: a model can still ignore them. Client-side
settings (your client's own system prompt or custom instructions) are a stronger lever and
compose with these.

Two details worth knowing if you change this logic:

- **Finished** means idle across consecutive polls with no new output. It does
  *not* require output in the current call — a turn whose text was already
  consumed is equally finished, and requiring output made polling never
  terminate.
- A session stays `idle` for a moment after a prompt is queued, before it picks
  it up. A poll issued in that window would otherwise report "finished" before
  any work started, so a 12s startup grace applies while no output has appeared
  yet. An older cursor is past the window and settles immediately.

## Permissions

Reads are always allowed. Writes are conservative by default and configurable by environment:

| Variable | Effect |
|---|---|
| `CLAUDE_REMOTE_MCP_READONLY=1` | Disable every write tool |
| `CLAUDE_REMOTE_MCP_ALLOW=a,b` | Only these sessions accept writes |
| `CLAUDE_REMOTE_MCP_DENY=c,d` | These sessions never accept writes |
| `CLAUDE_REMOTE_MCP_ALLOW_SELF=1` | Permit writing to the session hosting this server |

Writing to the host session is refused by default: the message would feed straight back into the
conversation that sent it.

The recipient may also gate an incoming message itself — a session in prompting mode holds peer
messages for the user's approval. That verdict comes back as a `peer_message_status` receipt
(`held` / `denied` / `expired` / `delivered`) and is surfaced in the tool result.

## Protocol notes

Reconstructed from the CLI binary (v2.1.229); this is an internal interface and may drift.

**Discovery** — `~/.claude/sessions/<pid>.json`:

```jsonc
{ "pid": 12345, "sessionId": "bf577127-1c0a-4a1e-9c2f-0d6b7e5a8f31", "cwd": "/home/you/project",
  "status": "idle", "peerProtocol": 1,
  "messagingSocketPath": "/run/user/1000/cc-socks/12345.sock",
  "bridgeSessionId": "session_01ABCDEF…" }
```

A record outlives its process after an abrupt kill, so liveness is confirmed by checking the pid
*and* matching `procStart` against `/proc/<pid>/stat` field 22.

**Auth** — the token lives at `~/.claude/sessions/<pid>.<sha256 of the canonical socket path>.key`
(mode 0600), containing `{"peerToken":"<32 hex>","procStart":"…"}`. On Linux auth is optional, but
sending it is what earns the `peer` role rather than being treated as an anonymous writer.

**Frames** — newline-delimited JSON, 1 MiB per line:

```jsonc
{"type":"auth","token":"<peerToken>"}
{"type":"user","message":{"role":"user","content":"hello"},"msg_id":"…","from":"uds:/path.sock"}
{"type":"control","action":"rename","name":"new-name"}
{"type":"control","action":"peer_message_status","status":"held","orig_msg_id":"…"}
```

**Receipts** — a recipient only replies to an address in the *same directory* as its own socket
that ends in `.sock`, so the receipt listener binds inside the shared `cc-socks` directory.

**Replies** — read from the session's transcript at
`~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`.

## Development

```bash
node scripts/probe.mjs             # discovery + auth-key derivation, sends nothing
node scripts/e2e.mjs <session>     # drives a session over a real MCP stdio client
node scripts/e2e-http.mjs          # Streamable HTTP: auth rejection, bearer, secret path
node scripts/e2e-poll.mjs <session> [prompt]   # send_message + get_reply loop
```

Note when spawning a test session from inside another Claude Code session: unset
`CLAUDE_CODE_CHILD_SESSION`, or the child is treated as nested, session persistence is disabled,
and it never registers or binds a socket.
