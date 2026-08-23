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

  // vision.enabled gates the tool registration the same way split.tool does:
  // a disabled feature must not leave a callable-but-dead vision_look, and
  // the bg tool descriptions AND command templates must stop pointing
  // children at it (a child told to call an unregistered tool would hit
  // "tool not found").
  test("vision.enabled=false unregisters vision_look but keeps the other tools", async () => {
    const init = async (contents: string | null) => {
      const dir = withProjectConfig(contents)
      try {
        const plugin = await Prism({ directory: dir, client: stubClient } as never)
        const dispose = plugin.dispose as (() => Promise<void>) | undefined
        await dispose?.()
        return Object.keys(plugin.tool as Record<string, unknown>)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }

    const on = await init(null)
    expect(on).toContain("vision_look")
    expect(on).toContain("bg_spawn")
    expect(on).toContain("split_task")

    const off = await init('{ "vision": { "enabled": false } }')
    expect(off).not.toContain("vision_look")
    // neighboring tools are unaffected by the switch
    expect(off).toContain("bg_spawn")
    expect(off).toContain("split_task")
  })

  // The command templates carry the read-image guidance verbatim to the main
  // model; with vision disabled the guidance must vanish from BOTH /bg and
  // /split, or the model would direct children at a removed tool.
  test("vision.enabled=false drops the vision_look guidance from the command templates", async () => {
    const init = async (contents: string | null) => {
      const dir = withProjectConfig(contents)
      try {
        const plugin = await Prism({ directory: dir, client: stubClient } as never)
        const dispose = plugin.dispose as (() => Promise<void>) | undefined
        await dispose?.()
        const cfg: Record<string, unknown> = { model: "openai/gpt-5.6-sol" }
        await (plugin.config as (c: unknown) => Promise<void>)(cfg)
        const commands = (cfg as { command?: Record<string, { template: string }> }).command ?? {}
        return {
          bgTemplate: commands.bg?.template ?? "",
          splitTemplate: commands.split?.template ?? "",
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }

    const on = await init(null)
    expect(on.bgTemplate).toContain("vision_look")
    expect(on.splitTemplate).toContain("vision_look")

    const off = await init('{ "vision": { "enabled": false } }')
    expect(off.bgTemplate).not.toContain("vision_look")
    expect(off.splitTemplate).not.toContain("vision_look")
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
