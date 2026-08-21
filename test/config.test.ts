import { describe, expect, test } from "bun:test"
import { type ConfigEnvironment, ConfigError, parseConfig } from "../src/config.ts"

const env = (value: string | undefined, implicit = "implicit-secret"): ConfigEnvironment => ({
  OPENCODE_GO_API_KEYS: value,
  OPENCODE_API_KEY: implicit,
})

describe("parseConfig", () => {
  test("uses ordered explicit options and never supplements them from the environment", () => {
    const result = parseConfig(
      { keys: [" option-one ", "option-one", "option-two"] },
      env("environment-one,environment-two"),
    )

    expect(result.keys).toEqual(["option-one", "option-two"])
  })

  test("treats an inherited keys property as explicit configuration", () => {
    const options: unknown = Object.create({ keys: [" inherited-option "] })

    expect(parseConfig(options, env("environment-key")).keys).toEqual(["inherited-option"])
  })

  test("falls back to comma and newline separated environment keys", () => {
    const result = parseConfig({}, env(" env-one, env-two\nenv-one\n, env-three "))

    expect(result.keys).toEqual(["env-one", "env-two", "env-three"])
  })

  test("accepts one non-empty key", () => {
    expect(parseConfig({}, env(" single-key ")).keys).toEqual(["single-key"])
  })

  test("does not read the implicit OPENCODE_API_KEY variable", () => {
    expect(() => parseConfig({}, env(undefined, "implicit-only"))).toThrow(ConfigError)
    expect(() => parseConfig({}, env(undefined, "implicit-only"))).toThrow("OPENCODE_GO_API_KEYS")
  })

  test("fails when neither explicit nor environment keys remain", () => {
    expect(() => parseConfig({}, env(" ,\n "))).toThrow(ConfigError)
  })

  test("rejects a non-array explicit keys value without environment fallback", () => {
    const error = captureConfigError(() => parseConfig({ keys: "not-an-array" }, env("env-key")))

    expect(error.code).toBe("OPENCODE_GO_CONFIG_INVALID")
    expect(error.reason).toBe("invalid-keys")
    expect(error.message).toContain("options.keys")
    expect(error.message).not.toContain("env-key")
  })

  test("rejects explicit arrays containing non-string values", () => {
    expect(() => parseConfig({ keys: ["valid-key", 42] }, env("env-key"))).toThrow(ConfigError)
  })

  test("rejects explicit empty options even when the environment is valid", () => {
    const error = captureConfigError(() => parseConfig({ keys: [] }, env("valid-env-key")))

    expect(error.reason).toBe("invalid-keys")
    expect(error.message).not.toContain("valid-env-key")
  })

  test("removes blank explicit entries and still requires one key", () => {
    expect(
      parseConfig({ keys: [" ", "option-key", "\n", "option-key"] }, env("env-key")).keys,
    ).toEqual(["option-key"])
    expect(() => parseConfig({ keys: [" ", "\n"] }, env("env-key"))).toThrow(ConfigError)
  })
})

const captureConfigError = (action: () => unknown): ConfigError => {
  try {
    action()
  } catch (error) {
    if (error instanceof ConfigError) return error
    throw error
  }
  throw new Error("expected ConfigError")
}
