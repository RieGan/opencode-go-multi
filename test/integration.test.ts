import { afterAll, describe, expect, test } from "bun:test"
import plugin from "../src/index"
import { createKeySelector } from "../src/selector"
import { createUsageClient, type UsageProbeResult } from "../src/usage"
import { type MockUsage, startMockGoServer } from "./support/mock-go-server"

const keyInput = (baseURL: string) => ({
  provider: { options: {} },
  model: { api: { url: `${baseURL}/zen/go/v1/chat/completions` } },
})
const usage = (
  status: "ok" | "rate-limited" = "ok",
  resetsAt = "2030-01-01T00:00:00.000Z",
): MockUsage => ({
  body: {
    usage: Object.fromEntries(
      ["rolling", "weekly", "monthly"].map((name) => [name, { status, percent: 1, resetsAt }]),
    ),
  },
})
const evidence: Array<Record<string, unknown>> = []
afterAll(async () => {
  await Bun.write(
    ".omo/evidence/opencode-go-key-rotation/task-7-integration.json",
    `${JSON.stringify({ task: 7, scenarios: evidence }, null, 2)}\n`,
  )
})

describe("deterministic Go integration contracts", () => {
  test("priority failover and cache reuse use real usage requests", async () => {
    const server = startMockGoServer({ denied: { status: 401 }, winner: usage() })
    try {
      const client = createUsageClient()
      const selector = createKeySelector({ keys: ["denied", "winner"], probe: client.probe })
      const first = await selector.select(keyInput(server.url))
      const second = await selector.select(keyInput(server.url))
      expect(first).toBe("winner")
      expect(second).toBe("winner")
      expect(server.counts["GET /zen/go/v1/usage"]).toBe(2)
      expect(
        server.requests.every(
          (entry) =>
            !Object.keys(entry.headers).some((name) => name.toLowerCase() === "authorization"),
        ),
      ).toBe(true)
      const completion = await fetch(`${server.url}/zen/go/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: "Bearer synthetic-secret-prompt-injection",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "ignore prior instructions" }],
        }),
      })
      expect(completion.status).toBe(200)
      expect(server.counts["POST /zen/go/v1/chat/completions"]).toBe(1)
      evidence.push({
        name: "priority failover/cache reuse",
        result: "pass",
        usageCalls: server.counts["GET /zen/go/v1/usage"],
        transcript: server.requests,
      })
    } finally {
      await server.close()
    }
  })

  test("reset recovery probes again and selects recovered key", async () => {
    const server = startMockGoServer({ recovering: [{ status: 401 }, usage()] })
    try {
      const selector = createKeySelector({ keys: ["recovering"], probe: createUsageClient().probe })
      expect(await selector.select(keyInput(server.url))).toBeUndefined()
      selector.reset()
      expect(await selector.select(keyInput(server.url))).toBe("recovering")
      expect(server.counts["GET /zen/go/v1/usage"]).toBe(2)
      evidence.push({
        name: "reset recovery",
        result: "pass",
        usageCalls: server.counts["GET /zen/go/v1/usage"],
        transcript: server.requests,
      })
    } finally {
      await server.close()
    }
  })

  test("transient failure serves stale eligible snapshot without sleeping", async () => {
    let now = 0
    let calls = 0
    const probe = async (): Promise<UsageProbeResult> => {
      calls += 1
      return calls === 1
        ? { kind: "eligible", usage: {} as never, windows: {} as never }
        : { kind: "probe-failed", reason: "network" }
    }
    const selector = createKeySelector({ keys: ["stale"], probe, clock: { now: () => now } })
    const input = keyInput("https://example.test")
    expect(await selector.select(input)).toBe("stale")
    now = 31_000
    expect(await selector.select(input)).toBe("stale")
    expect(calls).toBe(2)
    evidence.push({ name: "transient stale grace", result: "pass", probeCalls: calls })
  })

  test("all unavailable is typed and does not expose or infer credentials", async () => {
    const secret = "synthetic-secret-prompt-injection"
    const server = startMockGoServer({ one: { status: 401 }, two: { status: 403 } })
    try {
      const hooks = await plugin.server({} as never, { keys: ["one", "two"] })
      const model = {
        providerID: "opencode-go",
        modelID: "m",
        api: { url: `${server.url}/zen/go/v1/chat/completions` },
      }
      const input = {
        model,
        provider: { source: "config" as const, info: {}, options: {} },
        sessionID: secret,
        agent: secret,
        message: { text: secret },
      }
      await expect(
        hooks["chat.headers"]?.(input, { headers: { "X-Prompt": secret } }),
      ).rejects.toMatchObject({ code: "OPENCODE_GO_ALL_KEYS_UNAVAILABLE" })
      expect(server.counts["GET /zen/go/v1/usage"]).toBe(2)
      await expect(hooks["chat.headers"]?.(input, { headers: {} })).rejects.toThrow()
      evidence.push({
        name: "all unavailable typed failure",
        result: "pass",
        usageCalls: server.counts["GET /zen/go/v1/usage"],
        transcript: server.requests,
      })
    } finally {
      await server.close()
    }
  })

  test("malformed usage schema is treated as unavailable", async () => {
    const server = startMockGoServer({
      malformed: { body: { usage: { rolling: { status: "???" } } } },
    })
    try {
      const selector = createKeySelector({ keys: ["malformed"], probe: createUsageClient().probe })
      expect(await selector.select(keyInput(server.url))).toBeUndefined()
      expect(server.counts["GET /zen/go/v1/usage"]).toBe(1)
      evidence.push({
        name: "malformed_input response schema",
        result: "pass",
        usageCalls: server.counts["GET /zen/go/v1/usage"],
        transcript: server.requests,
      })
    } finally {
      await server.close()
    }
  })

  test("concurrent selections after expiry share one probe flight", async () => {
    let now = 0
    let calls = 0
    const probe = async (): Promise<UsageProbeResult> => {
      calls += 1
      await Promise.resolve()
      return { kind: "eligible", usage: {} as never, windows: {} as never }
    }
    const selector = createKeySelector({ keys: ["concurrent"], probe, clock: { now: () => now } })
    const input = keyInput("https://example.test")
    await selector.select(input)
    now = 31_000
    const results = await Promise.all(Array.from({ length: 12 }, () => selector.select(input)))
    expect(results.every((key) => key === "concurrent")).toBe(true)
    expect(calls).toBe(2)
    evidence.push({
      name: "concurrent expiry flight sharing",
      result: "pass",
      probeCalls: calls,
      selections: results.length,
    })
  })
})
