#!/usr/bin/env bash
# Connect this MCP server to ChatGPT through OpenAI's Secure MCP Tunnel.
# Outbound-only: nothing is exposed to the public internet.
#
#   export CONTROL_PLANE_API_KEY="sk-..."   # platform.openai.com/settings/organization/api-keys
#   export TUNNEL_ID="tunnel_..."           # platform.openai.com/settings/organization/tunnels
#   bash scripts/tunnel-openai.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TC="${TUNNEL_CLIENT:-$ROOT/.tools/tunnel-client}"
PROFILE="${PROFILE:-claude-remote}"
# tunnel-client defaults its admin listener to 127.0.0.1:8080, which is a busy
# port on most machines. Override HEALTH_ADDR if this one is taken too.
HEALTH_ADDR="${HEALTH_ADDR:-127.0.0.1:8099}"

: "${CONTROL_PLANE_API_KEY:?export CONTROL_PLANE_API_KEY first — create a Runtime API key at platform.openai.com/settings/organization/api-keys (needs Tunnels Read + Use)}"
: "${TUNNEL_ID:?export TUNNEL_ID first — create a tunnel at platform.openai.com/settings/organization/tunnels}"

if [[ ! -x "$TC" ]]; then
  echo "tunnel-client not found at $TC" >&2
  echo "  Download it from https://github.com/openai/tunnel-client/releases and either place it" >&2
  echo "  at that path or point TUNNEL_CLIENT at your copy." >&2
  exit 1
fi
if [[ ! -f "$ROOT/dist/index.js" ]]; then
  echo "dist/index.js missing — run 'npm run build' first" >&2
  exit 1
fi

echo "==> creating profile '$PROFILE' for $TUNNEL_ID"
"$TC" init \
  --sample sample_mcp_stdio_local \
  --profile "$PROFILE" \
  --tunnel-id "$TUNNEL_ID" \
  --mcp-command "node $ROOT/dist/index.js" \
  --health-listen-addr "$HEALTH_ADDR" \
  --force

echo
echo "==> validating"
"$TC" doctor --profile "$PROFILE" --explain

echo
echo "==> running (Ctrl-C to stop); admin UI on the health listener at /ui"
exec "$TC" run --profile "$PROFILE"
