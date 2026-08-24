import type { Part } from "@opencode-ai/sdk"
import type { KeySelectionInput, KeySelector } from "./selector.js"
import { parseFiniteTimestamp } from "./time.js"
import type { ProbeFailureReason, UsageProbeInput, UsageProbeResult, UsageWindow } from "./usage.js"

export const COMMAND_DEFINITIONS = {
  "ogm-usage": {
    template: "Show OpenCode Go quota usage for every configured key.",
    description: "Show safe OpenCode Go usage for all configured keys",
  },
  "ogm-switch": {
    template: "Advance the OpenCode Go key priority cursor.",
    description: "Advance the manual OpenCode Go key priority",
  },
} as const

export const OPENCODE_GO_PROVIDER_ID = "opencode-go"

const WINDOW_NAMES = ["rolling", "weekly", "monthly"] as const
let partSequence = 0

type WindowsResult = Extract<UsageProbeResult, { readonly kind: "eligible" | "limited" }>

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null

const isUsageWindow = (value: unknown): value is UsageWindow => {
  if (!isRecord(value)) return false
  const status = value["status"]
  const percent = value["percent"]
  const resetsAt = value["resetsAt"]
  const resetsAtMs = value["resetsAtMs"]
  return (
    (status === "ok" || status === "rate-limited") &&
    typeof percent === "number" &&
    Number.isFinite(percent) &&
    typeof resetsAt === "string" &&
    parseFiniteTimestamp(resetsAt) !== undefined &&
    new Date(parseFiniteTimestamp(resetsAt) ?? 0).toISOString() === resetsAt &&
    typeof resetsAtMs === "number" &&
    Number.isFinite(resetsAtMs)
  )
}

const isProbeFailureReason = (value: unknown): value is ProbeFailureReason => {
  switch (value) {
    case "timeout":
    case "network":
    case "http-status":
    case "invalid-json":
    case "invalid-schema":
    case "invalid-url":
      return true
    default:
      return false
  }
}

const isWindowsResult = (
  value: Readonly<Record<string, unknown>>,
): value is Readonly<Record<string, unknown>> & WindowsResult => {
  const windows = value["windows"]
  if (!isRecord(windows)) return false
  return WINDOW_NAMES.every((name) => isUsageWindow(windows[name]))
}

const displayPercent = (value: number): number => Math.min(100, Math.max(0, value))

const usageWindowLines = (name: string, window: UsageWindow): readonly string[] => {
  const used = displayPercent(window.percent)
  const remaining = 100 - used
  return [
    `  ${name.padEnd(8)} ${remaining}% remaining | ${used}% used | ${window.status}`,
    `    reset   ${window.resetsAt}`,
  ]
}

const safeResultLines = (result: unknown): readonly string[] => {
  if (!isRecord(result)) return ["  status: probe-failed (invalid-schema)"]
  switch (result["kind"]) {
    case "eligible":
    case "limited":
      if (!isWindowsResult(result)) return ["  status: probe-failed (invalid-schema)"]
      return WINDOW_NAMES.flatMap((name) => usageWindowLines(name, result.windows[name]))
    case "unauthorized":
      return ["  status: unauthorized"]
    case "no-entitlement":
      return ["  status: no-entitlement"]
    case "probe-failed":
      return isProbeFailureReason(result["reason"])
        ? [`  status: probe-failed (${result["reason"]})`]
        : ["  status: probe-failed (invalid-schema)"]
    default:
      return ["  status: probe-failed (unknown)"]
  }
}

export const formatUsageReport = (keys: readonly string[], results: readonly unknown[]): string => {
  const lines = ["OpenCode Go usage"]
  keys.forEach((_, index) => {
    const result = results[index]
    lines.push("", `key[${index + 1}]`)
    lines.push(...(result === undefined ? ["  status: not-probed"] : safeResultLines(result)))
  })
  return lines.join("\n")
}

export interface CommandRuntime {
  readonly keys: readonly string[]
  readonly selector: KeySelector
  readonly probe: (input: UsageProbeInput) => Promise<UsageProbeResult>
  readonly selectionInput: (sessionID: string) => KeySelectionInput | undefined
}

const providerModelApiUrl = (catalog: unknown): string | undefined => {
  if (!isRecord(catalog)) return undefined
  const providers = catalog["providers"]
  const defaults = catalog["default"]
  if (!Array.isArray(providers) || !isRecord(defaults)) return undefined
  const provider = providers.find(
    (candidate) => isRecord(candidate) && candidate["id"] === OPENCODE_GO_PROVIDER_ID,
  )
  if (!isRecord(provider)) return undefined
  const modelID = defaults[OPENCODE_GO_PROVIDER_ID]
  if (typeof modelID !== "string") return undefined
  const models = provider["models"]
  if (!isRecord(models) || !isRecord(models[modelID])) return undefined
  const api = models[modelID]["api"]
  return isRecord(api) && typeof api["url"] === "string" ? api["url"] : undefined
}

export const resolveUsageSelection = (catalog: unknown): KeySelectionInput | undefined => {
  if (!isRecord(catalog)) return undefined
  const providers = catalog["providers"]
  if (!Array.isArray(providers)) return undefined
  const provider = providers.find(
    (candidate) => isRecord(candidate) && candidate["id"] === OPENCODE_GO_PROVIDER_ID,
  )
  if (!isRecord(provider)) return undefined
  const options = provider["options"]
  const configuredBaseURL =
    isRecord(options) && typeof options["baseURL"] === "string" ? options["baseURL"] : undefined
  const apiURL = providerModelApiUrl(catalog)
  if (configuredBaseURL === undefined && apiURL === undefined) return undefined
  return {
    provider:
      configuredBaseURL === undefined
        ? { options: {} }
        : { options: { baseURL: configuredBaseURL } },
    model: { api: { url: apiURL ?? configuredBaseURL ?? "" } },
  }
}

const usageInput = (runtime: CommandRuntime, sessionID: string): UsageProbeInput | undefined => {
  const input = runtime.selectionInput(sessionID)
  return input === undefined ? undefined : { key: "", provider: input.provider, model: input.model }
}

export const executeCommand = async (
  command: string,
  runtime: CommandRuntime,
  sessionID = "",
): Promise<string | undefined> => {
  const normalized = command.trim().replace(/^\//u, "")
  if (normalized === "ogm-switch") {
    const index = runtime.selector.switchPriority()
    return `OpenCode Go priority advanced to key[${index + 1}]`
  }
  if (normalized !== "ogm-usage") return undefined

  const base = usageInput(runtime, sessionID)
  if (base === undefined) {
    return formatUsageReport(
      runtime.keys,
      runtime.keys.map(() => ({ kind: "probe-failed", reason: "invalid-url" })),
    )
  }
  const results = await Promise.all(runtime.keys.map((key) => runtime.probe({ ...base, key })))
  return formatUsageReport(runtime.keys, results)
}

export const appendCommandPart = (parts: Part[], sessionID: string, text: string): void => {
  const id = `opencode-go-multi-part-${partSequence}`
  partSequence += 1
  parts.push({
    id,
    sessionID,
    messageID: "",
    type: "text",
    text,
    synthetic: true,
  })
}
