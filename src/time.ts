export const parseFiniteTimestamp = (value: string): number | undefined => {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : undefined
}
