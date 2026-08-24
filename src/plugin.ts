import type { Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import {
  COMMAND_DEFINITIONS,
  executeCommand,
  OPENCODE_GO_PROVIDER_ID,
  resolveUsageSelection,
} from "./commands.js"
import { parseConfig } from "./config.js"
import { aggregateUnavailableKeys } from "./errors.js"
import { encodeModalCommand } from "./modal.js"
import { createKeySelector } from "./selector.js"
import { createUsageClient } from "./usage.js"

const PROVIDER_ID = OPENCODE_GO_PROVIDER_ID
const CANONICAL_AUTHORIZATION = "Authorization"

export const createServer = (input: PluginInput, options?: PluginOptions): ReturnType<Plugin> => {
  const parsed = parseConfig(options)
  const usage = createUsageClient()
  const selector = createKeySelector({ keys: parsed.keys, probe: usage.probe })
  const selectionInputs = new Map<string, Parameters<typeof selector.select>[0]>()

  return Promise.resolve({
    config: async (config) => {
      config.provider ??= {}
      if (config.provider[PROVIDER_ID] === undefined) config.provider[PROVIDER_ID] = {}
      config.command ??= {}
      for (const [name, definition] of Object.entries(COMMAND_DEFINITIONS)) {
        if (config.command[name] === undefined) config.command[name] = definition
      }
    },
    "chat.headers": async (hookInput, output) => {
      if (hookInput.model.providerID !== PROVIDER_ID) return

      const selectionInput = {
        provider: hookInput.provider,
        model: hookInput.model,
      }
      selectionInputs.set(hookInput.sessionID, selectionInput)
      const selected = await selector.select(selectionInput)
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
    "command.execute.before": async (hookInput, _output) => {
      const normalizedCommand = hookInput.command.trim().replace(/^\//u, "")
      let commandSelection = selectionInputs.get(hookInput.sessionID)
      if (normalizedCommand === "ogm-usage" && commandSelection === undefined) {
        let catalog: unknown
        try {
          const response = await input.client.config.providers({
            query: { directory: input.directory },
          })
          catalog = response.data
        } catch (error) {
          if (!(error instanceof Error)) throw error
        }
        commandSelection = resolveUsageSelection(catalog)
      }
      const text = await executeCommand(
        hookInput.command,
        {
          keys: parsed.keys,
          selector,
          probe: usage.probe,
          selectionInput: (sessionID) =>
            normalizedCommand === "ogm-usage" ? commandSelection : selectionInputs.get(sessionID),
        },
        hookInput.sessionID,
      )
      if (text === undefined) return
      const title = normalizedCommand === "ogm-switch" ? "OpenCode Go" : "OpenCode Go usage"
      await input.client.tui.publish({
        query: { directory: input.directory },
        body: {
          type: "tui.command.execute",
          properties: {
            command: encodeModalCommand({ title, message: text }),
          },
        },
      })
      throw new Error("OpenCode Go command handled")
    },
    dispose: async () => {
      selector.reset()
      selectionInputs.clear()
    },
  })
}

export const server: Plugin = createServer
