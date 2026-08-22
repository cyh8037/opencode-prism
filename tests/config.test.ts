import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, parseConfig } from "../src/config/load"

describe("parseConfig", () => {
  test("vision model defaults to empty (inherit session model), not a hardcoded vendor model", () => {
    const config = parseConfig({})
    expect(config.vision.model).toBe("")
    expect(config.vision.mode).toBe("sync")
  })

  test("valid partial configs merge onto defaults", () => {
    const config = parseConfig({ background: { concurrency: 2 } })
    expect(config.background.concurrency).toBe(2)
    expect(config.vision.model).toBe("")
  })

  test("an invalid section falls back to its defaults but keeps the others", () => {
    const config = parseConfig({
      vision: { model: "not a provider/model reference" },
      background: { concurrency: 3 },
    })
    expect(config.background.concurrency).toBe(3)
    expect(config.vision.model).toBe("")
    expect(config.vision.mode).toBe("sync")
  })

  test("multiple invalid sections all fall back without throwing", async () => {
    const config = parseConfig({ vision: 42, background: { concurrency: "many" } })
    expect(config.vision.mode).toBe("sync")
    expect(config.background.concurrency).toBe(5)
  })

  test("a legacy tmux config section is ignored without warnings", () => {
    const warnings: string[] = []
    const config = parseConfig(
      { tmux: { enabled: true, layout: "tiled", isolation: "window" } },
      warnings,
    )
    expect(warnings).toHaveLength(0)
    expect(config.vision.mode).toBe("sync")
  })
})

describe("loadConfig", () => {
  test("a malformed config file is ignored instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "prism-cfg-"))
    try {
      const configDir = join(dir, ".prism")
      mkdirSync(configDir)
      writeFileSync(join(configDir, "prism.jsonc"), '{ "vision": { "model": "unterminated')
      // PRISM_CONFIG points at a nonexistent file so the home config cannot
      // leak into this assertion; only the broken project config is read.
      const { config } = loadConfig(dir, { PRISM_CONFIG: join(dir, "unused.jsonc") })
      expect(config.vision.model).toBe("")
      expect(config.background.concurrency).toBe(5)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a non-object config file is ignored instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "prism-cfg-"))
    try {
      const configDir = join(dir, ".prism")
      mkdirSync(configDir)
      writeFileSync(join(configDir, "prism.jsonc"), '["not", "an", "object"]')
      const { config } = loadConfig(dir, { PRISM_CONFIG: join(dir, "unused.jsonc") })
      expect(config.vision.model).toBe("")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("file-level problems are reported as warnings", () => {
    const dir = mkdtempSync(join(tmpdir(), "prism-cfg-"))
    try {
      const configDir = join(dir, ".prism")
      mkdirSync(configDir)
      writeFileSync(join(configDir, "prism.jsonc"), '{ "vision": { "model": "unterminated')
      const { config, warnings } = loadConfig(dir, { PRISM_CONFIG: join(dir, "unused.jsonc") })
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain("failed to parse")
      expect(config.vision.model).toBe("")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("invalid sections are reported as warnings while valid ones are kept", () => {
    const dir = mkdtempSync(join(tmpdir(), "prism-cfg-"))
    try {
      const configDir = join(dir, ".prism")
      mkdirSync(configDir)
      writeFileSync(
        join(configDir, "prism.jsonc"),
        JSON.stringify({ vision: { model: "no-slash" }, background: { concurrency: 3 } }),
      )
      const { config, warnings } = loadConfig(dir, { PRISM_CONFIG: join(dir, "unused.jsonc") })
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain("invalid sections fell back")
      expect(config.background.concurrency).toBe(3)
      expect(config.vision.model).toBe("")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
