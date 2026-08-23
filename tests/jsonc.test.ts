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

  test("does not corrupt string values containing comma-space-bracket", () => {
    // A blind regex stripper turns "bracket, ]" into "bracket]" — the scanner
    // must only strip commas OUTSIDE strings.
    expect(parseJsonc(`{"desc": "bracket, ]", "n": 1}`)).toEqual({ desc: "bracket, ]", n: 1 })
    expect(parseJsonc(`{"desc": "brace, }", "n": 1}`)).toEqual({ desc: "brace, }", n: 1 })
    expect(parseJsonc(`{"desc": "comma,\\n] escaped newline", "n": 1}`)).toEqual({ desc: "comma,\n] escaped newline", n: 1 })
  })

  test("strips trailing commas after comments and newlines", () => {
    const result = parseJsonc(`{
      "a": [1, 2, // trailing list comma
      ],
      "b": 1, /* inline comment */
      "c": {"x": 2,},
    }`)
    expect(result).toEqual({ a: [1, 2], b: 1, c: { x: 2 } })
  })

  test("keeps non-trailing commas", () => {
    expect(parseJsonc(`{"a": [1, 2]}`)).toEqual({ a: [1, 2] })
  })

  // Windows Notepad / PowerShell 5 save UTF-8 with a BOM; JSON.parse rejects
  // the \uFEFF outright, which used to void the whole config file.
  test("strips a leading UTF-8 BOM", () => {
    expect(parseJsonc("\uFEFF{\"a\": 1,}")).toEqual({ a: 1 })
    expect(parseJsonc("\uFEFF// comment\r\n{\"a\": 1}")).toEqual({ a: 1 })
  })
})
