import type { Context } from '@opencode/plugin/promise/plugin'

// OpenCode 2 exposes no log API through the plugin context (see
// initV2Logging); the host captures console output into its log files, so a
// plain console write with the `[opencode-litellm]` prefix is the house
// pattern for V2 modules (same as logInfo in plugin/v2.ts).
function logInfo(message: string): void {
  console.log(message)
}

/**
 * Integration id the plugin registers with OpenCode's connect-provider dialog.
 *
 * Deliberately identical to the default provider id (`CHAT_PROVIDER_ID` in
 * `plugin/v2.ts`) so a credential saved through `/connect` lines up with the
 * `litellm` provider without extra wiring; providers registered under other
 * ids still resolve the same credential because the plugin stamps
 * `info.integrationID` on them.
 */
export const LITELLM_INTEGRATION_ID = 'litellm'

/** A credential saved through the connect dialog, with its form answers. */
export interface ConnectedLiteLLM {
  /** Key resolved from the active connection's credential. */
  apiKey: string | undefined
  /** Base URL typed into the dialog's form, when present. */
  baseURL: string | undefined
  /** Provider id typed into the dialog's form, when present. */
  providerID: string | undefined
}

function readAnswer(
  configuration: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = configuration?.[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * Registers the LiteLLM integration so gateways can be connected from the
 * web UI instead of hand-edited config: the dialog collects the API key as a
 * credential plus a small form for the proxy base URL and an optional
 * provider id.
 *
 * Returns the transform registration, or undefined when the host has no
 * integration API (OpenCode 1.18.x's embedded v2 host) or registration
 * fails — model discovery must keep working without the dialog entry.
 */
export async function registerLiteLLMIntegration(
  context: Context,
): Promise<{ dispose(): Promise<void> } | undefined> {
  if (!context.integration?.transform) return undefined
  try {
    return await context.integration.transform((editor) => {
      editor.update(LITELLM_INTEGRATION_ID, (integration) => {
        integration.name = 'LiteLLM'
      })
      editor.method.update({
        integrationID: LITELLM_INTEGRATION_ID,
        method: {
          type: 'key',
          label: 'API Key',
          form: [
            {
              key: 'baseURL',
              type: 'string',
              format: 'uri',
              title: 'Base URL',
              description:
                'Where the LiteLLM proxy runs, including the /v1 suffix. Leave empty to use LITELLM_BASE_URL or auto-detect a local proxy.',
              placeholder: 'https://llm.example.com/v1',
            },
            {
              key: 'providerID',
              type: 'string',
              title: 'Provider ID',
              description:
                'Provider the discovered models appear under. Pick a different id when your config already defines a "litellm" provider, so the connected gateway gets its own entry. Reconnecting with a different id moves the gateway there.',
              default: LITELLM_INTEGRATION_ID,
            },
          ],
        },
      })
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logInfo(`[opencode-litellm] Could not register the connect dialog integration: ${message}`)
    return undefined
  }
}

/**
 * Resolves the active credential for an integration into the values the
 * plugin needs: the API key plus the dialog's form answers.
 *
 * Returns undefined when the integration has no connection, the credential
 * is not a key, or the host lacks the connection API. Errors are swallowed
 * on purpose — a missing or unrelated integration must never prevent other
 * auth sources from working.
 */
export async function readConnectedConfig(
  context: Context,
  integrationID: string,
): Promise<ConnectedLiteLLM | undefined> {
  const connection = context.integration?.connection
  if (!connection) return undefined
  try {
    const active = await connection.active(integrationID)
    if (!active) return undefined
    const credential = await connection.resolve(active)
    if (!credential || credential.type !== 'key') return undefined
    // OpenCode 2.1 moved the form answers from `configuration` to `metadata`.
    const answers = (credential.metadata ?? credential.configuration) as Record<string, unknown> | undefined
    return {
      apiKey: credential.key,
      baseURL: readAnswer(answers, 'baseURL'),
      providerID: readAnswer(answers, 'providerID'),
    }
  } catch {
    return undefined
  }
}
