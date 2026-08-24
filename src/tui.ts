import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { decodeModalCommand, decodeModalPayload, MODAL_COMMAND_NAME } from "./modal.js"

const showModal = (api: Parameters<TuiPlugin>[0], payload: unknown): boolean => {
  const modal = decodeModalPayload(payload)
  if (modal === undefined) return false
  api.ui.dialog.replace(() =>
    api.ui.DialogAlert({
      title: modal.title,
      message: modal.message,
      onConfirm: () => api.ui.dialog.clear(),
    }),
  )
  return true
}

export const tui: TuiPlugin = async (api) => {
  const unregisterCommand = api.keymap.registerLayer({
    commands: [
      {
        name: MODAL_COMMAND_NAME,
        run: (context: { readonly payload: unknown }) => showModal(api, context.payload),
      },
    ],
  })
  const unsubscribeEvent = api.event.on("tui.command.execute", (event) => {
    const payload = decodeModalCommand(event.properties.command)
    if (payload === undefined) return
    api.keymap.dispatchCommand(MODAL_COMMAND_NAME, { payload })
  })
  api.lifecycle.onDispose(() => {
    unsubscribeEvent()
    unregisterCommand()
  })
}

const module = { id: "opencode-go-multi", tui } satisfies TuiPluginModule

export default module
