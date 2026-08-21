import type { Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { parseConfig } from "./config.js"
import { aggregateUnavailableKeys } from "./errors.js"
import { createKeySelector } from "./selector.js"
import { createUsageClient } from "./usage.js"

const PROVIDER_ID = "opencode-go"
const CANONICAL_AUTHORIZATION = "Authorization"

export const createServer = (input: PluginInput, options?: PluginOptions): ReturnType<Plugin> => {
  void input
  const parsed = parseConfig(options)
  const usage = createUsageClient()
  const selector = createKeySelector({ keys: parsed.keys, probe: usage.probe })

  return Promise.resolve({
    config: async (config) => {
      config.provider ??= {}
      if (config.provider[PROVIDER_ID] === undefined) config.provider[PROVIDER_ID] = {}
    },
    "chat.headers": async (hookInput, output) => {
      if (hookInput.model.providerID !== PROVIDER_ID) return

      const selected = await selector.select({
        provider: hookInput.provider,
        model: hookInput.model,
      })
      if (selected === undefined) {
        throw aggregateUnavailableKeys(
          selector.unavailable({
            provider: hookInput.provider,
            model: hookInput.model,
          }),
        )
      }

      for (const name of Object.keys(output.headers)) {
        if (name.toLowerCase() === "authorization") delete output.headers[name]
      }
      output.headers[CANONICAL_AUTHORIZATION] = `Bearer ${selected}`
    },
    dispose: async () => {
      selector.reset()
    },
  })
}

export const server: Plugin = createServer
