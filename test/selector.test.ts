import { describe, expect, test } from "bun:test"
import { createKeySelector, type KeySelectionInput } from "../src/selector.ts"
import type { UsageProbeResult, UsageWindowName, UsageWindows } from "../src/usage.ts"

const input = (url = "https://go.example/v1/chat/completions"): KeySelectionInput => ({
  provider: { options: { baseURL: url } },
  model: { api: { url } },
})
const usage = (
  limited: readonly UsageWindowName[] = [],
  resets = [5_000, 7_000, 9_000],
): UsageWindows => ({
  rolling: {
    status: limited.includes("rolling") ? "rate-limited" : "ok",
    percent: 1,
    resetsAt: new Date(resets[0] ?? 0).toISOString(),
    resetsAtMs: resets[0] ?? 0,
  },
  weekly: {
    status: limited.includes("weekly") ? "rate-limited" : "ok",
    percent: 1,
    resetsAt: new Date(resets[1] ?? 0).toISOString(),
    resetsAtMs: resets[1] ?? 0,
  },
  monthly: {
    status: limited.includes("monthly") ? "rate-limited" : "ok",
    percent: 1,
    resetsAt: new Date(resets[2] ?? 0).toISOString(),
    resetsAtMs: resets[2] ?? 0,
  },
})
const eligible = (): UsageProbeResult => {
  const windows = usage()
  return { kind: "eligible", usage: windows, windows }
}
const limited = (
  limitedWindows: readonly UsageWindowName[],
  resets?: readonly number[],
): UsageProbeResult => {
  const windows = usage(limitedWindows, resets)
  return { kind: "limited", usage: windows, windows, limitedWindows }
}

describe("priority selector boundary matrix", () => {
  test("keeps stable priority and stickiness at 29,999ms, then refreshes at 30,000ms", async () => {
    let now = 0
    const seen: string[] = []
    const selector = createKeySelector({
      keys: ["k1", "k2"],
      clock: { now: () => now },
      probe: async ({ key }) => {
        seen.push(key)
        return eligible()
      },
    })
    expect(await selector.select(input())).toBe("k1")
    now = 29_999
    expect(await selector.select(input())).toBe("k1")
    expect(seen).toEqual(["k1"])
    now = 30_000
    expect(await selector.select(input())).toBe("k1")
    expect(seen).toEqual(["k1", "k1"])
  })

  test("uses every quota window and the latest limited reset plus one second", async () => {
    const cases: readonly (readonly UsageWindowName[])[] = [
      ["rolling"],
      ["weekly"],
      ["monthly"],
      ["rolling", "weekly", "monthly"],
    ]
    for (const limitedWindows of cases) {
      let now = 0
      let calls = 0
      const selector = createKeySelector({
        keys: ["quota-key"],
        clock: { now: () => now },
        probe: async () => {
          calls += 1
          return calls === 1 ? limited(limitedWindows) : eligible()
        },
      })
      const latest = Math.max(...limitedWindows.map((name) => usage()[name].resetsAtMs))
      expect(await selector.select(input())).toBeUndefined()
      expect(selector.unavailable(input())[0]?.result.resetAt).toBe(
        new Date(latest + 1_000).toISOString(),
      )
      now = latest + 999
      expect(await selector.select(input())).toBeUndefined()
      expect(calls).toBe(1)
      now = latest + 1_000
      expect(await selector.select(input())).toBe("quota-key")
      expect(calls).toBe(2)
    }
  })

  test("uses stale success only for transient failure through 299,999ms, not at 300,000ms", async () => {
    let now = 0
    let calls = 0
    const selector = createKeySelector({
      keys: ["stale-key"],
      clock: { now: () => now },
      probe: async () => {
        calls += 1
        return calls === 1 ? eligible() : { kind: "probe-failed", reason: "network" }
      },
    })
    expect(await selector.select(input())).toBe("stale-key")
    now = 30_000
    expect(await selector.select(input())).toBe("stale-key")
    now = 299_999
    expect(await selector.select(input())).toBe("stale-key")
    now = 300_000
    expect(await selector.select(input())).toBeUndefined()
    expect(selector.unavailable(input())[0]?.result.kind).toBe("probe-failed")
  })

  test("fails closed without a snapshot and never treats 401 or 403 as transient", async () => {
    const denied: readonly UsageProbeResult[] = [
      { kind: "unauthorized" },
      { kind: "no-entitlement" },
    ]
    for (const denial of denied) {
      let now = 0
      let calls = 0
      const selector = createKeySelector({
        keys: ["denied-key"],
        clock: { now: () => now },
        probe: async () => {
          calls += 1
          return calls === 1 ? eligible() : denial
        },
      })
      expect(selector.unavailable(input())[0]?.result.kind).toBe("no-stale-snapshot")
      expect(await selector.select(input())).toBe("denied-key")
      now = 30_000
      expect(await selector.select(input())).toBeUndefined()
      expect(selector.unavailable(input())[0]?.result.kind).toBe(denial.kind)
      now = 59_999
      expect(await selector.select(input())).toBeUndefined()
      expect(calls).toBe(2)
    }
  })

  test("stops at the first eligible key and restores priority after quota recovery", async () => {
    let now = 0
    const seen: string[] = []
    const selector = createKeySelector({
      keys: ["first", "second", "third"],
      clock: { now: () => now },
      probe: async ({ key }) => {
        seen.push(key)
        return key === "first" && now === 0 ? limited(["rolling"]) : eligible()
      },
    })
    expect(await selector.select(input())).toBe("second")
    expect(seen).toEqual(["first", "second"])
    expect(await selector.select(input())).toBe("second")
    now = 6_000
    expect(await selector.select(input())).toBe("first")
    expect(seen).toEqual(["first", "second", "first"])
  })

  test("isolates endpoint records and concurrent flights", async () => {
    const resolvers = new Map<string, (result: UsageProbeResult) => void>()
    const seen: string[] = []
    const selector = createKeySelector({
      keys: ["shared"],
      probe: async ({ provider }) => {
        const endpoint = provider.options?.baseURL ?? ""
        seen.push(endpoint)
        return await new Promise<UsageProbeResult>((resolve) => resolvers.set(endpoint, resolve))
      },
    })
    const a = input("https://a.example/v1/chat/completions")
    const b = input("https://b.example/v1/chat/completions")
    const firstA = selector.select(a)
    const secondA = selector.select(a)
    const firstB = selector.select(b)
    expect(seen).toEqual([
      "https://a.example/v1/chat/completions",
      "https://b.example/v1/chat/completions",
    ])
    resolvers.get("https://a.example/v1/chat/completions")?.(eligible())
    resolvers.get("https://b.example/v1/chat/completions")?.(eligible())
    expect(await Promise.all([firstA, secondA, firstB])).toEqual(["shared", "shared", "shared"])
  })

  test("maps malformed or unexpected probe outcomes to a safe failure", async () => {
    const selector = createKeySelector({
      keys: ["malformed-key"],
      probe: async () => JSON.parse('{"kind":"unexpected","secret":"provider-body"}'),
    })
    expect(await selector.select(input())).toBeUndefined()
    expect(selector.unavailable(input())[0]?.result.kind).toBe("probe-failed")
  })
})
