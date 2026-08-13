# talk-to-claude-code

**Drive your Claude Code sessions by voice, hands-free, from any MCP client.**

Ask Grok — or ChatGPT, or Claude, or your own script — to give a task to a Claude Code session
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

Grok has no equivalent of OpenAI's outbound tunnel, so the server needs a public HTTPS URL. Run
HTTP mode behind a tunnel of your choice — Tailscale Funnel gives a stable hostname without a
domain, which matters because a connector has to be reconfigured every time the URL changes:

```bash
CLAUDE_REMOTE_MCP_TOKEN="$(openssl rand -hex 24)" node dist/index.js --http
tailscale funnel --bg --https=8443 8787      # or: cloudflared tunnel --url http://127.0.0.1:8787
```

Then either add it in the app — `grok.com/connectors` → New Connector → **Custom** → your URL —
or declare it in an xAI API call. The API path accepts a proper `Authorization` header, which
ChatGPT's custom connectors cannot:

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

A note on voice, learned the hard way: ChatGPT's voice mode **cannot** reach MCP connectors at
all, and CarPlay is voice-only, which is why the `/voice` endpoints below exist as a fallback for
that stack. With Grok the connector works in voice directly and you do not need them.

## Connecting ChatGPT

ChatGPT does not speak stdio and cannot reach your machine directly — OpenAI's servers make the
calls. There are two routes. Note that neither works in **voice mode**, which has no access to
custom connectors.

### Route 1 — Secure MCP Tunnel (recommended)

OpenAI's [`tunnel-client`](https://github.com/openai/tunnel-client) runs on this machine and opens
an **outbound-only** connection to OpenAI. Nothing is exposed to the public internet, and it can
drive a stdio server directly, so no HTTP mode is needed.

Download `tunnel-client` from its
[releases](https://github.com/openai/tunnel-client/releases) into `.tools/` (or point
`TUNNEL_CLIENT` at your copy — verify the checksum against the published `SHA256SUMS.txt`).
Create a tunnel at platform.openai.com/settings/organization/tunnels and a **runtime** API key
with Tunnels Read + Use, then:

```bash
export CONTROL_PLANE_API_KEY="sk-..."
export TUNNEL_ID="tunnel_..."
bash scripts/tunnel-openai.sh              # override with PROFILE=... HEALTH_ADDR=...
```

That wraps three steps: `init` writes a `sample_mcp_stdio_local` profile pointing at
`node dist/index.js`, `doctor --explain` validates it, and `run` starts the daemon. The profile
stores only a reference (`env:CONTROL_PLANE_API_KEY`), never the key itself.

Note the three distinct credentials: `CONTROL_PLANE_TUNNEL_ID` identifies the tunnel,
`CONTROL_PLANE_API_KEY` is what the daemon runs with, and `OPENAI_ADMIN_KEY` is only for
`tunnel-client admin tunnels …`. Do not give the admin key to the daemon.

Then in ChatGPT: enable developer mode (Settings → Connectors → Advanced), create an app, choose
**Tunnel** under Connection, and pick the tunnel.

To point the tunnel at HTTP mode instead of stdio, run this server with `--http` and pass
`--mcp-server-url http://127.0.0.1:8787/mcp` to `tunnel-client init`.

### Route 2 — public HTTPS endpoint

Run HTTP mode behind your own tunnel (cloudflared, ngrok, Tailscale Funnel):

```bash
CLAUDE_REMOTE_MCP_TOKEN="$(openssl rand -hex 24)" node dist/index.js --http
cloudflared tunnel --url http://127.0.0.1:8787
```

ChatGPT custom connectors support OAuth or no-auth, but cannot attach a static bearer header —
so for a no-auth connector, put the secret in the URL and register
`https://<your-tunnel>/mcp/<token>` as the endpoint. The server accepts the secret either as
`Authorization: Bearer <token>` or as that trailing path segment.

Developer mode is available on Pro, Plus, Business, Enterprise and Education plans, on the web,
and supports read *and* write tools (write actions prompt for confirmation).

### Before you connect it

This server queues prompts into local Claude Code sessions, and those sessions can run shell
commands. Connecting it to ChatGPT gives ChatGPT — and anything that successfully prompt-injects
ChatGPT — that reach. OpenAI flags developer mode as elevated-risk for exactly this reason.

A sensible posture for a ChatGPT-facing instance:

```bash
CLAUDE_REMOTE_MCP_TOKEN="$(openssl rand -hex 24)" \
CLAUDE_REMOTE_MCP_ALLOW=my-scratch-session \
node dist/index.js --http
```

or `CLAUDE_REMOTE_MCP_READONLY=1` if you only want ChatGPT to observe your sessions.

## Transports

| Mode | Command | Use |
|---|---|---|
| stdio (default) | `node dist/index.js` | Claude Code, Claude Desktop, OpenAI tunnel stdio mode |
| Streamable HTTP | `node dist/index.js --http` | ChatGPT, remote clients |

HTTP mode binds `127.0.0.1:8787/mcp` by default and refuses to start without
`CLAUDE_REMOTE_MCP_TOKEN` unless `CLAUDE_REMOTE_MCP_NO_AUTH=1` is set. Override with `--host`,
`--port`, `--path` or `CLAUDE_REMOTE_MCP_HOST` / `_PORT` / `_PATH`.

## Tools

| Tool | Purpose |
|---|---|
| `list_sessions` | Every live session: name, cwd, idle/busy, reachability, Remote Control session id |
| `session_status` | State of one session |
| `read_transcript` | Recent turns, including work done from a phone |
| `send_message` | Queue a prompt, return a cursor immediately |
| `get_reply` | Poll for output since a cursor; says whether the session finished |
| `ask` | Send and wait in one call, for short questions |
| `rename_session` | Change a session's display name |

Sessions are addressed by display name, session id (or a unique prefix), or pid.

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

### Voice / CarPlay

ChatGPT's voice mode cannot reach MCP connectors, and CarPlay is voice-only, so
MCP is a dead end in the car. These endpoints bypass it: plain text in, plain
text out, short enough to be spoken, callable from a Siri Shortcut.

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
settings (ChatGPT's custom instructions, for instance) are a stronger lever and
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
