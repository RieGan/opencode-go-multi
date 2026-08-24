import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk"
import { appendCommandPart, formatUsageReport, resolveUsageSelection } from "../src/commands.ts"
import { decodeModalCommand, decodeModalPayload, encodeModalCommand } from "../src/modal.ts"
import type { UsageProbeResult } from "../src/usage.ts"

const eligible = (percent: number): UsageProbeResult => ({
  kind: "eligible",
  usage: {
    rolling: { status: "ok", percent, resetsAt: "2030-01-01T00:00:00.000Z", resetsAtMs: 0 },
    weekly: { status: "ok", percent, resetsAt: "2030-01-02T00:00:00.000Z", resetsAtMs: 0 },
    monthly: { status: "ok", percent, resetsAt: "2030-02-01T00:00:00.000Z", resetsAtMs: 0 },
  },
  windows: {
    rolling: { status: "ok", percent, resetsAt: "2030-01-01T00:00:00.000Z", resetsAtMs: 0 },
    weekly: { status: "ok", percent, resetsAt: "2030-01-02T00:00:00.000Z", resetsAtMs: 0 },
    monthly: { status: "ok", percent, resetsAt: "2030-02-01T00:00:00.000Z", resetsAtMs: 0 },
  },
})

describe("usage command output", () => {
  test("round-trips safe modal command payloads and rejects malformed input", () => {
    const encoded = encodeModalCommand({ title: "Quota", message: "key[1]" })
    expect(decodeModalCommand(encoded)).toEqual({ title: "Quota", message: "key[1]" })
    expect(decodeModalCommand("opencode-go-multi.modal:not-json")).toBeUndefined()
    expect(decodeModalCommand(`opencode-go-multi.modal:${"x".repeat(12_001)}`)).toBeUndefined()
    expect(decodeModalPayload({ title: "Quota", message: "x".repeat(12_001) })).toBeUndefined()
  })

  test("resolves the runtime provider base URL before the default model URL", () => {
    const selection = resolveUsageSelection({
      providers: [
        {
          id: "opencode-go",
          options: { baseURL: "https://configured.example/v1" },
          models: {
            default: { api: { url: "https://model.example/v1/chat/completions" } },
          },
        },
      ],
      default: { "opencode-go": "default" },
    })
    expect(selection?.provider.options?.baseURL).toBe("https://configured.example/v1")
    expect(selection?.model.api.url).toBe("https://model.example/v1/chat/completions")
  })

  test("returns no selection when the runtime provider catalog is absent", () => {
    expect(resolveUsageSelection(undefined)).toBeUndefined()
    expect(resolveUsageSelection({ providers: [], default: {} })).toBeUndefined()
  })

  test("labels every key and never includes raw credentials", () => {
    const report = formatUsageReport(
      ["secret-alpha", "secret-beta"],
      [eligible(72), { kind: "unauthorized" }],
    )
    expect(report).toContain("key[1]")
    expect(report).toContain("key[2]")
    expect(report).toContain("  rolling  28% remaining | 72% used | ok")
    expect(report).toContain("    reset   2030-01-01T00:00:00.000Z")
    expect(report).toContain("key[2]\n  status: unauthorized")
    expect(report).not.toContain("secret-alpha")
    expect(report).not.toContain("secret-beta")
  })

  test("makes consumed and remaining quota semantics explicit", () => {
    const report = formatUsageReport(["secret-alpha"], [eligible(0)])
    expect(report).toContain("rolling  100% remaining | 0% used | ok")
    expect(report.split("\n").every((line) => line.length <= 80)).toBe(true)
  })

  test("redacts malformed snapshots instead of throwing", () => {
    const malformed = { kind: "eligible" }
    const report = formatUsageReport(["secret-alpha"], [malformed])
    expect(report).toContain("key[1]\n  status: probe-failed (invalid-schema)")
    expect(report).not.toContain("secret-alpha")
  })

  test("redacts malformed reset markers and probe failure reasons", () => {
    const malformedWindows = {
      kind: "eligible",
      windows: {
        rolling: { status: "ok", percent: 10, resetsAt: "body-secret-marker" },
        weekly: { status: "ok", percent: 10, resetsAt: "2030-01-01T00:00:00.000Z", resetsAtMs: 0 },
        monthly: { status: "ok", percent: 10, resetsAt: "2030-01-01T00:00:00.000Z", resetsAtMs: 0 },
      },
    }
    const malformedReason = { kind: "probe-failed", reason: "body-secret-marker" }
    const report = formatUsageReport(
      ["secret-alpha", "secret-beta"],
      [malformedWindows, malformedReason],
    )
    expect(report).toContain("key[1]\n  status: probe-failed (invalid-schema)")
    expect(report).toContain("key[2]\n  status: probe-failed (invalid-schema)")
    expect(report).not.toContain("body-secret-marker")
  })

  test("gives successive command parts unique ids", () => {
    const parts: Part[] = []
    appendCommandPart(parts, "session", "first")
    appendCommandPart(parts, "session", "second")
    expect(parts[0]?.id).toBeDefined()
    expect(parts[1]?.id).toBeDefined()
    expect(parts[0]?.id).not.toBe(parts[1]?.id)
  })
})
