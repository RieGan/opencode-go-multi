import type { PluginModule } from "@opencode-ai/plugin"
import { server } from "./plugin.js"

const plugin = {
  id: "opencode-go-multi",
  server,
} satisfies PluginModule

export default plugin
