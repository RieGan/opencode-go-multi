import type { KeyUnavailableInput, KeyUnavailableResult } from "./errors.js"
import { deriveUsageUrl, type UsageProbeInput, type UsageProbeResult } from "./usage.js"

export interface SelectorClock {
  readonly now: () => number
}
export interface KeySelectorOptions {
  readonly keys: readonly string[]
  readonly probe: (input: UsageProbeInput) => Promise<UsageProbeResult>
  readonly clock?: SelectorClock
}
export interface KeySelectionInput {
  readonly provider: UsageProbeInput["provider"]
  readonly model: UsageProbeInput["model"]
}
export interface KeySelector {
  readonly select: (input: KeySelectionInput) => Promise<string | undefined>
  readonly unavailable: (input: KeySelectionInput) => readonly KeyUnavailableInput[]
  readonly switchPriority: () => number
  readonly reset: () => void
}

type RecordState = {
  readonly key: string
  readonly endpoint: string
  lastSuccess?: { readonly at: number; readonly result: UsageProbeResult }
  lastFailureAt?: number
  invalidatedAt?: number
  limitedUntil?: number
  lastResult?: UsageProbeResult
}

const SUCCESS_MAX_AGE = 30_000
const TRANSIENT_MAX_AGE = 300_000
const FAILURE_RETRY_AGE = 30_000
const RESET_SKEW = 1_000

const endpointFor = (input: KeySelectionInput): string => {
  const configured = input.provider.options?.baseURL?.trim()
  const base =
    configured === undefined || configured.length === 0 ? input.model.api.url : configured
  try {
    return deriveUsageUrl(base)
  } catch {
    return base.trim()
  }
}

const isFresh = (record: RecordState, now: number): boolean =>
  record.lastSuccess !== undefined && now - record.lastSuccess.at < SUCCESS_MAX_AGE

const limitedReset = (result: Extract<UsageProbeResult, { readonly kind: "limited" }>): number => {
  let latest = 0
  for (const name of result.limitedWindows) {
    const reset = result.windows[name].resetsAtMs
    if (reset > latest) latest = reset
  }
  return latest + RESET_SKEW
}

export const createKeySelector = (options: KeySelectorOptions): KeySelector => {
  const clock = options.clock ?? { now: () => Date.now() }
  const records = new Map<string, RecordState>()
  const flights = new Map<string, Promise<string | undefined>>()
  let priorityIndex = 0

  const selectSequential = async (
    input: KeySelectionInput,
    endpoint: string,
  ): Promise<string | undefined> => {
    const now = clock.now()
    for (let offset = 0; offset < options.keys.length; offset += 1) {
      const keyIndex = (priorityIndex + offset) % options.keys.length
      const key = options.keys[keyIndex]
      if (key === undefined) continue
      const id = `${endpoint}\u0000${key}`
      const record = records.get(id) ?? { key, endpoint }
      records.set(id, record)
      if (record.limitedUntil !== undefined && now < record.limitedUntil) continue
      if (isFresh(record, now) && record.invalidatedAt === undefined) return key
      if (record.lastFailureAt !== undefined && now - record.lastFailureAt < FAILURE_RETRY_AGE) {
        if (
          record.lastSuccess !== undefined &&
          record.lastSuccess.result.kind === "eligible" &&
          now - record.lastSuccess.at < TRANSIENT_MAX_AGE
        )
          return key
        continue
      }
      if (record.invalidatedAt !== undefined && now - record.invalidatedAt < FAILURE_RETRY_AGE)
        continue
      const result = await options.probe({ key, provider: input.provider, model: input.model })
      switch (result.kind) {
        case "eligible":
          record.lastResult = result
          record.lastSuccess = { at: clock.now(), result }
          delete record.lastFailureAt
          delete record.invalidatedAt
          delete record.limitedUntil
          return key
        case "limited":
          record.lastResult = result
          delete record.lastSuccess
          delete record.lastFailureAt
          delete record.invalidatedAt
          record.limitedUntil = limitedReset(result)
          continue
        case "unauthorized":
        case "no-entitlement":
          record.lastResult = result
          delete record.lastSuccess
          record.invalidatedAt = clock.now()
          delete record.lastFailureAt
          continue
        case "probe-failed":
          record.lastResult = result
          break
        default:
          record.lastResult = { kind: "probe-failed", reason: "invalid-schema" }
      }
      record.lastFailureAt = clock.now()
      if (record.lastSuccess !== undefined && now - record.lastSuccess.at < TRANSIENT_MAX_AGE)
        return key
    }
    return undefined
  }

  const select = (input: KeySelectionInput): Promise<string | undefined> => {
    const endpoint = endpointFor(input)
    const active = flights.get(endpoint)
    if (active !== undefined) return active
    const flight = selectSequential(input, endpoint)
    flights.set(endpoint, flight)
    const cleanup = (): void => {
      if (flights.get(endpoint) === flight) flights.delete(endpoint)
    }
    void flight.then(cleanup, cleanup)
    return flight
  }
  const reset = (): void => {
    records.clear()
    flights.clear()
  }
  const switchPriority = (): number => {
    priorityIndex = (priorityIndex + 1) % options.keys.length
    reset()
    return priorityIndex
  }
  const unavailable = (input: KeySelectionInput): readonly KeyUnavailableInput[] => {
    const endpoint = endpointFor(input)
    return options.keys.map((key): KeyUnavailableInput => {
      const record = records.get(`${endpoint}\u0000${key}`)
      if (record?.lastResult === undefined) {
        return { key, result: { kind: "no-stale-snapshot" } }
      }
      switch (record.lastResult.kind) {
        case "limited": {
          const result: KeyUnavailableResult = {
            kind: "limited",
            ...(record.limitedUntil === undefined
              ? {}
              : { resetAt: new Date(record.limitedUntil).toISOString() }),
          }
          return { key, result }
        }
        case "unauthorized":
        case "no-entitlement":
        case "probe-failed":
          return { key, result: record.lastResult }
        case "eligible":
          return { key, result: { kind: "no-stale-snapshot" } }
        default:
          return { key, result: { kind: "probe-failed" } }
      }
    })
  }
  return { select, unavailable, switchPriority, reset }
}

export const createSelector = createKeySelector
