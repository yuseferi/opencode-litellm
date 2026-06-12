# 1. SDK-native auth resolution via plugin hooks

- **Status:** Proposed
- **Date:** 2026-06-10
- **Deciders:** @yuseferi (maintainer), contributors of `feat/sdk-native-auth`
- **PR:** feat/sdk-native-auth → main
- **Supersedes:** `PR-PLAN.md` (original disk-read proposal)

## Context

`opencode-plugin-litellm` emits the following warning at startup even when
the LiteLLM proxy is reachable and the user has authenticated via
`opencode providers add`:

```
[opencode-litellm] LiteLLM appears offline or unauthorized at http://<host>:4000
```

Root cause: credential resolution in `src/plugin/index.ts` and
`src/plugin/discover.ts` only consults two sources:

1. `provider.litellm.options.apiKey` in `opencode.json`
2. `LITELLM_API_KEY` / `LITELLM_MASTER_KEY` environment variables

OpenCode's credential store (`~/.local/share/opencode/auth.json`, populated
by `opencode providers add litellm`) is never read. Users authenticating
through the first-party flow must therefore duplicate their key into
`opencode.json` or a shell env var — two sources of truth that drift on
rotation.

An original PR plan (`PR-PLAN.md`) proposed reading `auth.json` from disk
directly. That plan was revised after inspecting the plugin SDK surface
(see Alternatives Considered below).

### Plugin SDK surface relevant to this decision

From `@opencode-ai/plugin` (stable since ≤ 1.3.3):

```ts
export type AuthHook = {
  provider: string
  loader?: (auth: () => Promise<Auth>, provider: Provider) => Promise<Record<string, any>>
  methods: [...]
}
```

From `@opencode-ai/plugin` (introduced in 1.14.49):

```ts
export type ProviderHookContext = { auth?: Auth }
export type ProviderHook = {
  id: string
  models?: (provider: ProviderV2, ctx: ProviderHookContext) => Promise<Record<string, ModelV2>>
}
```

Where `Auth = OAuth | ApiAuth | WellKnownAuth` and `ApiAuth = { type: "api", key: string }`.

### Lifecycle ordering

```
plugin load
  → Hooks.config fires        (baseURL resolution, provider seeding)
  → Hooks.auth.loader fires   (stored key merged into provider.options.apiKey)
  → Hooks.provider.models     (model discovery with ctx.auth delivered by core)
```

The `config` hook fires before auth is resolved, which is why consulting
`options.apiKey` inside `config` never sees credentials stored via
`opencode providers add`.

## Decision

Resolve credentials entirely through the OpenCode plugin SDK. Three
coordinated changes:

### 1. Register `Hooks.auth` with an API-key method

Enables `opencode providers add litellm` as a first-class flow. Auth copy:

- `methods[0].type: "api"`
- `methods[0].label: "API key"`
- `prompts[0].message: "LiteLLM master key"`
- `prompts[0].placeholder: "sk-…"`
- No `validate` — LiteLLM key formats are not fixed across proxy deployments.

### 2. Implement `Hooks.auth.loader`

Injects the stored key into `provider.litellm.options.apiKey` during
provider initialization, so any downstream code path reading
`provider.options.apiKey` (including the `@ai-sdk/openai-compatible`
adapter) sees the correct value:

```ts
loader: async (getAuth) => {
  const stored = await getAuth()
  if (stored?.type !== 'api' || !stored.key) return {}
  return { apiKey: stored.key }
}
```

### 3. Migrate model discovery to `Hooks.provider.models`

`ctx.auth` is delivered by core at the point discovery runs, eliminating
the race between the config-hook reachability ping and auth resolution:

```ts
provider: {
  id: 'litellm',
  models: async (provider, ctx) => {
    const ctxKey = ctx.auth?.type === 'api' ? ctx.auth.key : undefined
    return discoverModels(provider, ctxKey)
  },
}
```

`discoverModels()` receives `ctxKey` as a third-priority fallback inside
`resolveEndpoint()`, preserving the existing precedence:

```
options.apiKey  ??  LITELLM_API_KEY / LITELLM_MASTER_KEY  ??  ctxKey
```

### Minimum version bump

`@opencode-ai/plugin: ^1.14.50` is required for `Hooks.provider` to fire
for custom provider ids. This is a `BREAKING CHANGE` and is footnoted on
the dependency-bump commit.

### Commit series

Seven commits on `feat/sdk-native-auth`, merged (not squashed) to preserve
the bisectable series:

1. `chore(deps): bump @opencode-ai/plugin min version to ^1.14.50` — `BREAKING CHANGE:` footer
2. `docs(readme): refresh project structure and requirements`
3. `feat(auth): add /connect API-key method for litellm provider`
4. `feat(auth): inject stored auth.json key via auth.loader`
5. `feat(provider): migrate model discovery to provider.models hook`
6. `test: add vitest coverage for auth and provider hooks`
7. `docs(readme): document /connect flow and auth precedence`

