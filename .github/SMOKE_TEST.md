# Smoke test: SDK-native auth resolution

Pre-PR gate for `feat/sdk-native-auth`. Verifies that OpenCode ≥ 1.14.50
delivers stored credentials to the plugin via `Hooks.auth.loader` and
`Hooks.provider.models` with a non-null `ctx.auth`, which is the runtime
precondition for [ADR 0001](../docs/decisions/0001-sdk-native-auth.md).

**The PR is opened only after this test passes.**

---

## Prerequisites

| Requirement | Check |
|---|---|
| OpenCode ≥ 1.14.50 on `$PATH` | `opencode --version` |
| Node.js ≥ 20 or Bun ≥ 1.0 | `node --version` or `bun --version` |
| ~5 minutes | |

### Building opencode from source (if needed)

```sh
git clone https://github.com/anomalyco/opencode /tmp/opencode-smoke
cd /tmp/opencode-smoke
git fetch --tags
git checkout $(git tag -l 'v1.14.*' | sort -V | tail -1)
bun install
# confirm version
bun packages/opencode/src/index.ts --version
```

Add an alias so the smoke test can call it:

```sh
alias opencode="bun /tmp/opencode-smoke/packages/opencode/src/index.ts"
```

---

## Setup

Create an isolated scratch directory:

```sh
mkdir -p /tmp/litellm-smoke && cd /tmp/litellm-smoke
```

### `opencode.json`

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./test-plugin.ts"],
  "provider": {
    "litellm": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:1/v1"
      }
    }
  }
}
```

> `baseURL` points at a closed port intentionally. The smoke test does not
> require a running LiteLLM proxy — it only verifies the hook lifecycle and
> credential delivery, not network reachability.

### `test-plugin.ts`

```ts
import type { Plugin } from '@opencode-ai/plugin'

export const Smoke: Plugin = async () => ({
  config: async () => {
    console.log('[smoke] 1/3 config FIRED')
  },

  auth: {
    provider: 'litellm',
    methods: [
      {
        type: 'api',
        label: 'API key',
        prompts: [
          {
            type: 'text',
            key: 'key',
            message: 'LiteLLM master key',
            placeholder: 'sk-…',
          },
        ],
      },
    ],
    loader: async (getAuth) => {
      const stored = await getAuth()
      console.log('[smoke] 2/3 auth.loader FIRED', {
        hasAuth: !!stored,
        type: stored?.type ?? 'none',
        keyMatchesSentinel:
          stored?.type === 'api' && stored.key === 'sk-smoke-sentinel',
      })
      if (stored?.type !== 'api' || !stored.key) return {}
      return { apiKey: stored.key }
    },
  },

  provider: {
    id: 'litellm',
    models: async (_provider, ctx) => {
      console.log('[smoke] 3/3 provider.models FIRED', {
        hasCtxAuth: !!ctx.auth,
        ctxAuthType: ctx.auth?.type ?? 'none',
        keyMatchesSentinel:
          ctx.auth?.type === 'api' && ctx.auth.key === 'sk-smoke-sentinel',
      })
      return {
        'sentinel-model': {
          id: 'sentinel-model',
          name: 'SMOKE TEST SENTINEL — safe to delete',
        } as any,
      }
    },
  },
})
```

---

## Run

### Step 1 — Store a sentinel key

```sh
opencode providers add litellm
```

When prompted, paste exactly:

```
sk-smoke-sentinel
```

### Step 2 — Start OpenCode in the scratch directory

```sh
cd /tmp/litellm-smoke
opencode
```

Watch stdout for the three `[smoke]` lines.

### Step 3 — Check the model picker

Open the model picker (`/models` or the keybind). Confirm
`SMOKE TEST SENTINEL — safe to delete` appears under the `litellm`
provider.

### Step 4 — Quit and clean up

```sh
# Remove the sentinel key from the credential store
opencode providers remove litellm   # or delete from auth.json manually
rm -rf /tmp/litellm-smoke
```

---

## Pass criteria

All four must be true. Check each box before opening the PR:

- [ ] `[smoke] 1/3 config FIRED` appears in stdout.
- [ ] `[smoke] 2/3 auth.loader FIRED` appears with `type: "api"` and
      `keyMatchesSentinel: true`.
- [ ] `[smoke] 3/3 provider.models FIRED` appears with `hasCtxAuth: true`,
      `ctxAuthType: "api"`, and `keyMatchesSentinel: true`.
- [ ] `SMOKE TEST SENTINEL` is selectable in the model picker under `litellm`.

Expected order: `config → auth.loader → provider.models`. The loader and
provider hook may interleave depending on OpenCode internals, but all three
must fire and config must be first.

---

## Failure modes and contingencies

| Symptom | Interpretation | Action |
|---|---|---|
| `provider.models` line never appears | Custom-provider `Hooks.provider` not called by this opencode version | Drop Option B from ADR 0001; ship Option A (`auth.loader`) only; update ADR status; file upstream issue against `anomalyco/opencode` |
| `provider.models` fires but `hasCtxAuth: false` | Core does not populate `ctx.auth` for this provider id | Same as above |
| `keyMatchesSentinel: false` in loader or ctx | Key stored under wrong id or wrong shape | Re-run `opencode providers add litellm`; if still failing, inspect `~/.local/share/opencode/auth.json` |
| Sentinel model absent from picker | `provider.models` return value not honoured | Same contingency as "provider.models never appears" |
| `auth.loader` never fires | `Hooks.auth` registration not working | Check `@opencode-ai/plugin` version resolves to ≥ 1.14.50; file upstream issue if it does |

---

## Reporting

Paste the relevant stdout slice into the PR description inside a
`<details>` block:

```markdown
<details>
<summary>Smoke test transcript (opencode vX.Y.Z)</summary>

\`\`\`
[paste stdout here]
\`\`\`

opencode version: X.Y.Z
Node / Bun version: X.Y.Z
OS: macOS / Linux / Windows
All four pass criteria met: yes / no

</details>
```
