import { DEFAULT_SERVER_PORT } from "../config/constants"
import { log } from "./log"

// OpenCode server URL for attach hints (e.g. the /bg output --full pointer).
// Port 0 (server not bound) falls back to the default port with a warning.
export function resolveServerUrl(
  rawServerUrl: string | undefined,
  env: Record<string, string | undefined> = process.env,
  logger: typeof log = log,
): string {
  const configuredPort = env.OPENCODE_PORT
  const parsedPort = configuredPort ? Number(configuredPort) : DEFAULT_SERVER_PORT
  // 127.0.0.1 instead of localhost: on Windows "localhost" can resolve to
  // ::1 first, and a server bound to 127.0.0.1 only is then unreachable via
  // the hinted URL. A provided ctx.serverUrl is passed through unchanged.
  const fallbackUrl = `http://127.0.0.1:${DEFAULT_SERVER_PORT}`

  if (rawServerUrl) {
    try {
      const parsed = new URL(rawServerUrl)
      if (parsed.port === "0") {
        logger("[prism] ctx.serverUrl has port 0, falling back. Launch opencode with --port N and OPENCODE_PORT=N", {
          kind: "warning",
        })
        return fallbackUrl
      }
      return rawServerUrl
    } catch {
      return fallbackUrl
    }
  }

  if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
    return fallbackUrl
  }
  return `http://127.0.0.1:${parsedPort}`
}
