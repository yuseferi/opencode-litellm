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
# Source is always at a known path — no resolution needed.
PLUGIN_ENTRY="/work/src/plugin/index.ts"

# ── Locate @opencode-ai/plugin SDK ───────────────────────────────────────────
# The package uses an exports map; resolve via a script colocated in /work
# so Node's module resolution walks up from there and finds node_modules.
_RESOLVE_SCRIPT="/work/_smoke_resolve.mjs"
printf 'console.log(new URL(await import.meta.resolve("@opencode-ai/plugin")).pathname)\n' > "${_RESOLVE_SCRIPT}"
SDK_PATH="$(node --no-warnings "${_RESOLVE_SCRIPT}" 2>/dev/null || echo "")"
rm -f "${_RESOLVE_SCRIPT}"
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
cat > "${SMOKE_DIR}/run-hooks.mts" <<'SCRIPT'
import { readFileSync } from "fs"
import { pathToFileURL } from "url"
import process from "process"
import type { Auth } from "@opencode-ai/sdk/v2"

const SENTINEL = "sk-smoke-sentinel"
const smokeDir = process.env.SMOKE_DIR!
const workDir  = process.env.WORK_DIR!

// Simulate stored auth: getAuth() returns the sentinel key
const getAuth = async (): Promise<Auth> =>
  ({ type: "api", key: SENTINEL } as Auth)

// ctx passed to provider.models hook
const ctx = { auth: { type: "api" as const, key: SENTINEL } }

// Load the plugin and invoke it (PluginInput can be empty for smoke)
const pluginModule = await import(pathToFileURL(`${workDir}/src/plugin/index.ts`).href)
const hooks = await pluginModule.LiteLLMPlugin({} as any)

let passed = 0
let failed = 0

function assert(label: string, value: unknown) {
  if (value) {
    console.log(`[smoke] PASS: ${label}`)
    passed++
  } else {
    console.error(`[smoke] FAIL: ${label}`)
    failed++
  }
}

// ── Hook 1: config ────────────────────────────────────────────────────────────
// config modifies its argument in-place and returns void — check it doesn't throw.
try {
  assert("1/3 config hook is a function", typeof hooks.config === "function")
  if (typeof hooks.config === "function") {
    const cfg: any = {}
    await hooks.config(cfg)
    // After calling with empty config and no reachable proxy, provider may be
    // absent — that's fine. We just assert the hook didn't throw.
    console.log("[smoke] config ran without throwing ✓")
  }
} catch (e: any) {
  console.error("[smoke] config hook threw:", e.message)
  failed++
}

// ── Hook 2: auth.loader ────────────────────────────────────────────────────────
// auth.loader receives a getAuth callback and should return { apiKey: SENTINEL }
try {
  const loader = hooks.auth?.loader
  assert("2/3 auth.loader hook is present", typeof loader === "function")
  if (typeof loader === "function") {
    const result = await loader(getAuth, {} as any)
    const keyMatch = (result as any)?.apiKey === SENTINEL
    assert("2/3 auth.loader returns { apiKey: sentinel }", keyMatch)
    console.log("[smoke] auth.loader result:", JSON.stringify(result))
  }
} catch (e: any) {
  console.error("[smoke] auth.loader threw:", e.message)
  failed++
}

// ── Hook 3: provider.models ───────────────────────────────────────────────────
// provider.models receives (provider, ctx) — ctx.auth carries the sentinel key.
// The proxy is unreachable in the container so discovery will return {}.
// We assert: (a) hook exists, (b) it accepts ctx.auth without crashing.
try {
  const modelsHook = hooks.provider?.models
  assert("3/3 provider.models hook is present", typeof modelsHook === "function")
  if (typeof modelsHook === "function") {
    // Minimal provider shape with a baseURL that won't resolve (port 1)
    const fakeProvider = {
      id: "litellm",
      name: "LiteLLM",
      options: { baseURL: "http://127.0.0.1:1/v1", apiKey: SENTINEL },
    }
    const result = await modelsHook(fakeProvider as any, ctx)
    // Result is {} because port 1 is unreachable — that's expected
    assert("3/3 provider.models executed with ctx.auth (unreachable proxy → {} is ok)",
      result !== undefined && typeof result === "object")
    console.log("[smoke] provider.models returned", Object.keys(result ?? {}).length, "models (0 expected — no proxy)")
  }
} catch (e: any) {
  console.error("[smoke] provider.models threw unexpectedly:", e.message)
  failed++
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
  /work/node_modules/.bin/tsx \
    "${SMOKE_DIR}/run-hooks.mts"

STATUS=$?

echo ""
if [ "${STATUS}" -eq 0 ]; then
  echo "[smoke] ── ALL ASSERTIONS PASSED ✓ ─────────────────────────────────"
else
  echo "[smoke] ── SOME ASSERTIONS FAILED ✗ ────────────────────────────────"
fi

exit "${STATUS}"
