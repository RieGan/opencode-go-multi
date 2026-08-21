export type MockUsage = {
  readonly status?: number
  readonly body?: unknown
}

export type MockGoServer = {
  readonly url: string
  readonly requests: readonly MockRequest[]
  readonly counts: Readonly<Record<string, number>>
  readonly close: () => Promise<void>
}

export type MockRequest = {
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
}

export const startMockGoServer = (
  usageByKey: Record<string, MockUsage | readonly MockUsage[]>,
): MockGoServer => {
  const requests: MockRequest[] = []
  const counts = new Map<string, number>()
  const queues = new Map<string, MockUsage[]>()
  for (const [key, value] of Object.entries(usageByKey))
    queues.set(key, Array.isArray(value) ? [...value] : [value])
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const safeHeaders: Record<string, string> = {}
      for (const [name, value] of request.headers)
        if (name.toLowerCase() !== "authorization") safeHeaders[name] = value
      const path = url.pathname
      requests.push({ method: request.method, path, headers: safeHeaders })
      const countKey = `${request.method} ${path}`
      counts.set(countKey, (counts.get(countKey) ?? 0) + 1)
      if (path === "/zen/go/v1/usage") {
        const auth = request.headers.get("authorization") ?? ""
        const key = auth.replace(/^Bearer\s+/u, "")
        const queue = queues.get(key)
        const next = queue !== undefined && queue.length > 1 ? queue.shift() : queue?.[0]
        const status = next?.status ?? 200
        return Response.json(next?.body ?? {}, { status })
      }
      if (path === "/zen/go/v1/chat/completions") return Response.json({ id: "mock", choices: [] })
      return new Response("not found", { status: 404 })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    get counts() {
      return Object.fromEntries(counts)
    },
    close: async () => server.stop(true),
  }
}
