import { DEFAULT_SERVER_PORT } from "../config/constants"
import { log } from "../shared/log"

// Running inside a tmux session (TMUX env var set by the tmux server)?
export function isInsideTmux(env: Record<string, string | undefined> = process.env): boolean {
  return env.TMUX !== undefined && env.TMUX !== ""
}

// Current pane id (TMUX_PANE, e.g. "%3" or "3").
export function getCurrentPaneId(env: Record<string, string | undefined> = process.env): string | undefined {
  const pane = env.TMUX_PANE
  if (!pane) return undefined
  return pane.startsWith("%") ? pane : `%${pane}`
}

// OpenCode server URL for `opencode attach`. Port 0 (server not bound) falls
// back to the default port with a warning (see oh-my-openagent issue #3963).
export function resolveServerUrl(
  rawServerUrl: string | undefined,
  env: Record<string, string | undefined> = process.env,
  logger: typeof log = log,
): string {
  const configuredPort = env.OPENCODE_PORT
  const parsedPort = configuredPort ? Number(configuredPort) : DEFAULT_SERVER_PORT
  const fallbackUrl = `http://localhost:${DEFAULT_SERVER_PORT}`

  if (rawServerUrl) {
    try {
      const parsed = new URL(rawServerUrl)
      if (parsed.port === "0") {
        logger("[prism] tmux: ctx.serverUrl has port 0, falling back. Launch opencode with --port N and OPENCODE_PORT=N", {
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
  return `http://localhost:${parsedPort}`
}
