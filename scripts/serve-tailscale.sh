#!/usr/bin/env bash
# Serve over Tailscale Funnel: a stable public hostname, so a connector
# configured once keeps working across restarts.
#
#   bash scripts/serve-tailscale.sh            # full tools
#   READONLY=1 bash scripts/serve-tailscale.sh # observation only
#   bash scripts/serve-tailscale.sh --stop
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${RUN_DIR:-$ROOT/.run}"
PORT="${PORT:-8787}"
# Funnel only accepts 443, 8443 or 10000. 443 is often already serving
# something else, so default to 8443 and leave any existing mapping alone.
FUNNEL_PORT="${FUNNEL_PORT:-8443}"

mkdir -p "$RUN_DIR"

stop() {
  [[ -f "$RUN_DIR/server.pid" ]] && { kill "$(cat "$RUN_DIR/server.pid")" 2>/dev/null || true; rm -f "$RUN_DIR/server.pid"; }
  tailscale funnel --https="$FUNNEL_PORT" off 2>/dev/null || true
  echo "stopped"
}

if [[ "${1:-}" == "--stop" ]]; then stop; exit 0; fi

if [[ ! -f "$ROOT/dist/index.js" ]]; then
  echo "dist/index.js missing — run 'npm run build' first" >&2
  exit 1
fi
if ! command -v tailscale >/dev/null; then
  echo "tailscale not found — install it, or use scripts/serve-public.sh for a Cloudflare quick tunnel" >&2
  exit 1
fi

# Reuse the secret across restarts so the client config stays valid.
if [[ ! -f "$RUN_DIR/token" ]]; then
  ( umask 077; openssl rand -hex 24 > "$RUN_DIR/token" )
fi
TOKEN="$(cat "$RUN_DIR/token")"

[[ -f "$RUN_DIR/server.pid" ]] && { kill "$(cat "$RUN_DIR/server.pid")" 2>/dev/null || true; sleep 1; }

CLAUDE_REMOTE_MCP_TOKEN="$TOKEN" \
CLAUDE_REMOTE_MCP_READONLY="${READONLY:-0}" \
  node "$ROOT/dist/index.js" --http --port "$PORT" > "$RUN_DIR/server.log" 2>&1 &
echo $! > "$RUN_DIR/server.pid"

for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.25
done
if ! curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  echo "server failed to start:" >&2; cat "$RUN_DIR/server.log" >&2; exit 1
fi

tailscale funnel --bg --https="$FUNNEL_PORT" "$PORT" >/dev/null
HOST="$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
PUBLIC="https://$HOST:$FUNNEL_PORT"

cat <<EOF

  public URL : $PUBLIC/mcp
  token      : $TOKEN
  mode       : $([[ "${READONLY:-0}" == "1" ]] && echo "read-only" || echo "full tools")

  This hostname is stable — configure the connector once and restarts stay invisible to it.

  xAI / Grok API tool declaration:

    {"type": "mcp",
     "server_label": "talk-to-claude-code",
     "server_url": "$PUBLIC/mcp",
     "authorization": "$TOKEN"}

  Grok app: grok.com/connectors -> New Connector -> Custom, with auth set to none:

    $PUBLIC/mcp/$TOKEN

  Use that token-in-path URL, not the bare /mcp: a bare first request gets a 401,
  which clients interpret as an OAuth requirement and then prompt for credentials.

  Stop with: bash scripts/serve-tailscale.sh --stop
EOF
