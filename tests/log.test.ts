import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { guardHook } from "../src/shared/hook-guard"
import { log } from "../src/shared/log"

describe("log", () => {
  test("writes to PRISM_LOG_FILE instead of the console", () => {
    const dir = mkdtempSync(join(tmpdir(), "prism-log-"))
    const file = join(dir, "prism.log")
    const previous = process.env.PRISM_LOG_FILE
    try {
      process.env.PRISM_LOG_FILE = file
      log("hello", { a: 1 })
      const content = readFileSync(file, "utf8")
      expect(content).toContain("hello")
      expect(content).toContain('"a":1')
    } finally {
      if (previous === undefined) delete process.env.PRISM_LOG_FILE
      else process.env.PRISM_LOG_FILE = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("never throws, even with unserializable data", () => {
    const previous = process.env.PRISM_LOG_FILE
    try {
      process.env.PRISM_LOG_FILE = "/dev/null/nonexistent-dir/prism.log"
      const circular: Record<string, unknown> = {}
      circular.self = circular
      expect(() => log("circular", circular)).not.toThrow()
    } finally {
      if (previous === undefined) delete process.env.PRISM_LOG_FILE
      else process.env.PRISM_LOG_FILE = previous
    }
  })
})

describe("guardHook", () => {
  test("swallows a throwing hook instead of letting the error reach opencode", async () => {
    const hook = guardHook("test.hook", async () => {
      throw new Error("boom")
    })
    await expect(hook()).resolves.toBeUndefined()
  })

  test("passes through the hook's return value", async () => {
    const hook = guardHook("test.hook", async (value: string) => `echo ${value}`)
    await expect(hook("x")).resolves.toBe("echo x")
  })
})
