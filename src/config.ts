export type Config = {
  readonly keys: readonly string[]
}

export type ConfigEnvironment = Readonly<{
  readonly OPENCODE_GO_API_KEYS?: string | undefined
  readonly [name: string]: string | undefined
}>

export type ConfigErrorReason = "invalid-keys" | "missing-keys"

declare const process: { readonly env: ConfigEnvironment }

export class ConfigError extends Error {
  readonly name = "ConfigError"
  readonly code = "OPENCODE_GO_CONFIG_INVALID"

  constructor(
    readonly reason: ConfigErrorReason,
    detail: string,
  ) {
    super(`OpenCode Go key configuration error: ${detail}`)
  }
}

type KeysProperty = Readonly<{
  readonly present: boolean
  readonly value: unknown
}>

const getKeysProperty = (options: unknown): KeysProperty => {
  if (
    options === null ||
    (typeof options !== "object" && typeof options !== "function") ||
    !("keys" in options)
  ) {
    return { present: false, value: undefined }
  }

  const descriptor = Object.getOwnPropertyDescriptor(options, "keys")
  if (descriptor !== undefined) {
    return {
      present: true,
      value: "value" in descriptor ? descriptor.value : undefined,
    }
  }
  return { present: true, value: Reflect.get(options, "keys") }
}

const normalizeKeys = (values: readonly string[]): readonly string[] => {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const value of values) {
    const key = value.trim()
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    normalized.push(key)
  }
  return normalized
}

const isUnknownArray = (value: unknown): value is readonly unknown[] => Array.isArray(value)

const parseExplicitKeys = (value: unknown): readonly string[] => {
  if (!isUnknownArray(value)) {
    throw new ConfigError("invalid-keys", "options.keys must be a non-empty string array")
  }
  const values: string[] = []
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new ConfigError("invalid-keys", "options.keys must be a non-empty string array")
    }
    values.push(entry)
  }
  const keys = normalizeKeys(values)
  if (keys.length === 0) {
    throw new ConfigError("invalid-keys", "options.keys must contain at least one non-blank key")
  }
  return keys
}

const parseEnvironmentKeys = (value: string | undefined): readonly string[] => {
  const keys = normalizeKeys(value === undefined ? [] : value.split(/[\n,]/u))
  if (keys.length === 0) {
    throw new ConfigError("missing-keys", "OPENCODE_GO_API_KEYS must contain at least one key")
  }
  return keys
}

export const parseConfig = (
  options: unknown = {},
  environment: ConfigEnvironment = process.env,
): Config => {
  const property = getKeysProperty(options)
  const keys = !property.present
    ? parseEnvironmentKeys(environment.OPENCODE_GO_API_KEYS)
    : parseExplicitKeys(property.value)
  return { keys }
}
