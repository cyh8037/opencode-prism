import { describe, expect, test } from "bun:test"
import { errorInfoFromObject, errorInfoFromResult } from "../src/shared/api-result"

describe("errorInfoFromResult", () => {
  test("returns undefined for success shapes", () => {
    expect(errorInfoFromResult(undefined)).toBeUndefined()
    expect(errorInfoFromResult(null)).toBeUndefined()
    expect(errorInfoFromResult({ data: { id: "x" } })).toBeUndefined()
    expect(errorInfoFromResult({ error: null })).toBeUndefined()
  })

  test("uses response.status and prefers data.message over envelope message", () => {
    const info = errorInfoFromResult({
      error: { data: { message: "rate limited" }, message: "envelope text" },
      response: { status: 429 },
    })
    expect(info).toMatchObject({ message: "rate limited", statusCode: 429 })
  })

  test("passes Error instances through with their own name/message", () => {
    const error = new Error("network down")
    error.name = "TypeError"
    const info = errorInfoFromResult({ error, response: { status: 500 } })
    expect(info).toMatchObject({ name: "TypeError", message: "network down", statusCode: 500 })
  })

  test("string and number errors become the message", () => {
    expect(errorInfoFromResult({ error: "boom", response: { status: 502 } })).toMatchObject({
      message: "boom",
      statusCode: 502,
    })
    expect(errorInfoFromResult({ error: 42 })).toMatchObject({ message: "42" })
  })

  test("never fails on junk error objects", () => {
    expect(errorInfoFromResult({ error: {} })).toBeDefined()
    expect(errorInfoFromResult({ error: ["junk"], response: { status: 500 } })).toMatchObject({
      statusCode: 500,
    })
  })
})

describe("errorInfoFromObject", () => {
  test("extracts name/message/statusCode and degrades unreadable fields", () => {
    expect(errorInfoFromObject({ name: "RateLimit", message: "slow down", statusCode: 429 })).toEqual({
      name: "RateLimit",
      message: "slow down",
      statusCode: 429,
    })
    expect(errorInfoFromObject({ message: 42, statusCode: "x" })).toEqual({
      name: undefined,
      message: undefined,
      statusCode: undefined,
    })
  })

  test("data.message wins over the envelope message; junk data degrades", () => {
    expect(errorInfoFromObject({ data: { message: "body" }, message: "envelope" }).message).toBe("body")
    expect(errorInfoFromObject({ data: "junk", message: "envelope" }).message).toBe("envelope")
    expect(errorInfoFromObject({ data: null, message: "envelope" }).message).toBe("envelope")
  })

  test("reads non-enumerable Error instance fields (thrown errors path)", () => {
    const error = new Error("thrown")
    error.name = "AbortError"
    expect(errorInfoFromObject(error)).toEqual({
      name: "AbortError",
      message: "thrown",
      statusCode: undefined,
    })
  })
})
