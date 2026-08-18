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
})
