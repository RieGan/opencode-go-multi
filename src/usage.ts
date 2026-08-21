import { z } from "zod"
import { parseFiniteTimestamp } from "./time.js"

interface UsageUrl {
  pathname: string
  search: string
  hash: string
  toString: () => string
}

interface UsageAbortSignal {
  readonly aborted: boolean
}

interface UsageAbortController {
  readonly signal: UsageAbortSignal
  abort: () => void
}

interface UsageRequestInit {
  readonly method?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly signal?: UsageAbortSignal
}

interface UsageResponse {
  readonly status: number
  readonly ok: boolean
  json: () => Promise<unknown>
}

declare const URL: new (input: string) => UsageUrl
declare const AbortController: new () => UsageAbortController
declare const fetch: FetchLike
declare const setTimeout: (callback: () => void, delay: number) => number
declare const clearTimeout: (timer: number) => void
declare class DOMException extends Error {
  readonly name: string
}

const INFERENCE_SUFFIXES = ["/chat/completions", "/responses", "/messages"] as const
const DEFAULT_TIMEOUT_MS = 3_000

export type UsageWindowName = "rolling" | "weekly" | "monthly"
export type UsageWindowStatus = "ok" | "rate-limited"

export interface UsageWindow {
  readonly status: UsageWindowStatus
  readonly percent: number
  readonly resetsAt: string
  readonly resetsAtMs: number
}

export type UsageWindows = Readonly<Record<UsageWindowName, UsageWindow>>

export interface UsageProbeInput {
  readonly key: string
  readonly provider: {
    readonly options?: {
      readonly baseURL?: string
    }
  }
  readonly model: {
    readonly api: {
      readonly url: string
    }
  }
}

export interface UsageSnapshot {
  readonly usage: UsageWindows
  readonly windows: UsageWindows
}

export interface EligibleUsageSnapshot extends UsageSnapshot {
  readonly kind: "eligible"
}

export interface LimitedUsageSnapshot extends UsageSnapshot {
  readonly kind: "limited"
  readonly limitedWindows: readonly UsageWindowName[]
}

export interface UnauthorizedUsageResult {
  readonly kind: "unauthorized"
}

export interface NoEntitlementUsageResult {
  readonly kind: "no-entitlement"
}

export type ProbeFailureReason =
  | "timeout"
  | "network"
  | "http-status"
  | "invalid-json"
  | "invalid-schema"
  | "invalid-url"

export interface ProbeFailedUsageResult {
  readonly kind: "probe-failed"
  readonly reason: ProbeFailureReason
  readonly status?: number
}

export type UsageProbeResult =
  | EligibleUsageSnapshot
  | LimitedUsageSnapshot
  | UnauthorizedUsageResult
  | NoEntitlementUsageResult
  | ProbeFailedUsageResult

export type FetchLike = (
  input: string | UsageUrl,
  init?: UsageRequestInit,
) => Promise<UsageResponse>

export interface UsageClientOptions {
  readonly fetch?: FetchLike
  readonly timeoutMs?: number
}

const usageWindowSchema = z
  .object({
    status: z.enum(["ok", "rate-limited"]),
    percent: z.number().nonnegative(),
    resetsAt: z.string().refine((value) => parseFiniteTimestamp(value) !== undefined),
  })
  .loose()

const usageSchema = z
  .object({
    rolling: usageWindowSchema,
    weekly: usageWindowSchema,
    monthly: usageWindowSchema,
  })
  .loose()

const responseSchema = z.object({ usage: usageSchema }).loose()

const normalizedPath = (pathname: string): string => {
  let path = pathname.replace(/\/+$/, "")
  for (const suffix of INFERENCE_SUFFIXES) {
    if (path.endsWith(suffix)) {
      path = path.slice(0, -suffix.length)
      break
    }
  }
  return `${path}/usage`
}

export const deriveUsageUrl = (baseURL: string): string => {
  const parsed = new URL(baseURL.trim())
  parsed.pathname = normalizedPath(parsed.pathname)
  parsed.search = ""
  parsed.hash = ""
  return parsed.toString()
}

const baseForInput = (input: UsageProbeInput): string => {
  const configured = input.provider.options?.baseURL?.trim()
  return configured === undefined || configured.length === 0 ? input.model.api.url : configured
}

const toUsageWindow = (window: z.infer<typeof usageWindowSchema>): UsageWindow | undefined => {
  const resetsAtMs = parseFiniteTimestamp(window.resetsAt)
  return resetsAtMs === undefined ? undefined : { ...window, resetsAtMs }
}

const parseSnapshot = (value: unknown): UsageProbeResult => {
  const parsed = responseSchema.safeParse(value)
  if (!parsed.success) return { kind: "probe-failed", reason: "invalid-schema" }

  const names: readonly UsageWindowName[] = ["rolling", "weekly", "monthly"]
  const rolling = toUsageWindow(parsed.data.usage.rolling)
  const weekly = toUsageWindow(parsed.data.usage.weekly)
  const monthly = toUsageWindow(parsed.data.usage.monthly)
  if (rolling === undefined || weekly === undefined || monthly === undefined) {
    return { kind: "probe-failed", reason: "invalid-schema" }
  }
  const usage: UsageWindows = { rolling, weekly, monthly }
  const limitedWindows = names.filter((name) => usage[name].status === "rate-limited")
  return limitedWindows.length === 0
    ? { kind: "eligible", usage, windows: usage }
    : { kind: "limited", usage, windows: usage, limitedWindows }
}

export interface UsageClient {
  readonly probe: (input: UsageProbeInput) => Promise<UsageProbeResult>
}

export const createUsageClient = (options: UsageClientOptions = {}): UsageClient => {
  const request = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const probe = async (input: UsageProbeInput): Promise<UsageProbeResult> => {
    let url: string
    try {
      url = deriveUsageUrl(baseForInput(input))
    } catch {
      return { kind: "probe-failed", reason: "invalid-url" }
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await request(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${input.key}` },
        signal: controller.signal,
      })
      if (response.status === 401) return { kind: "unauthorized" }
      if (response.status === 403) return { kind: "no-entitlement" }
      if (!response.ok)
        return { kind: "probe-failed", reason: "http-status", status: response.status }
      let body: unknown
      try {
        body = await response.json()
      } catch {
        return { kind: "probe-failed", reason: "invalid-json" }
      }
      try {
        return parseSnapshot(body)
      } catch {
        return { kind: "probe-failed", reason: "invalid-schema" }
      }
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return { kind: "probe-failed", reason: "timeout" }
      }
      return { kind: "probe-failed", reason: "network" }
    } finally {
      clearTimeout(timeout)
      controller.abort()
    }
  }

  return { probe }
}

export const probeUsage = (
  input: UsageProbeInput,
  options?: UsageClientOptions,
): Promise<UsageProbeResult> => createUsageClient(options).probe(input)
