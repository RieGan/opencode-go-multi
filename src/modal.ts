export const MODAL_COMMAND_NAME = "opencode-go-multi.modal"

const MAX_COMMAND_LENGTH = 12_000
const MAX_PAYLOAD_TEXT_LENGTH = 8_000
const COMMAND_PREFIX = `${MODAL_COMMAND_NAME}:`

export interface ModalPayload {
  readonly title: string
  readonly message: string
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null

export const encodeModalCommand = (payload: ModalPayload): string =>
  `${COMMAND_PREFIX}${encodeURIComponent(JSON.stringify(payload))}`

export const decodeModalPayload = (value: unknown): ModalPayload | undefined => {
  if (isRecord(value)) {
    const title = value["title"]
    const message = value["message"]
    return typeof title === "string" &&
      typeof message === "string" &&
      title.length <= MAX_PAYLOAD_TEXT_LENGTH &&
      message.length <= MAX_PAYLOAD_TEXT_LENGTH &&
      title.length + message.length <= MAX_COMMAND_LENGTH
      ? { title, message }
      : undefined
  }
  if (typeof value !== "string" || value.length > MAX_COMMAND_LENGTH) return undefined
  const encoded = value.startsWith(COMMAND_PREFIX) ? value.slice(COMMAND_PREFIX.length) : value
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(encoded))
    if (
      !isRecord(parsed) ||
      typeof parsed["title"] !== "string" ||
      typeof parsed["message"] !== "string" ||
      parsed["title"].length > MAX_PAYLOAD_TEXT_LENGTH ||
      parsed["message"].length > MAX_PAYLOAD_TEXT_LENGTH ||
      parsed["title"].length + parsed["message"].length > MAX_COMMAND_LENGTH
    ) {
      return undefined
    }
    return { title: parsed["title"], message: parsed["message"] }
  } catch {
    return undefined
  }
}

export const decodeModalCommand = (value: unknown): ModalPayload | undefined =>
  typeof value === "string" && value.startsWith(COMMAND_PREFIX)
    ? decodeModalPayload(value)
    : undefined
