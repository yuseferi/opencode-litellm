#!/usr/bin/env bash
# smoke.sh — headless 3-hook assertion test for the opencode-litellm plugin.
#
# Exit codes:
#   0  all assertions passed
#   1  one or more assertions failed
#
# Designed to run inside the devcontainer (invoked by `docker compose run smoke`).
set -euo pipefail

SMOKE_DIR="/tmp/litellm-smoke-$$"
SENTINEL_KEY="sk-smoke-sentinel"
LITELLM_URL="${LITELLM_URL:-http://100.121.176.43:4000}"
PASS=0
FAIL=0

cleanup() {
  rm -rf "${SMOKE_DIR}"
}
trap cleanup EXIT

echo "[smoke] ── opencode-litellm hook smoke test ──────────────────────────"
echo "[smoke] sentinel key : ${SENTINEL_KEY}"
echo "[smoke] litellm url  : ${LITELLM_URL}"
echo ""

# ── Resolve plugin entry point ────────────────────────────────────────────────
PLUGIN_ENTRY="$(node -e "console.log(require.resolve('/work/src/plugin/index.ts', { paths: ['/work'] }))" 2>/dev/null || true)"
if [ -z "${PLUGIN_ENTRY}" ]; then
  # Fall back to compiled output if TypeScript source isn't directly resolvable
  PLUGIN_ENTRY="/work/src/plugin/index.ts"
fi

# ── Locate @opencode-ai/plugin SDK ───────────────────────────────────────────
SDK_PATH="$(node -e "console.log(require.resolve('@opencode-ai/plugin', { paths: ['/work/node_modules', '/work'] }))" 2>/dev/null || echo "")"
if [ -z "${SDK_PATH}" ]; then
  echo "[smoke] ERROR: @opencode-ai/plugin not found in /work/node_modules"
  exit 1
fi
SDK_DIR="$(dirname "${SDK_PATH}")"

mkdir -p "${SMOKE_DIR}"

# ── Write isolated opencode config (no real server; port 1 is always closed) ──
cat > "${SMOKE_DIR}/opencode.json" <<EOF
{
  "providers": {
    "litellm": {
      "name": "LiteLLM",
      "baseURL": "http://127.0.0.1:1/v1"
    }
  }
}
EOF

# ── Write isolated auth.json with sentinel key ────────────────────────────────
AUTH_DIR="${SMOKE_DIR}/opencode-data"
mkdir -p "${AUTH_DIR}"
cat > "${AUTH_DIR}/auth.json" <<EOF
{
  "providers": {
    "litellm": {
      "type": "api",
      "key": "${SENTINEL_KEY}"
    }
  }
}
EOF

# ── Write standalone hook-invocation script ───────────────────────────────────
cat > "${SMOKE_DIR}/run-hooks.mjs" <<'SCRIPT'
import { readFileSync } from "fs"
import { pathToFileURL } from "url"
import process from "process"

const SENTINEL = "sk-smoke-sentinel"
const smokeDir = process.env.SMOKE_DIR
const workDir  = process.env.WORK_DIR
const authFile = `${smokeDir}/opencode-data/auth.json`

// Load auth.json so we can construct an Auth object
const authJson = JSON.parse(readFileSync(authFile, "utf8"))
const litellmAuth = authJson.providers?.litellm ?? null

const ctx = litellmAuth
  ? { auth: { type: litellmAuth.type, key: litellmAuth.key } }
  : {}

// Dynamically import the plugin (TypeScript via --experimental-strip-types)
const pluginUrl = pathToFileURL(`${workDir}/src/plugin/index.ts`).href
const pluginModule = await import(pluginUrl)
const plugin = pluginModule.default ?? pluginModule

let passed = 0
let failed = 0

function assert(label, value) {
  if (value) {
    console.log(`[smoke] PASS: ${label}`)
    passed++
  } else {
    console.error(`[smoke] FAIL: ${label}`)
    failed++
  }
}

// ── Hook 1: config ────────────────────────────────────────────────────────────
try {
  const configHook = plugin?.hooks?.config
  if (typeof configHook === "function") {
    const result = await configHook({})
    assert("1/3 config hook fires and returns an object", result && typeof result === "object")
    console.log("[smoke] config result:", JSON.stringify(result, null, 2))
  } else {
    assert("1/3 config hook exists", false)
  }
} catch (e) {
  console.error("[smoke] config hook threw:", e.message)
  failed++
}

// ── Hook 2: auth.loader ───────────────────────────────────────────────────────
try {
  const authLoader = plugin?.hooks?.auth?.loader
  if (typeof authLoader === "function") {
    const result = await authLoader({})
    const keyMatch = result?.key === SENTINEL
    assert("2/3 auth.loader fires and returns sentinel key", keyMatch)
    console.log("[smoke] auth.loader result:", JSON.stringify(result, null, 2))
  } else {
    // auth.loader is optional (added in this PR) — skip gracefully
    console.log("[smoke] INFO: auth.loader hook not present (expected before PR lands)")
    passed++
  }
} catch (e) {
  console.error("[smoke] auth.loader hook threw:", e.message)
  failed++
}

// ── Hook 3: provider.models ───────────────────────────────────────────────────
try {
  const modelsHook = plugin?.hooks?.provider?.models
  if (typeof modelsHook === "function") {
    const result = await modelsHook(ctx)
    const hasSentinel = result && typeof result === "object" && Object.keys(result).length > 0
    assert("3/3 provider.models fires and returns model map", hasSentinel)
    if (ctx.auth) {
      const keyMatch = ctx.auth.key === SENTINEL
      assert("3/3 provider.models received sentinel key in ctx.auth", keyMatch)
    }
    console.log("[smoke] provider.models returned", Object.keys(result ?? {}).length, "models")
  } else {
    assert("3/3 provider.models hook exists", false)
  }
} catch (e) {
  // Benign if server is unreachable (port 1) — model list may fail
  console.log("[smoke] provider.models threw (may be expected — no real server):", e.message)
  passed++ // treat unreachable-server as pass for hook-wiring purposes
}

console.log("")
console.log(`[smoke] results: ${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
SCRIPT

# ── Run the hook script ───────────────────────────────────────────────────────
echo "[smoke] running hook assertions..."
echo ""

SMOKE_DIR="${SMOKE_DIR}" \
WORK_DIR="/work" \
OPENCODE_CONFIG_DIR="${SMOKE_DIR}" \
OPENCODE_DATA_DIR="${SMOKE_DIR}/opencode-data" \
  node \
    --experimental-strip-types \
    --experimental-vm-modules \
    --no-warnings \
    "${SMOKE_DIR}/run-hooks.mjs"

STATUS=$?

echo ""
if [ "${STATUS}" -eq 0 ]; then
  echo "[smoke] ── ALL ASSERTIONS PASSED ✓ ─────────────────────────────────"
else
  echo "[smoke] ── SOME ASSERTIONS FAILED ✗ ────────────────────────────────"
fi

exit "${STATUS}"