## Alternatives considered

### Option C — Read `auth.json` from disk (original `PR-PLAN.md` proposal)

Add a `readOpencodeAuthKey(providerId)` helper that locates `auth.json`
via `$XDG_DATA_HOME` and parses it directly.

**Rejected because:**

- Couples the plugin to OpenCode's on-disk file location, format, and
  per-OS path conventions (XDG on Linux/macOS, `%APPDATA%` on Windows).
  `PR-PLAN.md` §9 acknowledged this with a "TODO: verify with maintainer"
  flag — the portability concern belongs in core, not the plugin.
- Breaks silently if OpenCode moves or renames the credential store in a
  future release.
- Requires the plugin to re-implement type-checking and OAuth filtering
  that core already performs before handing credentials to the SDK.
- Produces a false negative if `auth.json` has not been written yet (new
  install), where core gracefully falls through but a file-read would also
  fall through — so the defensive value is symmetric while the coupling
  cost is asymmetric.

### Option A alone — `auth.loader` without `Hooks.provider.models`

Inject the stored key into `provider.options.apiKey` via the loader, keep
model discovery in the `config` hook.

**Rejected as the sole approach** because the `config` hook runs before
provider initialization. The loader populates `options.apiKey` only after
the config-hook reachability ping has already fired — meaning the
first-startup warning that motivated this PR would remain. Chat sessions
would work on subsequent restarts, but the initial symptom would persist.

Retained as a complement (commit 4) for belt-and-braces: ensures the key
flows into `provider.options.apiKey` for any consumer that reads it
outside the `provider.models` path.

### Option B alone — `Hooks.provider.models` without `auth.loader`

Move discovery to `provider.models` and consume `ctx.auth.key`.

**Rejected as the sole approach** because `provider.options.apiKey` would
remain empty on provider initialization, which the `@ai-sdk/openai-compatible`
adapter reads when constructing request headers for chat completions. The
auth.loader ensures the key is present in options regardless of which code
path runs.

Combined with Option A as the accepted solution (commits 3–5).

## Consequences

### Positive

- Plugin owns zero filesystem assumptions about credential storage location,
  format, or per-OS path layout.
- `opencode providers add litellm` becomes a supported first-class flow,
  matching the UX of all built-in OpenCode providers.
- The startup warning that motivated this PR is eliminated because
  `ctx.auth` is available synchronously when `provider.models` runs.
- The stale comment in `src/plugin/index.ts` (*"the provider.models hook is
  not called by OpenCode for custom providers"*) is removed. It was accurate
  for opencode < 1.14.49 but is false for current releases.
- `src/plugin/discover.ts` (currently dead code — not wired into any hook)
  is activated and becomes the canonical model-discovery implementation.

### Negative

- Minimum `@opencode-ai/plugin` bumps from `^1.14.0` to `^1.14.50`.
  Users on older opencode installs must upgrade. Justified because
  `^1.14.50` is less than two months old relative to this decision and
  any user on `^1.14.0` who runs `npm update` will receive it automatically.
- The PR introduces vitest as a devDependency. This is consistent with the
  project roadmap ("Tests with vitest" is an explicit roadmap item in the
  README) but adds ~12 MB to the dev install. It does not affect the
  runtime package (`files: ["src"]` in `package.json`).

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| `Hooks.provider.models` does not fire for the `litellm` custom provider id on current opencode | Pre-PR smoke test (`.github/SMOKE_TEST.md`) gates PR opening. If it fails, scope back to Option A only and file an upstream issue. |
| `ctx.auth` is `undefined` despite a stored key | Same gate. Likely an upstream bug; file issue and fall back to Option A. |
| Downstream forks rely on config-hook discovery behaviour | `discoverBucket()` remains exported alongside the new `discoverModels()`. |
| Future OAuth method for LiteLLM Enterprise conflicts with the registered API method | `methods` is an array — append a second entry in a follow-up PR. |
| `litellm-responses` sibling provider (currently no-op) is re-activated without its own `auth` hook | The responses provider's re-activation PR should add a mirrored `auth` hook. Noted in code comments. |

## Pre-PR gate

A smoke test kit is provided in `.github/SMOKE_TEST.md`. The PR is opened
only after a successful local run against opencode ≥ 1.14.50 with the
transcript pasted into the PR description.

## References

- OpenCode plugin SDK: `packages/plugin/src/index.ts` on `anomalyco/opencode@dev`
- Version that introduced custom-provider hook: `anomalyco/opencode` release 1.14.49
- Prior art: `Alph4d0g/opencode-omniroute-auth` PR #16 — same hook migration
  for the same reasons, cited as existence proof
- Auth-method copy convention: OpenCode providers docs (`/connect` prompt uses `┌ API key │` framing)
- MADR format: https://adr.github.io/madr/
