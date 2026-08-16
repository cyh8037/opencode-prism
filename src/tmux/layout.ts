import type { PrismConfig } from "../config/schema"
import { log } from "../shared/log"
import type { TmuxRunner } from "./runner"

// Layout application. Keep it minimal: select-layout after each split keeps
// the main pane sized per the configured layout family.
export async function applyLayout(
  runner: TmuxRunner,
  config: PrismConfig["tmux"],
  sourcePaneId: string,
  logger: typeof log = log,
): Promise<void> {
  const result = await runner(["select-layout", "-t", sourcePaneId, config.layout])
  if (!result.success) {
    logger("[prism] tmux: select-layout failed", { layout: config.layout, stderr: result.stderr })
  }
}

// Resize the main pane so it never gets squeezed below the hardcoded minimum.
export async function enforceMainPaneWidth(
  runner: TmuxRunner,
  sourcePaneId: string,
  minWidth: number,
  logger: typeof log = log,
): Promise<void> {
  const result = await runner(["resize-pane", "-t", sourcePaneId, "-x", String(minWidth)])
  if (!result.success) {
    logger("[prism] tmux: resize-pane failed", { stderr: result.stderr })
  }
}
