#!/usr/bin/env bash
# entrypoint.sh — runs inside the oc container before the main command.
#
# Responsibilities:
#   1. Wait for the Tailscale sidecar to come online (shared network namespace).
#   2. Install plugin dependencies if not already present (node_modules).
#   3. Exec the user command (bash / smoke / opencode).
set -euo pipefail

# ── 1. Wait for Tailscale ─────────────────────────────────────────────────────
# The sidecar shares our network namespace; tailscale CLI is not present here,
# but we can detect readiness by polling the tailscaled socket status file or
# simply checking connectivity to the LiteLLM proxy once it's reachable.
#
# Simplest reliable approach: wait for the Tailscale state dir to contain a
# non-empty machine key file (written by the sidecar after registration).

TAILSCALE_STATE_DIR="${TAILSCALE_STATE_DIR:-/var/lib/tailscale}"
LITELLM_URL="${LITELLM_URL:-http://100.121.176.43:4000}"
MAX_WAIT=${TS_WAIT_TIMEOUT:-30}
WAITED=0

# Skip Tailscale wait entirely if SKIP_TS_WAIT is set (useful for unit tests
# and CI builds that don't need tailnet access).
if [ "${SKIP_TS_WAIT:-}" != "1" ]; then
  echo "[entrypoint] waiting for Tailscale to come online (max ${MAX_WAIT}s)..."
  while true; do
    if curl -sf --max-time 2 "${LITELLM_URL}/health" > /dev/null 2>&1; then
      echo "[entrypoint] Tailscale ready — LiteLLM proxy reachable at ${LITELLM_URL}"
      break
    fi
    if [ "${WAITED}" -ge "${MAX_WAIT}" ]; then
      echo "[entrypoint] WARNING: LiteLLM proxy unreachable after ${MAX_WAIT}s — continuing anyway"
      break
    fi
    sleep 1
    WAITED=$((WAITED + 1))
  done
fi

# ── 2. Auto-install plugin deps ───────────────────────────────────────────────
if [ -f "/work/package.json" ] && [ ! -d "/work/node_modules" ]; then
  echo "[entrypoint] installing plugin dependencies..."
  npm install --prefix /work
fi

# ── 3. Exec the requested command ─────────────────────────────────────────────
exec "$@"
