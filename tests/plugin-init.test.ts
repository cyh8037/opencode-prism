import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Prism } from "../src/index"

// Plugin init must never throw on bad config or a missing vision model:
// opencode loads the plugin at startup and a throw would break the whole
// session. The stub client is never called during init.
const stubClient = { session: {}, tui: {} } as never

function withProjectConfig(contents: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "prism-plugin-"))
  if (contents !== null) {
    const configDir = join(dir, ".prism")
    mkdirSync(configDir)
    writeFileSync(join(configDir, "prism.jsonc"), contents)
  }
  return dir
}

describe("plugin init resilience", () => {
  const cases: Array<[string, string | null]> = [
    ["malformed config file", '{ "vision": { "model": "unterminated'],
    ["non-object config", '["not", "an", "object"]'],
    ["no config file at all", null],
    ["vision model explicitly disabled", '{ "vision": { "model": "" } }'],
    ["invalid vision model reference", '{ "vision": { "model": "no-slash" } }'],
    ["vision section is not an object", '{ "vision": "garbage" }'],
  ]

  for (const [name, contents] of cases) {
    test(`${name} does not throw during plugin init`, async () => {
      const dir = withProjectConfig(contents)
      try {
        const plugin = await Prism({ directory: dir, client: stubClient } as never)
        expect(typeof plugin.config).toBe("function")
        expect(plugin.tool).toBeDefined()
        const dispose = plugin.dispose as (() => Promise<void>) | undefined
        await dispose?.()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  test("config problems surface as a visible toast instead of failing silently", async () => {
    const toasts: Array<{ title: string; message: string; variant: string }> = []
    const dir = withProjectConfig('{ "vision": { "model": "unterminated')
    try {
      const client = {
        session: {},
        tui: {
          showToast: async (params: { body: { title: string; message: string; variant: string } }) => {
            toasts.push(params.body)
          },
        },
      } as never
      await Prism({ directory: dir, client } as never)
      expect(toasts.length).toBeGreaterThanOrEqual(1)
      expect(toasts[0]?.title).toBe("Prism config")
      expect(toasts[0]?.variant).toBe("warning")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Since 0.3.0 the switch gates BOTH split entries: the /split command's
  // task mode runs through the split_task tool (template-instructed), so
  // disabling the tool also unregisters the command — a registered command
  // that could not execute would be worse.
  test("split.tool=false disables both the split_task tool and the /split command", async () => {
    const init = async (contents: string | null) => {
      const dir = withProjectConfig(contents)
      try {
        const plugin = await Prism({ directory: dir, client: stubClient } as never)
        const dispose = plugin.dispose as (() => Promise<void>) | undefined
        await dispose?.()
        const toolNames = Object.keys(plugin.tool as Record<string, unknown>)
        const cfg: Record<string, unknown> = { model: "openai/gpt-5.6-sol" }
        await (plugin.config as (c: unknown) => Promise<void>)(cfg)
        const commandNames = Object.keys((cfg as { command?: Record<string, unknown> }).command ?? {})
        return { toolNames, commandNames }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }

    const on = await init(null)
    expect(on.toolNames).toContain("split_task")
    expect(on.commandNames).toEqual(["bg", "split"])

    const off = await init('{ "split": { "tool": false } }')
    expect(off.toolNames).not.toContain("split_task")
    expect(off.commandNames).toEqual(["bg"])
    // neighboring tools are unaffected by the switch
    expect(off.toolNames).toContain("bg_spawn")
  })

  // An invalid split section falls back to its own defaults (tool on) — the
  // same per-section resilience vision/background already have.
  test("an invalid split section falls back to the default instead of disabling the tool", async () => {
    const dir = withProjectConfig('{ "split": { "tool": "yes" } }')
    try {
      const plugin = await Prism({ directory: dir, client: stubClient } as never)
      expect(Object.keys(plugin.tool as Record<string, unknown>)).toContain("split_task")
      const dispose = plugin.dispose as (() => Promise<void>) | undefined
      await dispose?.()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
