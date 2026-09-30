# Security Policy

## Supported versions

Security fixes land in the latest published release of
`opencode-plugin-litellm`.

| Version      | Supported |
| ------------ | --------- |
| 1.x (latest) | ✅        |
| < 1.0        | ❌        |

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/yuseferi/opencode-litellm/security/advisories/new).
Please do not open a public issue for a security problem.

Include as much of the following as you can:

- the plugin version, and the OpenCode version (`opencode --version`),
- the LiteLLM proxy version, and how the plugin was configured
  (`LITELLM_BASE_URL` / `LITELLM_API_KEY` / `providers.litellm.settings`),
- a minimal reproduction, and the impact you believe it has.

## What to expect

- A first response within a few business days.
- An initial assessment (severity, affected versions) after triage.
- A patch release plus a published GitHub Security Advisory once a fix is
  available, crediting you unless you ask to stay anonymous.

## What matters most in this project

The plugin runs inside OpenCode and handles LiteLLM credentials. Reports in
these areas are the most valuable:

- credentials (API keys, master keys) leaking into logs, error messages,
  telemetry, or the model picker,
- requests being sent anywhere other than the configured LiteLLM base URL,
- code execution or file access triggered by model or provider metadata returned
  by a proxied endpoint,
- a poisoned proxy response escalating beyond "shows wrong models".

Out of scope here: vulnerabilities in OpenCode itself, in LiteLLM, or in the npm
toolchain — please report those upstream.
