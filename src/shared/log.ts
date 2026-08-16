export function log(message: string, data?: unknown): void {
  // console.error keeps the OpenCode TUI clean; stdout is reserved for tool output.
  const suffix = data === undefined ? "" : ` ${JSON.stringify(data)}`
  console.error(`[prism] ${message}${suffix}`)
}
