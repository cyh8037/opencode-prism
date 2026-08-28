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
// Bytes written since the last physical-size check. The check itself is a
// statSync per ~512KB of logging — cheap enough, and it bounds the file at
// LOG_ROTATE_BYTES + one interval instead of growing unbounded.
const LOG_ROTATE_CHECK_BYTES = 512 * 1024
let bytesSinceCheck = 0

function rotateIfNeeded(file: string): void {
  try {
    if (statSync(file).size > LOG_ROTATE_BYTES) renameSync(file, `${file}.1`)
  } catch {
    // missing file (normal first run) or rotation race — both harmless
  }
}

// Rotation is NOT one-time: a long-lived server process writes logs for its
// whole life, so the size check must run periodically, not just at the first
// write. The directory creation stays one-time (cheap once it exists).
function prepareLogFile(file: string): void {
  mkdirSync(dirname(file), { recursive: true })
  rotateIfNeeded(file)
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
    const line = `${new Date().toISOString()} ${message}${suffix}\n`
    bytesSinceCheck += Buffer.byteLength(line)
    if (bytesSinceCheck >= LOG_ROTATE_CHECK_BYTES) {
      bytesSinceCheck = 0
      rotateIfNeeded(file)
    }
    appendFileSync(file, line)
  } catch {
    // Logging is best-effort: a failure must never surface anywhere.
  }
}
