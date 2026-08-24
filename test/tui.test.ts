import { describe, expect, test } from "bun:test"
import { encodeModalCommand } from "../src/modal"
import { tui } from "../src/tui"

describe("OpenCode Go TUI plugin", () => {
  test("opens and dismisses a modal for a published command event", async () => {
    let registered:
      | { readonly name: string; readonly run: (context: { readonly payload: unknown }) => unknown }
      | undefined
    let eventHandler:
      | ((event: {
          readonly type: "tui.command.execute"
          readonly properties: { readonly command: string }
        }) => void)
      | undefined
    let dialogRender: (() => unknown) | undefined
    let alertProps:
      | { readonly title: string; readonly message: string; readonly onConfirm?: () => void }
      | undefined
    let clearCount = 0
    let dispatchName: string | undefined
    let dispatchPayload: unknown

    const api = {
      keymap: {
        registerLayer: (layer: {
          readonly commands?: readonly Array<{
            readonly name: string
            readonly run: (context: { readonly payload: unknown }) => unknown
          }>
        }) => {
          registered = layer.commands?.[0]
          return () => undefined
        },
        dispatchCommand: (name: string, options: { readonly payload?: unknown }) => {
          dispatchName = name
          dispatchPayload = options.payload
          return registered?.run({ payload: options.payload })
        },
      },
      event: {
        on: (
          _type: "tui.command.execute",
          handler: typeof eventHandler extends infer T ? T : never,
        ) => {
          eventHandler = handler
          return () => undefined
        },
      },
      ui: {
        dialog: {
          replace: (render: () => unknown) => {
            dialogRender = render
          },
          clear: () => {
            clearCount += 1
          },
        },
        DialogAlert: (props: {
          readonly title: string
          readonly message: string
          readonly onConfirm?: () => void
        }) => {
          alertProps = props
          return props
        },
      },
      lifecycle: { onDispose: (_handler: () => void) => () => undefined },
    }

    await tui(api as never, undefined, undefined as never)
    eventHandler?.({
      type: "tui.command.execute",
      properties: { command: encodeModalCommand({ title: "Quota", message: "key[1]" }) },
    })

    expect(dispatchName).toBe("opencode-go-multi.modal")
    expect(dispatchPayload).toEqual({ title: "Quota", message: "key[1]" })
    expect(dialogRender).toBeDefined()
    dialogRender?.()
    expect(alertProps?.title).toBe("Quota")
    expect(alertProps?.message).toBe("key[1]")
    alertProps?.onConfirm?.()
    expect(clearCount).toBe(1)
  })
})
