import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseConfig } from "../src/config.ts"

const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8")
const packageManifest = readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")

const jsonExamples = (): unknown[] => {
  const examples: unknown[] = []
  for (const match of readme.matchAll(/```json\n([\s\S]*?)\n```/gu)) {
    examples.push(JSON.parse(match[1] ?? ""))
  }
  return examples
}

describe("README documentation contract", () => {
  test("publishes the supported OpenCode 1.x engine range", () => {
    expect(packageManifest).toContain('"opencode": ">=1.18.23 <2.0.0"')
    expect(packageManifest).toContain('"@opencode-ai/plugin": ">=1.18.23 <2.0.0"')
    expect(packageManifest).toContain('"homepage": "https://github.com/RieGan/opencode-go-multi"')
  })

  test("documents the supported V1 installation and safety contract", () => {
    for (const phrase of [
      "OpenCode **>=1.18.23 <2.0.0**",
      "@opencode-ai/plugin",
      "V1 plugin API",
      "OpenCode V2 TUI plugin API",
      "OPENCODE_GO_API_KEYS",
      "options.keys",
      "replaces environment keys",
      "this plugin last",
      "30 seconds",
      "five minutes",
      "rolling, weekly, and monthly",
      "same OpenCode Go subscription",
      "do not extend capacity",
      "source-backed but undocumented",
      "partial-stream",
      "OPENCODE_GO_ALL_KEYS_UNAVAILABLE",
    ]) {
      expect(readme).toContain(phrase)
    }
  })

  test("contains copyable environment and V1 tuple JSON examples", () => {
    const examples = jsonExamples().filter(
      (value): value is { plugin: unknown[] } =>
        typeof value === "object" && value !== null && Array.isArray(Reflect.get(value, "plugin")),
    )

    const environmentEntry = examples.find((value) => typeof value.plugin[0] === "string")
      ?.plugin[0]
    expect(environmentEntry).toBe("opencode-go-multi@latest")

    const tupleEntry = examples.find((value) => Array.isArray(value.plugin[0]))?.plugin[0]
    expect(Array.isArray(tupleEntry)).toBe(true)
    expect(tupleEntry).toHaveLength(2)
    expect(tupleEntry?.[0]).toBe("opencode-go-multi@latest")
    expect(tupleEntry?.[1]).toEqual({ keys: ["<GO_API_KEY_1>", "<GO_API_KEY_2>"] })

    expect(
      parseConfig({}, { OPENCODE_GO_API_KEYS: "<GO_API_KEY_1>, <GO_API_KEY_2>" }).keys,
    ).toEqual(["<GO_API_KEY_1>", "<GO_API_KEY_2>"])
    expect(
      parseConfig(tupleEntry?.[1], { OPENCODE_GO_API_KEYS: "<ENVIRONMENT_KEY>" }).keys,
    ).toEqual(["<GO_API_KEY_1>", "<GO_API_KEY_2>"])
  })
})
