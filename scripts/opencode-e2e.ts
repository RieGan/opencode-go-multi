import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

type Scenario = "failover-success" | "all-limited"
type SafeRequest = { readonly path: string; readonly key: "key1" | "key2" | "none" }

const scenarioArg = process.argv.slice(2)
const scenario: Scenario = scenarioArg.includes("all-limited") ? "all-limited" : "failover-success"
const root = resolve(import.meta.dir, "..")
const temp = await mkdtemp(join(tmpdir(), "opencode-go-e2e-"))
const keys = { key1: "fixture-key-one", key2: "fixture-key-two" } as const
const requests: SafeRequest[] = []
const mock = Bun.serve({
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url)
    const auth = request.headers.get("authorization") ?? ""
    const key: SafeRequest["key"] = auth.includes(keys.key1)
      ? "key1"
      : auth.includes(keys.key2)
        ? "key2"
        : "none"
    requests.push({ path: url.pathname, key })
    if (url.pathname.endsWith("/usage")) {
      const limited = scenario === "all-limited" || key === "key1"
      const window = {
        status: limited ? "rate-limited" : "ok",
        percent: limited ? 100 : 1,
        resetsAt: "2099-01-01T00:00:00.000Z",
      }
      return Response.json({ usage: { rolling: window, weekly: window, monthly: window } })
    }
    if (url.pathname.endsWith("/chat/completions")) {
      const body =
        'data: {"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}\n\n' +
        'data: {"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n' +
        "data: [DONE]\n\n"
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    }
    return new Response("not found", { status: 404 })
  },
})

const run = async (
  cmd: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> => {
  const proc = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timeout = setTimeout(() => proc.kill(), 10_000)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timeout)
  return { code, stdout, stderr }
}

