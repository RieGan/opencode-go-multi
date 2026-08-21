import { describe, expect, test } from "bun:test"
import { createUsageClient, deriveUsageUrl, type UsageProbeInput } from "../src/usage.ts"

const KEY = "fixture-go-key-usage"
const windows = {
  rolling: { status: "ok", percent: 10, resetsAt: "2030-01-01T00:00:00.000Z" },
  weekly: { status: "ok", percent: 20, resetsAt: "2030-01-02T00:00:00.000Z" },
  monthly: { status: "ok", percent: 30, resetsAt: "2030-02-01T00:00:00.000Z" },
} as const

const input = (baseURL?: string): UsageProbeInput => ({
  key: KEY,
  provider: { options: baseURL === undefined ? {} : { baseURL } },
  model: { api: { url: "https://fallback.example/zen/go/v1/chat/completions" } },
})

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

describe("deriveUsageUrl", () => {
  test("normalizes configured and model inference suffixes beneath v1", () => {
    expect(deriveUsageUrl("https://example.test/zen/go/v1/chat/completions")).toBe(
      "https://example.test/zen/go/v1/usage",
    )
    expect(deriveUsageUrl("https://example.test/zen/go/v1/responses/")).toBe(
      "https://example.test/zen/go/v1/usage",
    )
    expect(deriveUsageUrl("https://example.test/zen/go/v1/messages")).toBe(
      "https://example.test/zen/go/v1/usage",
    )
  })
})

describe("usage probe", () => {
  test("sends one canonical GET request and returns an eligible snapshot", async () => {
    let request: Request | undefined
    const client = createUsageClient({
      fetch: async (resource, init) => {
        request = new Request(resource, init)
        return jsonResponse({ usage: windows })
      },
    })
    const result = await client.probe(input("https://example.test/zen/go/v1"))
    expect(result.kind).toBe("eligible")
    expect(request?.method).toBe("GET")
    expect(new URL(request?.url ?? "").pathname).toBe("/zen/go/v1/usage")
    expect(request?.headers.get("authorization")).toBe(`Bearer ${KEY}`)
    expect(request?.headers.get("content-type")).toBeNull()
  })

  test("prefers non-empty configured base over model URL", async () => {
    let requestedUrl = ""
    const client = createUsageClient({
      fetch: async (resource) => {
        requestedUrl = String(resource)
        return jsonResponse({ usage: windows })
      },
    })
    await client.probe(input(" https://configured.example/zen/go/v1/responses "))
    expect(requestedUrl).toBe("https://configured.example/zen/go/v1/usage")
  })

  for (const [name, mutation] of [
    [
      "rolling",
      (value: typeof windows) => ({
        ...value,
        rolling: { ...value.rolling, status: "rate-limited" },
      }),
    ],
    [
      "weekly",
      (value: typeof windows) => ({
        ...value,
        weekly: { ...value.weekly, status: "rate-limited" },
      }),
    ],
    [
      "monthly",
      (value: typeof windows) => ({
        ...value,
        monthly: { ...value.monthly, status: "rate-limited" },
      }),
    ],
  ] as const) {
    test(`returns an authoritative limited snapshot for ${name}`, async () => {
      const client = createUsageClient({
        fetch: async () => jsonResponse({ usage: mutation(windows) }),
      })
      const result = await client.probe(input())
      expect(result.kind).toBe("limited")
      if (result.kind === "limited") expect(result.limitedWindows).toEqual([name])
    })
  }

  test("reports multiple limited windows and tolerates additive fields", async () => {
    const client = createUsageClient({
      fetch: async () =>
        jsonResponse({
          usage: {
            ...windows,
            rolling: { ...windows.rolling, status: "rate-limited", extra: "ignored" },
            monthly: { ...windows.monthly, status: "rate-limited" },
            extra: { ignored: true },
          },
        }),
    })
    const result = await client.probe(input())
    expect(result.kind).toBe("limited")
    if (result.kind === "limited") expect(result.limitedWindows).toEqual(["rolling", "monthly"])
  })

  for (const status of [401, 403, 408, 425, 429, 500, 503, 418]) {
    test(`maps HTTP ${status} without reading or exposing a body`, async () => {
      const secretBody = `echoed-body-${KEY}`
      const client = createUsageClient({ fetch: async () => new Response(secretBody, { status }) })
      const result = await client.probe(input())
      expect(result.kind).toBe(
        status === 401 ? "unauthorized" : status === 403 ? "no-entitlement" : "probe-failed",
      )
      expect(JSON.stringify(result)).not.toContain(KEY)
      expect(JSON.stringify(result)).not.toContain(secretBody)
    })
  }

  test("maps malformed JSON and schema violations without body text", async () => {
    const malformed = createUsageClient({
      fetch: async () => new Response(`not-json-${KEY}`, { status: 200 }),
    })
    const invalid = createUsageClient({
      fetch: async () =>
        jsonResponse({ usage: { rolling: windows.rolling, weekly: windows.weekly } }),
    })
    expect((await malformed.probe(input())).kind).toBe("probe-failed")
    expect((await invalid.probe(input())).kind).toBe("probe-failed")
  })

  test("rejects invalid status, date, and percent", async () => {
    const variants = [
      { ...windows, rolling: { ...windows.rolling, status: "unknown" } },
      { ...windows, weekly: { ...windows.weekly, resetsAt: "not-a-date" } },
      { ...windows, monthly: { ...windows.monthly, percent: Number.NaN } },
      { ...windows, monthly: { ...windows.monthly, percent: -1 } },
    ]
    for (const usage of variants) {
      const client = createUsageClient({ fetch: async () => jsonResponse({ usage }) })
      expect((await client.probe(input())).kind).toBe("probe-failed")
    }
  })

  test("maps timeout and network failures and leaves no timer pending", async () => {
    const client = createUsageClient({
      fetch: async (_resource, init) =>
        new Promise<Response>((_, reject) => {
          const signal = init?.signal
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          )
        }),
      timeoutMs: 5,
    })
    expect((await client.probe(input())).kind).toBe("probe-failed")

    const network = createUsageClient({
      fetch: async () => {
        throw new Error(`network-${KEY}`)
      },
    })
    const result = await network.probe(input())
    expect(result.kind).toBe("probe-failed")
    expect(JSON.stringify(result)).not.toContain(KEY)
  })
})
