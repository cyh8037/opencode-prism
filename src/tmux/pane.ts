import { log } from "../shared/log"
import type { TmuxCommandResult, TmuxRunner } from "./runner"

export interface PaneOpsDeps {
  runner: TmuxRunner
  sourcePaneId: string
  logger?: typeof log
}

// Pane lifecycle primitives. All return { success, id? } and log failures
// without throwing; tmux visualization failures must never break the agent.
export interface PaneSpawnResult {
  success: boolean
  paneId?: string
}

export async function spawnPane(
  deps: PaneOpsDeps,
  args: {
    command: string
    description: string
    direction: "-h" | "-v"
  },
): Promise<PaneSpawnResult> {
  const { runner, sourcePaneId } = deps
  const logger = deps.logger ?? log
  const result = await runner([
    "split-window",
    "-d",
    "-P",
    "-F",
    "#{pane_id}",
    args.direction,
    "-t",
    sourcePaneId,
    args.command,
  ])
  if (!result.success) {
    logger("[prism] tmux: split-window failed", { description: args.description, stderr: result.stderr })
    return { success: false }
  }
  const paneId = result.stdout.trim()
  if (!paneId.startsWith("%")) {
    logger("[prism] tmux: unexpected pane id from split-window", { paneId })
    return { success: false }
  }
  return { success: true, paneId }
}

export async function respawnPane(
  deps: PaneOpsDeps,
  paneId: string,
  command: string,
  directory: string,
): Promise<boolean> {
  const { runner } = deps
  const logger = deps.logger ?? log
  const result = await runner(["respawn-pane", "-k", "-t", paneId, "-c", directory, command])
  if (!result.success) {
    logger("[prism] tmux: respawn-pane failed", { paneId, stderr: result.stderr })
    return false
  }
  return true
}

export async function closePane(deps: PaneOpsDeps, paneId: string): Promise<void> {
  const { runner } = deps
  const logger = deps.logger ?? log
  const result = await runner(["kill-pane", "-t", paneId])
  if (!result.success) {
    logger("[prism] tmux: kill-pane failed", { paneId, stderr: result.stderr })
  }
}

export async function queryWindowWidth(deps: PaneOpsDeps): Promise<number | undefined> {
  const { runner } = deps
  const result = await runner(["display-message", "-p", "#{window_width}"])
  const width = Number(result.stdout.trim())
  return Number.isInteger(width) && width > 0 ? width : undefined
}

export type TmuxCommandResultAlias = TmuxCommandResult
