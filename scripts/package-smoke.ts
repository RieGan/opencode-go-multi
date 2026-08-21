import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

type PackEntry = { readonly path: string }

const run = async (
  cmd: string[],
  cwd: string,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> => {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

const root = resolve(import.meta.dir, "..")
const temp = await mkdtemp(join(tmpdir(), "opencode-go-pack-"))
try {
  const packed = await run(["npm", "pack", "--json"], root)
  if (packed.code !== 0) throw new Error(`npm pack failed: ${packed.stderr}`)
  const metadata = JSON.parse(packed.stdout) as readonly [
    { readonly filename: string; readonly files: readonly PackEntry[] },
  ]
  const record = metadata[0]
  if (record === undefined) throw new Error("npm pack returned no metadata")
  const allowed = new Set(["LICENSE", "README.md", "package.json"])
  for (const file of record.files) {
    if (!file.path.startsWith("dist/") && !allowed.has(file.path))
      throw new Error(`forbidden packed file: ${file.path}`)
  }
  const tarball = join(root, record.filename)
  const consumer = join(temp, "consumer")
  await Bun.$`mkdir -p ${consumer}`
  const init = await run(["npm", "init", "-y"], consumer)
  if (init.code !== 0) throw new Error(`npm init failed: ${init.stderr}`)
  const install = await run(["npm", "install", "--offline", "--ignore-scripts", tarball], consumer)
  if (install.code !== 0) throw new Error(`npm install failed: ${install.stderr}`)
  const probe = join(consumer, "probe.mjs")
  await writeFile(
    probe,
    "const a = await import('opencode-go-multi'); const b = await import('opencode-go-multi/server'); if (Object.keys(a).join(',') !== 'default' || Object.keys(b).join(',') !== 'default' || a.default.id !== 'opencode-go-multi' || typeof a.default.server !== 'function' || a.default !== b.default) process.exit(2);\n",
  )
  const imported = await run(["bun", probe], consumer)
  if (imported.code !== 0)
    throw new Error(`consumer import failed: ${imported.stderr || imported.stdout}`)
  console.log(
    JSON.stringify({
      tarball: record.filename,
      files: record.files.map((entry) => entry.path),
      consumerImport: "ok",
    }),
  )
  await rm(tarball, { force: true })
} finally {
  await rm(temp, { recursive: true, force: true })
}
