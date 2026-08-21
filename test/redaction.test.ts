import { describe, expect, test } from "bun:test"
import { aggregateUnavailableKeys, mapUsageResultToSafeReason } from "../src/errors"

const fixtures = ["fixture-go-key-alpha", "fixture-go-key-beta", "fixture-go-key-gamma"]
const body =
  "provider-body fixture-go-key-alpha Authorization Bearer fixture-go-key-beta hash-abcdef0123456789"

describe("aggregate key diagnostics", () => {
  test("maps usage outcomes to the selector-safe reason union", () => {
    expect(
      mapUsageResultToSafeReason({
        kind: "limited",
        usage: undefined,
        windows: undefined,
        limitedWindows: ["weekly"],
      }),
    ).toBe("rate-limited")
    expect(mapUsageResultToSafeReason({ kind: "unauthorized" })).toBe("unauthorized")
    expect(mapUsageResultToSafeReason({ kind: "no-entitlement" })).toBe("no-entitlement")
    expect(mapUsageResultToSafeReason({ kind: "probe-failed", reason: "network" })).toBe(
      "probe-failed",
    )
  })

  test("serializes every surface without leaking provider text or key material", () => {
    const error = aggregateUnavailableKeys([
      { key: fixtures[0], result: { kind: "limited", retryAt: "2030-01-03T00:00:00.000Z" } },
      { key: fixtures[1], result: { kind: "unauthorized", cause: new Error(body) } },
      { key: fixtures[2], result: { kind: "probe-failed", cause: new Error(body) } },
    ])
    const surfaces: unknown[] = [
      error,
      error.name,
      error.message,
      error.stack,
      error.cause,
      error.toJSON(),
      JSON.stringify(error),
      String(error),
    ]
    const serialized = JSON.stringify(surfaces)
    expect(serialized).toContain("key[1]")
    expect(serialized).toContain("key[2]")
    expect(serialized).toContain("key[3]")
    expect(serialized).toContain("rate-limited")
    expect(serialized).toContain("unauthorized")
    expect(serialized).toContain("probe-failed")
    expect(serialized).toContain("2030-01-03T00:00:00.000Z")
    for (const secret of [...fixtures, "provider-body", "Authorization", "hash-abcdef0123456789"])
      expect(serialized).not.toContain(secret)
  })

  test("preserves configured order and reports earliest known retry", () => {
    const error = aggregateUnavailableKeys([
      { key: fixtures[2], result: { kind: "probe-failed" } },
      { key: fixtures[0], result: { kind: "limited", resetAt: "2030-01-04T00:00:00.000Z" } },
      { key: fixtures[1], result: { kind: "limited", resetAt: "2030-01-02T00:00:00.000Z" } },
    ])
    expect(error.entries.map((entry) => entry.keyLabel)).toEqual(["key[1]", "key[2]", "key[3]"])
    expect(error.retryAt).toBe("2030-01-02T00:00:00.000Z")
  })

  test("keeps console diagnostics safe", () => {
    const error = aggregateUnavailableKeys([
      { key: fixtures[0], result: { kind: "probe-failed", cause: new Error(body) } },
      { key: fixtures[1], result: { kind: "no-stale-snapshot" } },
    ])
    const stdout: string[] = []
    const stderr: string[] = []
    const originalLog = console.log
    const originalError = console.error
    console.log = (...args: readonly unknown[]) => stdout.push(args.map(String).join(" "))
    console.error = (...args: readonly unknown[]) => stderr.push(args.map(String).join(" "))
    try {
      console.log(JSON.stringify(error))
      console.error(error)
    } finally {
      console.log = originalLog
      console.error = originalError
    }
    const transcript = `${stdout.join("\n")}\n${stderr.join("\n")}`
    expect(transcript).toContain("key[1]")
    expect(transcript).toContain("no-stale-snapshot")
    for (const secret of [...fixtures, "provider-body", "Authorization", "hash-abcdef0123456789"])
      expect(transcript).not.toContain(secret)
  })
})
