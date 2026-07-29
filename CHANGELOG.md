## [Unreleased]

### Features

* **cost:** read model costs from `/v1/model/info` (`input_cost_per_token`, `output_cost_per_token`, `cache_read_input_token_cost`, `cache_creation_input_token_cost`)

# [0.7.0](https://github.com/yuseferi/opencode-litellm/compare/v0.6.0...v0.7.0) (2026-07-24)


### Features

* **plugin:** support multiple differently-named LiteLLM providers ([8d446d1](https://github.com/yuseferi/opencode-litellm/commit/8d446d117f89fef77650eabcb5d5e834ace90b3a))

# [0.6.0](https://github.com/yuseferi/opencode-litellm/compare/v0.5.0...v0.6.0) (2026-07-24)


### Bug Fixes

* **litellm:** enrich model discovery with info ([#10](https://github.com/yuseferi/opencode-litellm/issues/10)) ([2aa3873](https://github.com/yuseferi/opencode-litellm/commit/2aa3873aa6026c9e57650f0c7fd96d863dc9b8af))


### Features

* **release:** set up automated semantic-release via OIDC ([45119ce](https://github.com/yuseferi/opencode-litellm/commit/45119ce7ce6e26ffe787cdcda501160be66aee3a))

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **Embedding / image / audio models no longer appear in the OpenCode
  model picker.** The non-chat filter in `toConfigModel()` was a dead
  code path that returned the model entry either way, so models like
  `mistral/mistral-embed` showed up as selectable chat models.
- **Model classification now works for database-defined models.**
  `/v1/models` omits the `mode` field for DB-defined models, so
  mode-based classification never fired. The plugin now fetches
  `/v1/model/info` alongside `/v1/models` and enriches each discovered
  model with its `mode`, token limits (`max_input_tokens` /
  `max_output_tokens`), and capability flags
  (`supports_function_calling`, `supports_vision`). Fields already
  present on the `/v1/models` entry take precedence. The info call is
  best-effort — if the endpoint is unavailable, classification falls
  back to the previous id heuristics.
- The startup log now reports totals, additions, and hidden non-chat
  models, e.g. `Discovered 12 models from http://localhost:4000 (10
  added, 2 non-chat hidden)`.
- **A warning is logged when `/v1/model/info` is unreachable**, so
  degraded (id-heuristic-only) classification is no longer silent.
- **The config hook is now idempotent within a process.** OpenCode
  invokes the hook several times per run with a cumulative config;
  repeat invocations used to re-query the proxy each time. Already-
  injected model sets are now skipped entirely.
- **Enrichment works when the `/v1/model/info` alias differs from the
  `/v1/models` id.** Info entries are now indexed by `model_name`,
  `model_info.key`, and `litellm_params.model`, so deployments whose
  public alias differs from the upstream model string still get `mode`,
  limits, and capability flags.
- **`supports_vision` set on `litellm_params`** (instead of inside
  `model_info`) is now honoured.
- **Wildcard model entries (e.g. `deepseek/*`) are hidden from the
  picker.** They are access rules, not callable models — selecting one
  would send a literal `*` as the model name upstream.
- **Discovery fetch timeout raised from 3 s to 15 s** (health checks
  stay at 3 s fail-fast). Remote proxies with many database-defined
  models generate large `/v1/model/info` payloads that could exceed the
  old budget, silently degrading enrichment to id heuristics. The
  overall discovery cap is now 15 s.
- **Reasoning and modality capabilities are now propagated to
  OpenCode.** `supports_reasoning` maps to the model's `reasoning`
  flag, and `modalities.input` is emitted from `supports_vision`
  (`image`), `supports_pdf_input` (`pdf`), and `supports_audio_input`
  (`audio`). Previously models like `moonshot/kimi-k3` showed as
  text-only, non-reasoning in the picker despite LiteLLM reporting the
  capabilities.

## [0.5.0] — 2026-05-11

### Changed (BREAKING)
- **Switched back to the `config` hook for model injection.** The
  `provider.models` hook introduced in 0.3.0 is never called by
  OpenCode for custom providers. This release rewrites the plugin to
  use the `config` hook (the same approach used by `opencode-lmstudio`),
  which mutates `config.provider.litellm.models` directly at startup.
  No seed model is required in `opencode.json` — the plugin creates
  the `models` map automatically.
- **Simplified config.** The `"models": { "_": { "name": "seed" } }`
  workaround from 0.4.x is no longer needed. Just declare the provider
  with `npm`, `options.baseURL`, and optionally `apiKey`.
- `LiteLLMResponsesPlugin` is now a no-op. All models are injected
  through a single `litellm` provider via the config hook.

## [0.4.2] — 2026-05-11

### Fixed
- **Document and work around the seed-model requirement.** OpenCode
  skips providers that have no `models` defined in the config, which
  prevented the `provider.models` hook from ever being called. The
  `config` hook cannot fix this because OpenCode treats it as
  read-only — mutations don't reach the provider registry. The fix
  is to require a seed model entry (`"_": { "name": "seed" }`) in
  the provider config. All README examples and the Quickstart have
  been updated accordingly. The seed model is replaced at startup
  by the full list from the LiteLLM proxy.
- Removed the ineffective `config` hook that attempted to inject
  models programmatically (OpenCode's `config` hook is read-only).

## [0.4.0] — 2026-05-11

### Fixed
- _(Superseded by 0.4.2)_ Attempted to seed models via the `config`
  hook. This did not work because OpenCode's `config` hook is
  read-only — mutations are not reflected in the provider registry.

### Added
- **`customHeaders` option** for proxies behind Cloudflare Access or
  other API gateways. Arbitrary HTTP headers can now be passed via
  `provider.litellm.options.customHeaders` and are included in every
  request during model discovery (health check and `/v1/models`).
- New README section "Custom headers (Cloudflare Access, API gateways)"
  with configuration examples.
- New FAQ entry for Cloudflare Access authentication.
- "Gateway-friendly" entry in the features table.

## [0.3.0] — 2026-04-27

### Changed (BREAKING)
- **Switched from the `config` lifecycle hook to the `provider.models`
  hook.** The `config` hook turned out to be a read-only notification
  in OpenCode's plugin API — mutations to `config.provider.litellm.models`
  never reached the runtime, so the `0.2.x` formatter improvements
  were dead code in production. The plugin now implements the
  documented `provider.models` hook, which is the supported mechanism
  for plugins to add models to a provider.
- **Discovered models are emitted as V2 `Model` entries** (the shape
  required by `provider.models`), with `api.id` set per-model so the
  upstream `@ai-sdk/openai-compatible` adapter sends the correct
  model name on the wire. Previously, with the `config` hook
  approach, requests would fail with errors like "Tried to access
  litellm" because the wire model name was the provider id rather
  than the model id.
- **All discovered models register under `litellm` by default**,
  including reasoning-tier models like `gpt-5*`. The `0.2.x` behavior
  of routing those models exclusively to a `litellm-responses` provider
  was a footgun: users who didn't know to declare that second provider
  silently lost ~30 models from their picker.

### Added
- **Two `Plugin` exports**: `LiteLLMPlugin` (id `litellm`) and
  `LiteLLMResponsesPlugin` (id `litellm-responses`). Both run when
  the package is loaded; `LiteLLMResponsesPlugin` is a no-op unless
  the user has declared `litellm-responses` in their `opencode.json`.
- **Opt-in transport split**: declare a `litellm-responses` provider
  in `opencode.json` to route reasoning-tier models through the
  OpenAI Responses API. The `transport` / `responsesApiModels` /
  `chatApiModels` options on either provider control which side a
  given model lives on.

### Removed
- `src/plugin/config-hook.ts` — the old `config` lifecycle hook entry
  point.
- `src/plugin/enhance-config.ts` — the old config-mutation logic
  (replaced by `discover.ts` + `build-model.ts`).

### Notes
- This release requires `@opencode-ai/plugin >= 1.14` for the
  `provider.models` hook contract and the `@opencode-ai/sdk/v2`
  `Model`/`Provider` types.
- Existing `opencode.json` configs continue to work unchanged for
  users on the chat-only setup. Users who relied on the implicit
  `litellm-responses` split now see all models under a single
  provider; declare the responses provider explicitly to restore
  the split.

## [0.2.3] — 2026-04-27

### Fixed
- **Display names for Anthropic version pairs.** Models with dash-only
  version ids like `claude-opus-4-7` now render as "Claude Opus 4.7"
  instead of "Claude Opus 4 7". The formatter detects a trailing pair
  of 1–2 digit numeric tokens and joins them with a dot, matching how
  the upstream models are actually branded.
- **No regression on dated revision ids.** The new pair-joining
  heuristic deliberately ignores tokens longer than 2 digits, so ids
  like `claude-opus-4-5-20251101` keep the YYYYMMDD revision stamp
  separate (renders as "Claude Opus 4 5 20251101", same as before)
  rather than collapsing it into "Claude Opus 4 5.20251101".
- **Strip Vertex `@<date>` and `@default` suffixes** when present on
  the model id (most LiteLLM proxies dash-join these instead, but a
  few configurations pass the raw `@`-suffixed form through).

### Notes
- Mid-id version pairs (e.g. `gemini-2-5-pro`, `gpt-5-1-codex-low`)
  still render with separate digits ("Gemini 2 5 Pro"). Fixing those
  cleanly requires consulting LiteLLM's `/v1/model/info` endpoint for
  the canonical `base_model`, which is a larger change being held for
  a future release.

## [0.2.2] — 2026-04-27

### Changed
- **CI: switched npm publishing to Trusted Publishing (OIDC).** The
  release workflow no longer needs an `NPM_TOKEN` secret; GitHub Actions
  now mints a short-lived OIDC token at publish time, and npm verifies
  it came from this repo's `release.yml`. Published artifacts also carry
  npm provenance attestation automatically.
- The release workflow now upgrades npm to the latest version before
  publishing, since Trusted Publishing requires npm ≥ 11.5.1 and Node
  22 still ships with npm 10.x.

### Documentation
- No user-facing API changes in this release.

## [0.2.1] — 2026-04-27

### Added
- Project logo (`assets/logo.svg`) — an abstract terminal + proxy stack
  + sync mark — displayed at the top of the README.
- "Works with OpenCode" and "Powered by LiteLLM" compatibility badges
  in the README header.

### Changed
- Release workflow now also triggers on `v*` tag pushes and
  automatically creates the matching GitHub Release with auto-generated
  notes, so a single `git push --follow-tags` produces both an npm
  release and a GitHub Release.

## [0.2.0] — 2026-04-27

### Added
- **Reasoning-aware transport routing.** Discovered models are now split
  across two providers based on the API surface they require:
  - `litellm` → `/v1/chat/completions` (default, most models)
  - `litellm-responses` → `/v1/responses` (gpt-5*, o1/o3/o4*, or any
    model LiteLLM exposes with `mode === 'responses'`)
  This fixes `BadRequestError: Function tools with reasoning_effort are
  not supported … in /v1/chat/completions` for OpenAI reasoning-tier
  models that need the Responses API when used with tools.
- New `provider.litellm.options.transport` (`"auto"` | `"chat"` |
  `"responses"`, default `"auto"`) global override.
- New `provider.litellm.options.responsesApiModels: string[]` allowlist
  to force specific model ids into the responses bucket.
- New `provider.litellm.options.chatApiModels: string[]` denylist to
  force specific model ids into the chat bucket.
- New `requiresResponsesAPI(model)` exported helper for downstream tools.
- New types: `Transport`, `TransportPolicy`, expanded `LiteLLMOptions`.

### Changed
- The non-destructive merge is now cross-provider: a discovered model is
  skipped if its key already exists under **either** the `litellm` or
  the `litellm-responses` provider, so hand-curated entries win
  regardless of which bucket the heuristic would have picked.
- The `litellm-responses` provider is created lazily — it only appears
  if at least one discovered model needs it (or the user pre-defined it).

### Documentation
- New "Reasoning models (gpt-5, o1/o3/o4)" section in the README.
- New FAQ entries explaining the `reasoning_effort` / Responses API
  error and the dual-provider split.
- Updated mermaid diagram and "How it works" steps to show the bucket
  routing.

## [0.1.1] — 2026-04-27

### Documentation
- Comprehensive README rewrite with hero section, badges (npm version,
  downloads, CI, license, TypeScript strict, PRs welcome), feature
  table, configuration examples, FAQ, compatibility matrix, and a
  Mermaid sequence diagram of the discovery flow.
- Added `CONTRIBUTING.md` covering project philosophy, dev setup,
  local plugin testing via `npm link`, PR checklist, and release process.
- Added `CHANGELOG.md` following the Keep a Changelog 1.1.0 format.
- Added GitHub issue templates (bug report + feature request as YAML
  forms) and a structured pull-request template.
- Added `.github/dependabot.yml` for weekly npm + GitHub Actions updates.

### Fixed
- Removed an accidental self-dependency (`opencode-plugin-litellm`) that
  was added to `package.json` by an earlier `npm link` invocation.

## [0.1.0] — 2026-04-27

### Added
- Initial release of `opencode-litellm`.
- Auto-detection of a running LiteLLM proxy on common ports (`4000`, `8000`, `8080`).
- Dynamic model discovery via the OpenAI-compatible `/v1/models` endpoint.
- Smart name formatting (e.g. `anthropic/claude-3-5-sonnet` → `Claude 3 5 Sonnet`,
  `qwen/qwen3-30b-a3b` → `Qwen3 30B A3B`, with brand-aware handling for `gpt-4o`).
- Modality categorization — chat / embedding / image / audio inferred from
  the LiteLLM `mode` field or the model id.
- Provider extraction — uses `litellm_provider` (or the `provider/model` prefix)
  to populate `organizationOwner`.
- API key support via `LITELLM_API_KEY` / `LITELLM_MASTER_KEY` env vars or
  `provider.litellm.options.apiKey`.
- Non-destructive merge — hand-curated entries under `provider.litellm.models`
  are preserved.
- 5-second discovery timeout so a slow / offline proxy never blocks OpenCode startup.
- GitHub Actions CI workflow (typecheck on Node 20 & 22).
- Auto-publish workflow on GitHub release (requires `NPM_TOKEN` secret).

[Unreleased]: https://github.com/yuseferi/opencode-litellm/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/yuseferi/opencode-litellm/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/yuseferi/opencode-litellm/compare/v0.4.0...v0.4.2
[0.4.0]: https://github.com/yuseferi/opencode-litellm/compare/v0.3.1...v0.4.0
[0.3.0]: https://github.com/yuseferi/opencode-litellm/compare/v0.2.3...v0.3.0
[0.2.3]: https://github.com/yuseferi/opencode-litellm/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/yuseferi/opencode-litellm/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/yuseferi/opencode-litellm/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/yuseferi/opencode-litellm/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/yuseferi/opencode-litellm/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/yuseferi/opencode-litellm/releases/tag/v0.1.0
