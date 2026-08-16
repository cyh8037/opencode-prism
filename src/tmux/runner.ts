import { log } from "../shared/log"

export interface TmuxCommandResult {
  success: boolean
  stdout: string
  stderr: string
  exitCode: number
}

export type TmuxRunner = (args: string[]) => Promise<TmuxCommandResult>

// Default runner: shell out to the tmux binary.
export async function runTmuxCommand(args: string[], logger: typeof log = log): Promise<TmuxCommandResult> {
  try {
    const process = Bun.spawn(["tmux", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdout = await new Response(process.stdout).text()
    const stderr = await new Response(process.stderr).text()
    const exitCode = await process.exited
    return { success: exitCode === 0, stdout, stderr, exitCode }
  } catch (error) {
    logger("[prism] tmux command failed to spawn", { args, error })
    return { success: false, stdout: "", stderr: String(error), exitCode: -1 }
  }
}

export async function hasTmuxBinary(): Promise<boolean> {
  return (await Bun.which("tmux")) !== null
}
