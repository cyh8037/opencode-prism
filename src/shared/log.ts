import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

// Prism logs go to a file, never to the console: the plugin runs inside the
// opencode server process, and console output (stderr) leaks into the TUI.
// The file lives next to opencode's own logs and follows the platform
// convention (XDG data dir; %APPDATA% on Windows); PRISM_LOG_FILE overrides
// it (useful for tests and debugging).
const LOG_ROTATE_BYTES = 10 * 1024 * 1024

// The default path only depends on platform/homedir — compute it once. The
// PRISM_LOG_FILE override is re-read every call so tests can point different
// invocations at different files.
let cachedDefaultPath: string | undefined

function defaultLogFilePath(env: Record<string, string | undefined>): string {
  if (cachedDefaultPath) return cachedDefaultPath
  const base =
    process.platform === "win32"
      ? join(env.APPDATA?.trim() || join(homedir(), "AppData", "Roaming"), "opencode")
      : join(
          env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"),
          "opencode",
        )
  cachedDefaultPath = join(base, "log", "prism.log")
  return cachedDefaultPath
}

function logFilePath(env: Record<string, string | undefined>): string {
  const override = env.PRISM_LOG_FILE
  if (override && override.trim().length > 0) return override.trim()
  return defaultLogFilePath(env)
}

let directoryReady = false

// One-time, at the first write: rotate an oversized log so a long-lived
// server process cannot grow it unbounded.
function prepareLogFile(file: string): void {
  mkdirSync(dirname(file), { recursive: true })
  try {
    if (statSync(file).size > LOG_ROTATE_BYTES) renameSync(file, `${file}.1`)
  } catch {
    // missing file (normal first run) or rotation race — both harmless
  }
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
    const file = logFilePath(process.env)
    if (!directoryReady) {
      prepareLogFile(file)
      directoryReady = true
    }
    const suffix = data === undefined ? "" : ` ${serialize(data)}`
    appendFileSync(file, `${new Date().toISOString()} ${message}${suffix}\n`)
  } catch {
    // Logging is best-effort: a failure must never surface anywhere.
  }
}
