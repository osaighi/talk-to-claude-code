#!/usr/bin/env bash
# Expose the MCP server through a Cloudflare quick tunnel so a hosted client
# (Grok / the xAI API) can reach it. Prints the public URL and the shared secret.
#
#   bash scripts/serve-public.sh            # full tools
#   READONLY=1 bash scripts/serve-public.sh # observation only
#
# Stop with: bash scripts/serve-public.sh --stop
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${RUN_DIR:-$ROOT/.run}"
PORT="${PORT:-8787}"

mkdir -p "$RUN_DIR"

stop() {
  for name in server tunnel; do
    if [[ -f "$RUN_DIR/$name.pid" ]]; then
      kill "$(cat "$RUN_DIR/$name.pid")" 2>/dev/null || true
      rm -f "$RUN_DIR/$name.pid"
    fi
  done
  echo "stopped"
}

if [[ "${1:-}" == "--stop" ]]; then
  stop
  exit 0
fi

if [[ ! -f "$ROOT/dist/index.js" ]]; then
  echo "dist/index.js missing — run 'npm run build' first" >&2
  exit 1
fi

# Reuse an existing secret across restarts so the client config stays valid.
if [[ ! -f "$RUN_DIR/token" ]]; then
  ( umask 077; openssl rand -hex 24 > "$RUN_DIR/token" )
fi
TOKEN="$(cat "$RUN_DIR/token")"

stop >/dev/null 2>&1 || true

CLAUDE_REMOTE_MCP_TOKEN="$TOKEN" \
CLAUDE_REMOTE_MCP_READONLY="${READONLY:-0}" \
  node "$ROOT/dist/index.js" --http --port "$PORT" \
  > "$RUN_DIR/server.log" 2>&1 &
echo $! > "$RUN_DIR/server.pid"

for _ in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.2
done
if ! curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  echo "server failed to start:" >&2
  cat "$RUN_DIR/server.log" >&2
  exit 1
fi

cloudflared tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate \
  > "$RUN_DIR/tunnel.log" 2>&1 &
echo $! > "$RUN_DIR/tunnel.pid"

PUBLIC=""
for _ in $(seq 1 100); do
  PUBLIC="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$RUN_DIR/tunnel.log" 2>/dev/null | head -1 || true)"
  [[ -n "$PUBLIC" ]] && break
  sleep 0.5
done

if [[ -z "$PUBLIC" ]]; then
  echo "tunnel did not report a public URL:" >&2
  tail -20 "$RUN_DIR/tunnel.log" >&2
  exit 1
fi

cat <<EOF

  public URL : $PUBLIC/mcp
  token      : $TOKEN
  mode       : $([[ "${READONLY:-0}" == "1" ]] && echo "read-only" || echo "full tools")
  logs       : $RUN_DIR/{server,tunnel}.log

  xAI / Grok API tool declaration:

    {"type": "mcp",
     "server_label": "talk-to-claude-code",
     "server_url": "$PUBLIC/mcp",
     "authorization": "$TOKEN"}

  Grok app: grok.com/connectors -> New Connector -> Custom, auth none:
    $PUBLIC/mcp/$TOKEN     (token in the path: a bare /mcp 401s and triggers an OAuth prompt)

  Stop with: bash scripts/serve-public.sh --stop
EOF
