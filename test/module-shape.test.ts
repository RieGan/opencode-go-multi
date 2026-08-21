import { expect, test } from "bun:test"

test("Given the source entrypoint, when imported, then it exposes only the plugin module", async () => {
  // Given: the intended source entrypoint

  // When: the entrypoint is loaded through Bun's real ESM loader
  const module = await import("../src/index.ts")

  // Then: consumers receive the default V1 plugin module and no helper exports
  expect(Object.keys(module)).toEqual(["default"])
  const plugin = Reflect.get(module, "default")
  expect(Reflect.get(plugin, "id")).toBe("opencode-go-multi")
  expect(typeof Reflect.get(plugin, "server")).toBe("function")
})
