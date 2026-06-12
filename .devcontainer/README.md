# Dev Container — opencode-litellm

Isolated Docker environment for testing the opencode-litellm plugin without
touching your host opencode config or auth files.

## Prerequisites

- Docker Desktop running
- A Tailscale ephemeral auth key (for tailnet access to your LiteLLM proxy)

## One-time setup

### 1. Generate a Tailscale ephemeral auth key

Go to `https://login.tailscale.com/admin/settings/keys` and click
**Generate auth key** with these settings:

| Setting | Value |
|---|---|
| Reusable | ✓ checked (same key works across container restarts) |
| Ephemeral | ✓ checked (node auto-removed from tailnet on container stop) |
| Pre-authorized | ✓ checked (no manual device approval needed) |
| Expiry | 90 days (or your preference — regenerate when it expires) |

Copy the key (`tskey-auth-...`). No ACL changes required.

### 2. Create `.env`

```bash
cp .devcontainer/.env.example .devcontainer/.env
# edit .env — set TS_AUTHKEY, LITELLM_API_KEY
```

### 3. Build the image

```bash
cd .devcontainer
docker compose build
```

Takes ~90 s on first run (installs opencode-ai@1.17.1). Subsequent builds use
the layer cache and are instant unless the Dockerfile changes.

## Running

All commands are run from the `.devcontainer/` directory.

### Headless smoke test (exits 0 on pass, non-zero on fail)

```bash
docker compose --profile smoke run --rm smoke
```

Use this as the pre-commit / CI gate. It:
- Starts the Tailscale sidecar (ephemeral node)
- Waits for the LiteLLM proxy to be reachable
- Runs the 3-hook assertion script against the plugin source
- Prints PASS/FAIL per assertion and exits accordingly

### Full interactive TUI

```bash
docker compose --profile tui run --rm tui
```

Opens opencode in your terminal. The container's isolated `auth.json` is
pre-seeded with `LITELLM_API_KEY` from `.env`.

### Interactive shell

```bash
docker compose --profile shell run --rm shell
```

Drops you into bash inside the container. Useful for ad-hoc testing.
`/work` is the repo root, live-mounted read-write.

## State isolation

| Volume | Maps to | Purpose |
|---|---|---|
| `opencode-state` | `/root/.local/share/opencode` | Isolated auth.json, session data |
| `opencode-config` | `/root/.config/opencode` | Isolated opencode.jsonc |
| `tailscale-state` | `/var/lib/tailscale` | Tailscale machine key (ephemeral) |

Your **host** `~/.config/opencode/` and `~/.local/share/opencode/` are never
mounted and are never modified.

## Reset all state

```bash
docker compose down -v
```

Removes all named volumes. Next `run` starts completely fresh — new Tailscale
node registration, empty auth.json, empty config.

## Troubleshooting

**LiteLLM proxy unreachable after 30 s**
The entrypoint will warn and continue. The smoke test will still run but
`provider.models` may throw (treated as a pass for hook-wiring purposes when
the server is unreachable). Check that Tailscale is connected and the proxy
is running on your tailnet.

**opencode TUI renders garbled**
Run from a proper terminal emulator (not a raw pipe). If using iTerm2 / macOS
Terminal it should work cleanly. Tmux users: ensure `$TERM` is set to
`xterm-256color` in the host before launching compose.

**`TS_OAUTH_CLIENT_ID` / `TS_OAUTH_CLIENT_SECRET` errors**
These are required. Double-check `.env` exists in `.devcontainer/` and contains
both values (not the placeholder text from `.env.example`).
