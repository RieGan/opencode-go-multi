import { describe, expect, test } from "bun:test"
import plugin from "../src/index"

const model = {
  providerID: "opencode-go",
  modelID: "go-model",
  api: { url: "https://go.example/v1/chat/completions" },
}
const provider = { source: "config" as const, info: {}, options: {} }
const input = { model, provider, sessionID: "s", agent: "a", message: {} }
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
      const hooks = await plugin.server({} as never, { keys: ["fixture-key"] })
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
    const hooks = await plugin.server({} as never, { keys: ["fixture-key"] })
    const otherInput = { ...input, model: { ...model, providerID: "other" } }
    const output = { headers: { authorization: "untouched", "X-Trace": "yes" } }
    const before = JSON.stringify(output)
    await hooks["chat.headers"]?.(otherInput, output)
    expect(JSON.stringify(output)).toBe(before)
  })

  test("returns only supported hook keys", async () => {
    const hooks = await plugin.server({} as never, { keys: ["fixture-key"] })
    expect(Object.keys(hooks).sort()).toEqual(["chat.headers", "config", "dispose"])
  })

  test("uses environment keys when options omit keys", async () => {
    const previousKeys = process.env.OPENCODE_GO_API_KEYS
    process.env.OPENCODE_GO_API_KEYS = "env-fixture-key"
    try {
      const previous = globalThis.fetch
      globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => usageBody })
      try {
        const hooks = await plugin.server({} as never, {})
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
      const hooks = await plugin.server({} as never, { keys: ["secret-fixture"] })
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
      const hooks = await plugin.server({} as never, {
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
