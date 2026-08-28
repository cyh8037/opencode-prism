import { describe, expect, test } from "bun:test"
import { resolveServerUrl } from "../src/shared/server-url"
import { DEFAULT_SERVER_PORT } from "../src/config/constants"

// The logger parameter is only used for the port-0 warning; tests pass a
// no-op so a missing console never matters.
const quiet = (() => {}) as unknown as typeof import("../src/shared/log").log

const FALLBACK = `http://127.0.0.1:${DEFAULT_SERVER_PORT}`

describe("resolveServerUrl", () => {
  test("passes through a provided server URL", () => {
    expect(resolveServerUrl("http://localhost:4321", {}, quiet)).toBe("http://localhost:4321")
  })

  test("port 0 falls back to the default port", () => {
    expect(resolveServerUrl("http://localhost:0", {}, quiet)).toBe(FALLBACK)
  })

  test("an unparsable server URL falls back", () => {
    expect(resolveServerUrl("not a url", {}, quiet)).toBe(FALLBACK)
  })

  test("uses OPENCODE_PORT when set", () => {
    expect(resolveServerUrl(undefined, { OPENCODE_PORT: "5555" }, quiet)).toBe("http://127.0.0.1:5555")
  })

  test("falls back to the default port without env", () => {
    expect(resolveServerUrl(undefined, {}, quiet)).toBe(FALLBACK)
  })

  test("rejects non-integer, out-of-range, and non-numeric OPENCODE_PORT values", () => {
    expect(resolveServerUrl(undefined, { OPENCODE_PORT: "70000" }, quiet)).toBe(FALLBACK)
    expect(resolveServerUrl(undefined, { OPENCODE_PORT: "0" }, quiet)).toBe(FALLBACK)
    expect(resolveServerUrl(undefined, { OPENCODE_PORT: "-1" }, quiet)).toBe(FALLBACK)
    expect(resolveServerUrl(undefined, { OPENCODE_PORT: "abc" }, quiet)).toBe(FALLBACK)
  })
})
