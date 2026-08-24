import { describe, expect, test } from "bun:test"
import plugin from "../src/index"
import { decodeModalCommand } from "../src/modal"

const model = {
  providerID: "opencode-go",
  modelID: "go-model",
  api: { url: "https://go.example/v1/chat/completions" },
}
const provider = { source: "config" as const, info: {}, options: {} }
const input = { model, provider, sessionID: "s", agent: "a", message: {} }
const createPluginInput = () =>
  ({
    directory: "/workspace",
    client: {
      config: {
        providers: async () => ({
          data: {
            providers: [
              {
                id: "opencode-go",
                options: { baseURL: "https://go.example/v1" },
                models: { "go-model": { api: { url: model.api.url } } },
              },
            ],
            default: { "opencode-go": "go-model" },
          },
        }),
      },
      tui: { publish: async () => ({ data: true }) },
    },
  }) as never
const createToastPluginInput = (onToast: (message: string) => void) =>
  ({
    directory: "/workspace",
    client: {
      config: {
        providers: async () => ({
          data: {
            providers: [
              {
                id: "opencode-go",
                options: { baseURL: "https://go.example/v1" },
                models: { "go-model": { api: { url: model.api.url } } },
              },
            ],
            default: { "opencode-go": "go-model" },
          },
        }),
      },
      tui: {
        publish: async (options: {
          readonly body?: {
            readonly type: "tui.command.execute"
            readonly properties: { readonly command: string }
          }
          readonly query?: { readonly directory?: string }
        }) => {
          if (options.body?.type === "tui.command.execute") {
            const modal = decodeModalCommand(options.body.properties.command)
            if (modal !== undefined) onToast(modal.message)
          }
          return { data: true }
        },
      },
    },
  }) as never
const usageBody = {
  usage: {
    rolling: { status: "ok", percent: 1, resetsAt: "2030-01-01T00:00:00.000Z" },
    weekly: { status: "ok", percent: 1, resetsAt: "2030-01-01T00:00:00.000Z" },
    monthly: { status: "ok", percent: 1, resetsAt: "2030-01-01T00:00:00.000Z" },
  },
}

