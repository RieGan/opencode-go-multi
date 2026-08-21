import type { UsageProbeResult } from "./usage"

export const ALL_KEYS_UNAVAILABLE_CODE = "OPENCODE_GO_ALL_KEYS_UNAVAILABLE" as const

export type SafeUnavailableReason =
  | "rate-limited"
  | "unauthorized"
  | "no-entitlement"
  | "probe-failed"
  | "no-stale-snapshot"

export interface KeyUnavailableResult {
  readonly kind: SafeUnavailableReason | UsageProbeResult["kind"]
  readonly reason?: string
  readonly resetAt?: string
  readonly retryAt?: string
  readonly cause?: unknown
}

export interface KeyUnavailableInput {
  readonly key: string
  readonly result: KeyUnavailableResult
}

export interface SafeUnavailableEntry {
  readonly keyLabel: string
  readonly reason: SafeUnavailableReason
  readonly resetAt?: string
}

const SAFE_REASONS: readonly SafeUnavailableReason[] = [
  "rate-limited",
  "unauthorized",
  "no-entitlement",
  "probe-failed",
  "no-stale-snapshot",
]

const isSafeReason = (value: string): value is SafeUnavailableReason =>
  SAFE_REASONS.some((reason) => reason === value)

export const mapUsageResultToSafeReason = (result: UsageProbeResult): SafeUnavailableReason => {
  switch (result.kind) {
    case "limited":
      return "rate-limited"
    case "unauthorized":
      return "unauthorized"
    case "no-entitlement":
      return "no-entitlement"
    case "eligible":
      return "no-stale-snapshot"
    case "probe-failed":
      return "probe-failed"
    default:
      return "probe-failed"
  }
}

const safeTimestamp = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? value : undefined
}

const safeReason = (result: KeyUnavailableResult): SafeUnavailableReason => {
  if (isSafeReason(result.kind)) return result.kind
  if (result.kind === "limited") return "rate-limited"
  return "probe-failed"
}

export class AllKeysUnavailableError extends Error {
  readonly code = ALL_KEYS_UNAVAILABLE_CODE
  readonly name = "AllKeysUnavailableError"
  readonly entries: readonly SafeUnavailableEntry[]
  readonly retryAt: string | undefined

  public constructor(entries: readonly SafeUnavailableEntry[], retryAt: string | undefined) {
    const detail = entries.map((entry) => `${entry.keyLabel}:${entry.reason}`).join(", ")
    super(
      `All configured keys unavailable (${detail})${retryAt === undefined ? "" : `; retry-at=${retryAt}`}`,
    )
    this.entries = entries
    this.retryAt = retryAt
    Object.setPrototypeOf(this, new.target.prototype)
  }

  public toJSON(): Readonly<Record<string, unknown>> {
    return {
      name: this.name,
      code: this.code,
      entries: this.entries,
      ...(this.retryAt === undefined ? {} : { retryAt: this.retryAt }),
    }
  }
}

export const aggregateUnavailableKeys = (
  inputs: readonly KeyUnavailableInput[],
): AllKeysUnavailableError => {
  const entries = inputs.map((input, index): SafeUnavailableEntry => {
    const resetAt = safeTimestamp(input.result.resetAt ?? input.result.retryAt)
    return {
      keyLabel: `key[${index + 1}]`,
      reason: safeReason(input.result),
      ...(resetAt === undefined ? {} : { resetAt }),
    }
  })
  const timestamps = entries.flatMap((entry) =>
    entry.resetAt === undefined ? [] : [entry.resetAt],
  )
  const retryAt =
    timestamps.length === 0
      ? undefined
      : timestamps.reduce((earliest, timestamp) => (timestamp < earliest ? timestamp : earliest))
  return new AllKeysUnavailableError(entries, retryAt)
}
