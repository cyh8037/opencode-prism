import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

// Prism logs go to a file, never to the console: the plugin runs inside the
// opencode server process, and console output (stderr) leaks into the TUI.
// The file lives next to opencode's own logs and follows the same XDG data
// convention; PRISM_LOG_FILE overrides it (useful for tests and debugging).
function logFilePath(): string {
  const override = process.env.PRISM_LOG_FILE
  if (override && override.trim().length > 0) return override.trim()
  const dataHome = process.env.XDG_DATA_HOME
  const base =
    dataHome && dataHome.trim().length > 0
      ? join(dataHome, "opencode")
      : join(homedir(), ".local", "share", "opencode")
  return join(base, "log", "prism.log")
}

function serialize(data: unknown): string {
  try {
    return JSON.stringify(data)
  } catch {
    return String(data)
  }
}

export function log(message: string, data?: unknown): void {
  try {
    const file = logFilePath()
    mkdirSync(dirname(file), { recursive: true })
    const suffix = data === undefined ? "" : ` ${serialize(data)}`
    appendFileSync(file, `${new Date().toISOString()} ${message}${suffix}\n`)
  } catch {
    // Logging is best-effort: a failure must never surface anywhere.
  }
}