describe("plugin server hooks", () => {
  test("activates provider and canonically replaces authorization", async () => {
    const previous = globalThis.fetch
    globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => usageBody })
    try {
      const hooks = await plugin.server(createPluginInput(), { keys: ["fixture-key"] })
      const config = {
        enabled_providers: ["other"],
        disabled_providers: ["disabled"],
        provider: { other: { name: "keep" } },
      }
      await hooks.config?.(config)
      expect(config.provider["opencode-go"]).toEqual({})
      const output = { headers: { authorization: "old", AUTHORIZATION: "old2", "X-Trace": "yes" } }
      await hooks["chat.headers"]?.(input, output)
      expect(output.headers).toEqual({ "X-Trace": "yes", Authorization: "Bearer fixture-key" })
      expect(config.enabled_providers).toEqual(["other"])
      expect(config.disabled_providers).toEqual(["disabled"])
    } finally {
      globalThis.fetch = previous
    }
  })

  test("leaves another provider byte-for-byte untouched", async () => {
    const hooks = await plugin.server(createPluginInput(), { keys: ["fixture-key"] })
    const otherInput = { ...input, model: { ...model, providerID: "other" } }
    const output = { headers: { authorization: "untouched", "X-Trace": "yes" } }
    const before = JSON.stringify(output)
    await hooks["chat.headers"]?.(otherInput, output)
    expect(JSON.stringify(output)).toBe(before)
  })

  test("returns only supported hook keys", async () => {
    const hooks = await plugin.server(createPluginInput(), { keys: ["fixture-key"] })
    expect(Object.keys(hooks).sort()).toEqual([
      "chat.headers",
      "command.execute.before",
      "config",
      "dispose",
    ])
  })

  test("registers safe commands and probes usage without credentials", async () => {
    const previous = globalThis.fetch
    globalThis.fetch = async (resource) => {
      expect(String(resource)).toContain("/usage")
      return { status: 200, ok: true, json: async () => usageBody }
    }
    try {
      const hooks = await plugin.server(createPluginInput(), {
        keys: ["command-secret-one", "command-secret-two"],
      })
      const config = { provider: {} as Record<string, unknown> }
      await hooks.config?.(config)
      expect(config.command).toMatchObject({
        "ogm-usage": { template: expect.any(String) },
        "ogm-switch": { template: expect.any(String) },
      })
      await expect(
        hooks["command.execute.before"]?.(
          { command: "ogm-usage", sessionID: "session", arguments: "" },
          { parts: [] as never[] },
        ),
      ).rejects.toThrow("OpenCode Go command handled")
    } finally {
      globalThis.fetch = previous
    }
  })

  test("shows submitted usage commands in the OpenCode TUI instead of only feeding the model", async () => {
    const previous = globalThis.fetch
    const published: Array<{
      readonly body?: {
        readonly type: "tui.command.execute"
        readonly properties: { readonly command: string }
      }
      readonly query?: { readonly directory?: string }
    }> = []
    globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => usageBody })
    try {
      const hooks = await plugin.server(
        {
          directory: "/workspace",
          client: {
            config: {
              providers: async () => ({
                data: {
                  providers: [
                    {
                      id: "opencode-go",
                      options: { baseURL: "https://go.example/v1" },
                      models: { "go-model": { api: { url: model.api.url } } },
                    },
                  ],
                  default: { "opencode-go": "go-model" },
                },
              }),
            },
            tui: {
              publish: async (options: {
                readonly body?: {
                  readonly type: "tui.command.execute"
                  readonly properties: { readonly command: string }
                }
                readonly query?: { readonly directory?: string }
              }) => {
                published.push(options)
                return { data: true }
              },
            },
          },
        } as never,
        { keys: ["toast-secret"] },
      )
      await hooks["chat.headers"]?.(input, { headers: {} })
      const output = {
        parts: [
          {
            id: "prt_command-template",
            sessionID: "s",
            messageID: "msg-command",
            type: "text",
            text: "Show OpenCode Go quota for every configured key.",
          },
        ] as never[],
      }
      await expect(
        hooks["command.execute.before"]?.(
          { command: "ogm-usage", sessionID: "s", arguments: "" },
          output,
        ),
      ).rejects.toThrow("OpenCode Go command handled")
      expect(output.parts).toHaveLength(1)
      expect(published).toHaveLength(1)
      expect(published[0]?.query?.directory).toBe("/workspace")
      expect(published[0]?.body?.type).toBe("tui.command.execute")
      const modal = decodeModalCommand(published[0]?.body?.properties.command)
      expect(modal?.title).toBe("OpenCode Go usage")
      expect(modal?.message).toContain("OpenCode Go usage")
      expect(modal?.message).toContain("key[1]")
      expect(modal?.message).not.toContain("toast-secret")
    } finally {
      globalThis.fetch = previous
    }
  })

  test("stops model continuation after handling a usage command", async () => {
    const previous = globalThis.fetch
    let modelRuns = 0
    const shown: string[] = []
    const toastDirectories: Array<string | undefined> = []
    const publishedCommands: string[] = []
    globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => usageBody })
    try {
      const hooks = await plugin.server(
        {
          directory: "/workspace",
          client: {
            config: {
              providers: async () => ({
                data: {
                  providers: [
                    {
                      id: "opencode-go",
                      options: { baseURL: "https://go.example/v1" },
                      models: {
                        "go-model": { api: { url: "https://go.example/v1/chat/completions" } },
                      },
                    },
                  ],
                  default: { "opencode-go": "go-model" },
                },
              }),
            },
            tui: {
              publish: async (options: {
                readonly body?: {
                  readonly type: "tui.command.execute"
                  readonly properties: { readonly command: string }
                }
                readonly query?: { readonly directory?: string }
              }) => {
                const modal =
                  options.body?.type === "tui.command.execute"
                    ? decodeModalCommand(options.body.properties.command)
                    : undefined
                const message = modal?.message
                if (message !== undefined) shown.push(message)
                toastDirectories.push(options.query?.directory)
                if (options.body?.type === "tui.command.execute") {
                  publishedCommands.push(options.body.properties.command)
                }
                return { data: true }
              },
            },
          },
        } as never,
        { keys: ["regression-secret"] },
      )
      try {
        await hooks["command.execute.before"]?.(
          { command: "ogm-usage", sessionID: "session", arguments: "" },
          { parts: [{ text: "command template" }] as never[] },
        )
        modelRuns += 1
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
      }
      expect(modelRuns).toBe(0)
      expect(shown).toHaveLength(1)
      expect(toastDirectories).toEqual(["/workspace"])
      expect(publishedCommands).toHaveLength(1)
      expect(publishedCommands[0]).toMatch(/^opencode-go-multi\.modal:/u)
      expect(publishedCommands[0]).not.toContain("regression-secret")
    } finally {
      globalThis.fetch = previous
    }
  })

  test("switch command wraps and changes the next selected key", async () => {
    const previous = globalThis.fetch
    const seen: string[] = []
    globalThis.fetch = async (_resource, init) => {
      const authorization = init?.headers?.Authorization
      if (authorization !== undefined) seen.push(authorization)
      return { status: 200, ok: true, json: async () => usageBody }
    }
    try {
      const hooks = await plugin.server(createPluginInput(), { keys: ["first", "second"] })
      const output = { headers: {} }
      await hooks["chat.headers"]?.(input, output)
      const commandOutput = { parts: [] as never[] }
      await expect(
        hooks["command.execute.before"]?.(
          { command: "ogm-switch", sessionID: "session", arguments: "" },
          commandOutput,
        ),
      ).rejects.toThrow("OpenCode Go command handled")
      await hooks["chat.headers"]?.(input, output)
      expect(output.headers.Authorization).toBe("Bearer second")
      expect(seen).toEqual(["Bearer first", "Bearer second"])
    } finally {
      globalThis.fetch = previous
    }
  })

  test("routes usage commands to the matching session context", async () => {
    const previous = globalThis.fetch
    const requested: string[] = []
    globalThis.fetch = async (resource) => {
      const url = String(resource)
      requested.push(url)
      const percent = url.includes("first.example") ? 11 : 22
      const body = {
        usage: {
          rolling: { status: "ok", percent, resetsAt: "2030-01-01T00:00:00.000Z" },
          weekly: { status: "ok", percent, resetsAt: "2030-01-02T00:00:00.000Z" },
          monthly: { status: "ok", percent, resetsAt: "2030-02-01T00:00:00.000Z" },
        },
      }
      return { status: 200, ok: true, json: async () => body }
    }
    try {
      const shown: string[] = []
      const hooks = await plugin.server(
        createToastPluginInput((message) => shown.push(message)),
        {
          keys: ["session-key"],
        },
      )
      const firstInput = {
        ...input,
        sessionID: "first-session",
        provider: { ...provider, options: { baseURL: "https://first.example/v1" } },
      }
      const secondInput = {
        ...input,
        sessionID: "second-session",
        provider: { ...provider, options: { baseURL: "https://second.example/v1" } },
      }
      await hooks["chat.headers"]?.(firstInput, { headers: {} })
      await hooks["chat.headers"]?.(secondInput, { headers: {} })
      requested.length = 0
      const firstOutput = { parts: [] as never[] }
      const secondOutput = { parts: [] as never[] }
      await expect(
        hooks["command.execute.before"]?.(
          { command: "ogm-usage", sessionID: "first-session", arguments: "" },
          firstOutput,
        ),
      ).rejects.toThrow("OpenCode Go command handled")
      await expect(
        hooks["command.execute.before"]?.(
          { command: "ogm-usage", sessionID: "second-session", arguments: "" },
          secondOutput,
        ),
      ).rejects.toThrow("OpenCode Go command handled")
      expect(shown[0]).toContain("89% remaining | 11% used")
      expect(shown[1]).toContain("78% remaining | 22% used")
      expect(requested.some((url) => url.includes("first.example/v1/usage"))).toBe(true)
      expect(requested.some((url) => url.includes("second.example/v1/usage"))).toBe(true)
    } finally {
      globalThis.fetch = previous
    }
  })

  test("fails closed when a session has no live context after disposal", async () => {
    const previous = globalThis.fetch
    const requested: string[] = []
    globalThis.fetch = async (resource) => {
      requested.push(String(resource))
      return { status: 200, ok: true, json: async () => usageBody }
    }
    try {
      const shown: string[] = []
      const hooks = await plugin.server(
        createToastPluginInput((message) => shown.push(message)),
        {
          keys: ["dispose-secret"],
        },
      )
      await hooks["chat.headers"]?.(
        {
          ...input,
          sessionID: "disposed-session",
          provider: { ...provider, options: { baseURL: "https://disposed.example/v1" } },
        },
        { headers: {} },
      )
      requested.length = 0
      await hooks.dispose?.()
      const output = { parts: [] as never[] }
      await expect(
        hooks["command.execute.before"]?.(
          { command: "ogm-usage", sessionID: "disposed-session", arguments: "" },
          output,
        ),
      ).rejects.toThrow("OpenCode Go command handled")
      expect(shown[0]).toContain("rolling  99% remaining | 1% used")
      expect(shown[0]).not.toContain("dispose-secret")
      expect(requested).toHaveLength(1)
    } finally {
      globalThis.fetch = previous
    }
  })

  test("fails closed when the runtime provider catalog has no OpenCode Go default", async () => {
    const previous = globalThis.fetch
    const requested: string[] = []
    const shown: string[] = []
    globalThis.fetch = async (resource) => {
      requested.push(String(resource))
      return { status: 200, ok: true, json: async () => usageBody }
    }
    try {
      const hooks = await plugin.server(
        {
          directory: "/workspace",
          client: {
            config: { providers: async () => ({ data: { providers: [], default: {} } }) },
            tui: {
              publish: async (options: {
                readonly body?: {
                  readonly type: "tui.command.execute"
                  readonly properties: { readonly command: string }
                }
              }) => {
                if (options.body?.type === "tui.command.execute") {
                  const modal = decodeModalCommand(options.body.properties.command)
                  if (modal !== undefined) shown.push(modal.message)
                }
                return { data: true }
              },
            },
          },
        } as never,
        { keys: ["catalog-secret"] },
      )
      await expect(
        hooks["command.execute.before"]?.(
          { command: "ogm-usage", sessionID: "session", arguments: "" },
          { parts: [] as never[] },
        ),
      ).rejects.toThrow("OpenCode Go command handled")
      expect(shown[0]).toContain("status: probe-failed (invalid-url)")
      expect(shown[0]).not.toContain("catalog-secret")
      expect(requested).toEqual([])
    } finally {
      globalThis.fetch = previous
    }
  })

  test("uses environment keys when options omit keys", async () => {
    const previousKeys = process.env.OPENCODE_GO_API_KEYS
    process.env.OPENCODE_GO_API_KEYS = "env-fixture-key"
    try {
      const previous = globalThis.fetch
      globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => usageBody })
      try {
        const hooks = await plugin.server(createPluginInput(), {})
        const output = { headers: {} }
        await hooks["chat.headers"]?.(input, output)
        expect(output.headers).toEqual({ Authorization: "Bearer env-fixture-key" })
      } finally {
        globalThis.fetch = previous
      }
    } finally {
      if (previousKeys === undefined) delete process.env.OPENCODE_GO_API_KEYS
      else process.env.OPENCODE_GO_API_KEYS = previousKeys
    }
  })

  test("reports all-unavailable keys without exposing key material", async () => {
    const previous = globalThis.fetch
    globalThis.fetch = async () => ({ status: 401, ok: false, json: async () => ({}) })
    try {
      const hooks = await plugin.server(createPluginInput(), { keys: ["secret-fixture"] })
      await expect(hooks["chat.headers"]?.(input, { headers: {} })).rejects.toMatchObject({
        code: "OPENCODE_GO_ALL_KEYS_UNAVAILABLE",
      })
      try {
        await hooks["chat.headers"]?.(input, { headers: {} })
      } catch (error) {
        if (!(error instanceof Error)) throw error
        expect(String(error)).not.toContain("secret-fixture")
      }
    } finally {
      globalThis.fetch = previous
    }
  })

  test("preserves safe rate-limit outcomes when every key is limited", async () => {
    const previous = globalThis.fetch
    globalThis.fetch = async () => ({
      status: 200,
      ok: true,
      json: async () => ({
        usage: {
          ...usageBody.usage,
          rolling: {
            status: "rate-limited",
            percent: 100,
            resetsAt: "2030-01-03T00:00:00.000Z",
          },
        },
      }),
    })
    try {
      const hooks = await plugin.server(createPluginInput(), {
        keys: ["limited-fixture-alpha", "limited-fixture-beta"],
      })
      try {
        await hooks["chat.headers"]?.(input, { headers: {} })
        throw new Error("expected all keys to be unavailable")
      } catch (error) {
        if (!(error instanceof Error)) throw error
        expect(error).toMatchObject({
          code: "OPENCODE_GO_ALL_KEYS_UNAVAILABLE",
          entries: [
            { keyLabel: "key[1]", reason: "rate-limited" },
            { keyLabel: "key[2]", reason: "rate-limited" },
          ],
          retryAt: "2030-01-03T00:00:01.000Z",
        })
        const serialized = JSON.stringify(error)
        expect(serialized).not.toContain("limited-fixture-alpha")
        expect(serialized).not.toContain("limited-fixture-beta")
      }
    } finally {
      globalThis.fetch = previous
    }
  })
})
