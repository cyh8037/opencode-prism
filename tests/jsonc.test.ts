import { describe, expect, test } from "bun:test"
import { parseJsonc } from "../src/config/jsonc"

describe("parseJsonc", () => {
  test("strips line and block comments, keeps URLs in strings", () => {
    const result = parseJsonc(`{
      // a comment
      "url": "https://example.com/a//b",
      /* block
         comment */
      "value": 1,
    }`)
    expect(result).toEqual({ url: "https://example.com/a//b", value: 1 })
  })

  test("handles escaped quotes in strings", () => {
    const result = parseJsonc(`{ "s": "say \\"hi\\"" // trailing comment\n }`)
    expect(result).toEqual({ s: 'say "hi"' })
  })
})
