# Contributing to opencode-litellm

Thanks for your interest! This project is small, scoped, and aims to stay that way — so please read this short guide before opening a PR.

## Project philosophy

- **Tiny surface area.** The plugin does one thing: discover LiteLLM models and feed them to OpenCode. Features that drift from that focus belong in a sibling plugin, not in this one.
- **Zero runtime deps** beyond `@opencode-ai/plugin`. Adding a dependency requires a strong justification.
- **Strict TypeScript.** No `any` in public APIs. Internal `any` is acceptable only when the OpenCode `config` type is genuinely opaque to us.
- **Non-blocking by default.** Anything that talks to the network must be wrapped in a timeout and must never throw out of the plugin lifecycle.

## Development setup

Requires Node.js ≥ 20 (or Bun ≥ 1.0).

```bash
git clone https://github.com/yuseferi/opencode-litellm.git
cd opencode-litellm
npm install
npm run typecheck
npm test
```

## Testing locally against your OpenCode

```bash
# In the plugin repo
npm link

# In your OpenCode workspace
npm link opencode-plugin-litellm
# add it to opencode.json plugins, then:
opencode
```

Plugin logs are prefixed with `[opencode-litellm]` — find them under `~/.local/share/opencode/log/`.

## Pull request checklist

- [ ] `npm run typecheck` passes locally
- [ ] `npm test` passes locally; behavior changes come with test updates
- [ ] No new runtime dependencies (or strong justification in the PR description)
- [ ] Public API changes are reflected in the README
- [ ] User-visible changes are added to `CHANGELOG.md` under `## [Unreleased]`
- [ ] Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`, etc.)

## Reporting bugs

Please use the bug-report issue template and include:

- LiteLLM version (`litellm --version`)
- OpenCode version
- Node.js / Bun version & OS
- Relevant `[opencode-litellm]` log lines
- A minimal `opencode.json` / `litellm config.yaml` that reproduces the issue

## Releasing (maintainers)

Releases are fully automated using `semantic-release` on every push/merge to the `main` branch. 

1. Ensure your commits follow [Conventional Commits](https://www.conventionalcommits.org/).
2. When a PR is merged to `main`, the `Publish to npm` workflow (`release.yml`) will:
   - Analyze your commit messages to determine the next version bump (major/minor/patch).
   - Generate release notes and prepend them to `CHANGELOG.md`.
   - Bump the version in `package.json` and `package-lock.json`.
   - Push the updated files back to the repository.
   - Create a corresponding git tag and GitHub Release.
   - Publish the package to npm using OIDC Trusted Publishing (no secrets required!).

## Code of conduct

Be kind. Assume good intent. We follow the [Contributor Covenant](https://www.contributor-covenant.org/).