try {
  const packed = await run(["npm", "pack", "--json"], root, {})
  if (packed.code !== 0) throw new Error(`pack failed: ${packed.stderr}`)
  const metadata = JSON.parse(packed.stdout) as readonly [{ readonly filename: string }]
  const tarball = join(root, metadata[0]?.filename ?? "")
  const consumer = join(temp, "consumer")
  await Bun.$`mkdir -p ${consumer}`
  const init = await run(["npm", "init", "-y"], consumer, {})
  if (init.code !== 0) throw new Error(`init failed: ${init.stderr}`)
  const install = await run(
    ["npm", "install", "--offline", "--ignore-scripts", tarball],
    consumer,
    {},
  )
  if (install.code !== 0) throw new Error(`install failed: ${install.stderr}`)
  const pluginPath = join(consumer, "node_modules", "opencode-go-multi")
  const configDir = join(temp, "config")
  const cacheDir = join(temp, "cache")
  const dataDir = join(temp, "data")
  const stateDir = join(temp, "state")
  const projectDir = join(temp, "project")
  await Bun.$`mkdir -p ${configDir} ${cacheDir} ${dataDir} ${stateDir} ${projectDir}`
  const config = {
    plugin: [pluginPath],
    provider: {
      "opencode-go": {
        options: { baseURL: `http://127.0.0.1:${mock.port}/zen/go/v1` },
        models: {
          "glm-5.2": {
            id: "glm-5.2",
            name: "GLM-5.2",
            attachment: false,
            reasoning: false,
            tool_call: false,
            temperature: true,
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: 131072, output: 8192 },
          },
        },
      },
    },
  }
  await writeFile(join(projectDir, "opencode.json"), JSON.stringify(config))
  const child = await run(
    [
      "opencode",
      "run",
      "--dir",
      projectDir,
      "--print-logs",
      "--log-level",
      "DEBUG",
      "--format",
      "json",
      "--model",
      "opencode-go/glm-5.2",
      "--title",
      "fixture",
      "reply exactly OK",
    ],
    projectDir,
    {
      OPENCODE_GO_API_KEYS: `${keys.key1},${keys.key2}`,
      XDG_CONFIG_HOME: configDir,
      XDG_CACHE_HOME: cacheDir,
      XDG_DATA_HOME: dataDir,
      XDG_STATE_HOME: stateDir,
    },
  )
  const combined = `${child.stdout}\n${child.stderr}`
  if (
    combined.includes(keys.key1) ||
    combined.includes(keys.key2) ||
    /Bearer\s+[A-Za-z0-9_-]+/u.test(combined)
  )
    throw new Error("raw credential leaked")
  const inference = requests.filter((request) => request.path.endsWith("/chat/completions"))
  const usage = requests.filter((request) => request.path.endsWith("/usage"))
  const aggregateCode = "OPENCODE_GO_ALL_KEYS_UNAVAILABLE"
  let observedAggregateCode: string | undefined
  let serializedAggregate: string | undefined
  if (scenario === "failover-success") {
    if (child.code !== 0 || !child.stdout.includes("OK"))
      throw new Error(`expected OK, got code=${child.code}: ${combined}`)
    if (inference.length !== 1 || inference[0]?.key !== "key2")
      throw new Error(`unexpected inference requests: ${JSON.stringify(inference)}`)
    if (
      !usage.some((request) => request.key === "key1") ||
      !usage.some((request) => request.key === "key2")
    )
      throw new Error("missing ordered usage probes")
  } else {
    const installed = (await import(join(pluginPath, "dist/index.js"))).default as {
      readonly server: (
        input: unknown,
        options?: unknown,
      ) => Promise<{
        readonly [name: string]:
          | ((input: unknown, output: { headers: Record<string, string> }) => Promise<void>)
          | undefined
      }>
    }
    const hooks = await installed.server({} as never, { keys: [keys.key1, keys.key2] })
    const directInput = {
      model: {
        providerID: "opencode-go",
        modelID: "glm-5.2",
        api: { url: `http://127.0.0.1:${mock.port}/zen/go/v1/chat/completions` },
      },
      provider: {
        source: "config",
        info: {},
        options: { baseURL: `http://127.0.0.1:${mock.port}/zen/go/v1` },
      },
      sessionID: "fixture",
      agent: "fixture",
      message: {},
    }
    try {
      await hooks["chat.headers"]?.(directInput, { headers: {} })
    } catch (error) {
      const record = error as { readonly code?: unknown; readonly toJSON?: () => unknown }
      observedAggregateCode = typeof record.code === "string" ? record.code : undefined
      serializedAggregate = JSON.stringify(
        typeof record.toJSON === "function" ? record.toJSON() : { code: observedAggregateCode },
      )
    }
    if (
      child.code === 0 ||
      inference.length !== 0 ||
      observedAggregateCode !== aggregateCode ||
      serializedAggregate === undefined ||
      serializedAggregate.includes(keys.key1) ||
      serializedAggregate.includes(keys.key2)
    )
      throw new Error(
        `all-limited assertions failed: code=${child.code}, inference=${inference.length}, output=${combined}`,
      )
  }
  console.log(
    JSON.stringify({
      scenario,
      opencodeVersion: "1.18.23",
      exitCode: child.code,
      stdout: child.stdout.replaceAll(keys.key1, "[REDACTED]").replaceAll(keys.key2, "[REDACTED]"),
      stderr: child.stderr.replaceAll(keys.key1, "[REDACTED]").replaceAll(keys.key2, "[REDACTED]"),
      requests: {
        usage: usage.length,
        inference: inference.length,
        inferenceKeys: inference.map((request) => request.key),
      },
      ...(scenario === "all-limited" ? { aggregateCode, observedAggregateCode } : {}),
      ...(serializedAggregate === undefined
        ? {}
        : { serializedAggregate: JSON.parse(serializedAggregate) }),
      isolatedXdg: true,
      cleanup: "complete",
    }),
  )
  await rm(tarball, { force: true })
} finally {
  mock.stop(true)
  await rm(temp, { recursive: true, force: true })
}
