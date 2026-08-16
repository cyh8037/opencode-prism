import {
  SESSION_READY_POLL_MS,
  SESSION_READY_TIMEOUT_MS,
  TMUX_AGENT_PANE_MIN_WIDTH,
  TMUX_MAIN_PANE_MIN_WIDTH,
  TMUX_MAX_AGENT_PANES,
} from "../config/constants"
import type { PrismConfig } from "../config/schema"
import { log } from "../shared/log"
import type { PrismClient } from "../core/client-types"
import type { TaskSessionEvent } from "../core/background/manager"
import { getCurrentPaneId, isInsideTmux, resolveServerUrl } from "./env"
import { applyLayout, enforceMainPaneWidth } from "./layout"
import { closePane, queryWindowWidth, respawnPane, spawnPane, type PaneOpsDeps } from "./pane"
import { buildAuthEnvPrefix, buildTmuxAttachCommand, buildTmuxPlaceholderCommand } from "./pane-command"
import { hasTmuxBinary, runTmuxCommand, type TmuxRunner } from "./runner"

interface TrackedPane {
  sessionID: string
  paneId: string
}

function splitDirectionFor(layout: PrismConfig["tmux"]["layout"]): "-h" | "-v" {
  switch (layout) {
    case "main-horizontal":
    case "even-horizontal":
      return "-v"
    default:
      return "-h"
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

// Pane lifecycle manager for subagent visualization. All tmux failures are
// logged and swallowed: visualization is best-effort and must never break
// the agent loop.
export class TmuxManager {
  private panes = new Map<string, TrackedPane>()
  private enabled: boolean
  private sourcePaneId: string | undefined
  private serverUrl: string
  private runner: TmuxRunner
  private logger: typeof log

  constructor(
    private deps: {
      client: PrismClient
      directory: string
      config: PrismConfig
      serverUrl?: string
      env?: Record<string, string | undefined>
      runner?: TmuxRunner
      logger?: typeof log
    },
  ) {
    this.logger = deps.logger ?? log
    const env = deps.env ?? process.env
    this.enabled = deps.config.tmux.enabled && isInsideTmux(env)
    this.sourcePaneId = getCurrentPaneId(env)
    this.serverUrl = resolveServerUrl(deps.serverUrl, env, this.logger)
    this.runner = deps.runner ?? runTmuxCommand
  }

  async init(): Promise<void> {
    if (!this.enabled) return
    if (!this.sourcePaneId) {
      this.logger("[prism] tmux: inside tmux but TMUX_PANE is missing, visualization disabled")
      this.enabled = false
      return
    }
    if (!(await hasTmuxBinary())) {
      this.logger("[prism] tmux: tmux binary not found, visualization disabled")
      this.enabled = false
      return
    }
    this.logger("[prism] tmux visualization enabled", {
      sourcePaneId: this.sourcePaneId,
      serverUrl: this.serverUrl,
      layout: this.deps.config.tmux.layout,
    })
  }

  isEnabled(): boolean {
    return this.enabled
  }

  private paneOps(): PaneOpsDeps {
    return { runner: this.runner, sourcePaneId: this.sourcePaneId!, logger: this.logger }
  }

  // Session became attachable: spawn a pane with a placeholder, wait for the
  // session to produce messages, then swap in the attach command.
  async onSessionCreated(event: TaskSessionEvent): Promise<void> {
    if (!this.enabled || !this.sourcePaneId) return
    if (this.panes.size >= TMUX_MAX_AGENT_PANES) {
      this.logger("[prism] tmux: max agent panes reached, skipping visualization", {
        sessionID: event.sessionID,
      })
      return
    }

    const windowWidth = await queryWindowWidth(this.paneOps())
    if (windowWidth !== undefined && windowWidth < TMUX_MAIN_PANE_MIN_WIDTH + TMUX_AGENT_PANE_MIN_WIDTH) {
      this.logger("[prism] tmux: window too narrow for another pane, skipping visualization", {
        windowWidth,
      })
      return
    }

    const placeholder = buildTmuxPlaceholderCommand(event.description)
    const direction = splitDirectionFor(this.deps.config.tmux.layout)
    const spawnResult = await spawnPane(this.paneOps(), {
      command: placeholder,
      description: event.description,
      direction,
    })
    if (!spawnResult.success || !spawnResult.paneId) return

    const paneId = spawnResult.paneId
    this.panes.set(event.sessionID, { sessionID: event.sessionID, paneId })

    await applyLayout(this.runner, this.deps.config.tmux, this.sourcePaneId, this.logger)
    await enforceMainPaneWidth(this.runner, this.sourcePaneId, TMUX_MAIN_PANE_MIN_WIDTH, this.logger)

    const ready = await this.waitForSessionReady(event.sessionID, event.directory)
    if (ready) {
      const attachCommand = `${buildAuthEnvPrefix(this.deps.env ?? process.env)}${buildTmuxAttachCommand(
        this.serverUrl,
        event.sessionID,
        event.directory,
      )}`
      await respawnPane(this.paneOps(), paneId, attachCommand, event.directory)
    } else {
      this.logger("[prism] tmux: session not ready in time, leaving placeholder pane", {
        sessionID: event.sessionID,
      })
    }
  }

  private async waitForSessionReady(sessionID: string, directory: string): Promise<boolean> {
    const deadline = Date.now() + SESSION_READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      try {
        const response = await this.deps.client.session.messages({
          path: { id: sessionID },
          query: { directory },
        })
        if (Array.isArray(response.data) && response.data.length > 0) return true
      } catch {
        // session may not exist yet
      }
      await sleep(SESSION_READY_POLL_MS)
    }
    return false
  }

  // Task terminal: close the pane explicitly (client.session.abort does not
  // reliably emit session.deleted, see oh-my-openagent #4773).
  async onSessionDeleted(event: { sessionID: string }): Promise<void> {
    if (!this.enabled) return
    const tracked = this.panes.get(event.sessionID)
    if (!tracked) return
    this.panes.delete(event.sessionID)
    await closePane(this.paneOps(), tracked.paneId)
  }

  // Shutdown: close every tracked pane.
  async sweep(): Promise<void> {
    for (const tracked of this.panes.values()) {
      await closePane(this.paneOps(), tracked.paneId)
    }
    this.panes.clear()
  }
}
