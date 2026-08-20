import { describe, expect, test } from "bun:test"
import { TmuxManager } from "../src/tmux/manager"
import { buildTmuxAttachCommand, buildTmuxPlaceholderCommand } from "../src/tmux/pane-command"
import { isInsideTmux, resolveServerUrl } from "../src/tmux/env"
import { parseConfig } from "../src/config/load"
import type { PrismClient } from "../src/core/client-types"
import type { TmuxCommandResult, TmuxRunner } from "../src/tmux/runner"

describe("env", () => {
  test("detects tmux from TMUX env var", () => {
    expect(isInsideTmux({ TMUX: "/tmp/tmux-0/default,123,0" })).toBe(true)
    expect(isInsideTmux({})).toBe(false)
  })

  test("resolves server url with port fallback", () => {
    const warnings: string[] = []
    expect(resolveServerUrl(undefined, { OPENCODE_PORT: "4097" }, (m) => warnings.push(m))).toBe(
      "http://localhost:4097",
    )
    expect(resolveServerUrl("http://localhost:0", {}, (m) => warnings.push(m))).toBe("http://localhost:4096")
    expect(warnings.some((w) => w.includes("port 0"))).toBe(true)
    expect(resolveServerUrl("http://localhost:4100")).toBe("http://localhost:4100")
  })
})

describe("pane commands", () => {
  test("attach command embeds url, session and directory", () => {
    const command = buildTmuxAttachCommand("http://localhost:4096", "sess_1", "/work")
    expect(command).toContain("opencode attach")
    expect(command).toContain("sess_1")
    expect(command).toContain("/work")
  })

  test("placeholder keeps the pane alive", () => {
    const command = buildTmuxPlaceholderCommand("my task")
    expect(command).toContain("prism subagent pane ready: my task")
    expect(command).toContain("while :; do sleep 86400; done")
  })

  // The description can be LLM-generated (bg_spawn), so the pane command must
  // not execute shell metacharacters inside it. Runs the built command the
  // same way tmux would (via /bin/sh -c) and asserts no command substitution
  // fired. The placeholder's infinite loop is torn down after the probe.
  test("placeholder does not execute metacharacters in the description", async () => {
    const { existsSync, unlinkSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const marker = join(tmpdir(), `prism-injection-${process.pid}`)
    const description = "evil $(touch " + marker + ") and `touch " + marker + "`"

    const command = buildTmuxPlaceholderCommand(description)
    // No unescaped substitution syntax may survive quoting.
    expect(command).not.toMatch(/(?<!\\)\$\(/)
    expect(command).not.toMatch(/(?<!\\)`/)

    // Run it backgrounded, then kill the whole little process tree (the
    // placeholder loops forever, so pkill the loop's sleep child BEFORE its
    // parent shell dies and orphans/repars it).
    const wrapped =
      command + " & pid=$!; sleep 0.3; pkill -P $pid 2>/dev/null; kill $pid 2>/dev/null; exit 0"
    const proc = Bun.spawn(["/bin/sh", "-c", wrapped], { stdout: "ignore", stderr: "ignore" })
    await proc.exited

    try {
      expect(existsSync(marker)).toBe(false) // substitution must not have run
    } finally {
      if (existsSync(marker)) unlinkSync(marker)
    }
  })
})

function createMockRunner(): { runner: TmuxRunner; commands: string[][] } {
  const commands: string[][] = []
  const runner: TmuxRunner = async (args) => {
    commands.push(args)
    if (args[0] === "split-window") return { success: true, stdout: "%42\n", stderr: "", exitCode: 0 }
    if (args[0] === "display-message") return { success: true, stdout: "200\n", stderr: "", exitCode: 0 }
    return { success: true, stdout: "", stderr: "", exitCode: 0 }
  }
  return { runner, commands }
}

function createManager(runner: TmuxRunner, client: PrismClient, env: Record<string, string | undefined> = {}) {
  const manager = new TmuxManager({
    client,
    directory: "/work",
    config: parseConfig({}),
    runner,
    env,
  })
  return manager
}

function createClient(): PrismClient {
  return {
    session: {
      get: async () => ({ data: { id: "p", status: "idle" } }),
      create: async () => ({ data: { id: "child" } }),
      abort: async () => {},
      prompt: async () => {},
      promptAsync: async () => {},
      messages: async () => ({ data: [{ info: { role: "user" }, parts: [] }] }),
      status: async () => ({ data: {} }),
    },
    tui: { showToast: async () => {} },
  }
}

describe("TmuxManager", () => {
  test("disabled when not inside tmux", async () => {
    const { runner } = createMockRunner()
    const manager = createManager(runner, createClient(), {})
    await manager.init()
    expect(manager.isEnabled()).toBe(false)
    await manager.onSessionCreated({ sessionID: "s1", parentID: "p", description: "d", directory: "/work" })
    // no tmux commands issued
  })

  test("spawns placeholder pane and swaps in attach command when ready", async () => {
    const { runner, commands } = createMockRunner()
    const manager = createManager(runner, createClient(), { TMUX: "/tmp/tmux-0/default,1,0", TMUX_PANE: "%0" })
    await manager.init()
    expect(manager.isEnabled()).toBe(true)

    await manager.onSessionCreated({ sessionID: "s1", parentID: "p", description: "build docs", directory: "/work" })

    const split = commands.find((cmd) => cmd[0] === "split-window")
    expect(split).toBeDefined()
    expect(split?.join(" ")).toContain("prism subagent pane ready: build docs")

    const respawn = commands.find((cmd) => cmd[0] === "respawn-pane")
    expect(respawn).toBeDefined()
    expect(respawn?.join(" ")).toContain("opencode attach")
    expect(respawn?.join(" ")).toContain("s1")
  })

  test("closes the pane when the session is deleted", async () => {
    const { runner, commands } = createMockRunner()
    const manager = createManager(runner, createClient(), { TMUX: "/tmp/tmux-0/default,1,0", TMUX_PANE: "%0" })
    await manager.init()
    await manager.onSessionCreated({ sessionID: "s1", parentID: "p", description: "d", directory: "/work" })
    await manager.onSessionDeleted({ sessionID: "s1" })
    const kill = commands.find((cmd) => cmd[0] === "kill-pane")
    expect(kill).toBeDefined()
    expect(kill?.join(" ")).toContain("%42")
  })

  test("skips spawning when window is too narrow", async () => {
    const commands: string[][] = []
    const runner: TmuxRunner = async (args) => {
      commands.push(args)
      if (args[0] === "display-message") return { success: true, stdout: "100\n", stderr: "", exitCode: 0 }
      return { success: true, stdout: "%42\n", stderr: "", exitCode: 0 }
    }
    const manager = createManager(runner, createClient(), { TMUX: "/tmp/tmux-0/default,1,0", TMUX_PANE: "%0" })
    await manager.init()
    await manager.onSessionCreated({ sessionID: "s1", parentID: "p", description: "d", directory: "/work" })
    expect(commands.find((cmd) => cmd[0] === "split-window")).toBeUndefined()
  })
})
