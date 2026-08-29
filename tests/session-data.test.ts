import { describe, expect, test } from "bun:test"
import {
  eventSessionID,
  modelFromRecord,
  parseSessionMessages,
  sessionStatusMapSchema,
} from "../src/shared/session-data"

describe("parseSessionMessages", () => {
  test("parses well-formed envelopes and keeps extra info fields (model ref)", () => {
    const messages = [
      {
        info: { role: "assistant", model: { providerID: "openai", modelID: "gpt" } },
        parts: [{ type: "text", text: "hi" }],
      },
    ]
    const parsed = parseSessionMessages(messages)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.info.role).toBe("assistant")
    expect(parsed[0]?.info.model).toEqual({ providerID: "openai", modelID: "gpt" })
  })

  test("drops malformed entries instead of failing the whole array", () => {
    const messages = [
      "junk",
      null,
      { parts: [{ type: "text", text: "no info" }] },
      { info: "not-an-object" },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "ok" }] },
    ]
    const parsed = parseSessionMessages(messages)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.info.role).toBe("assistant")
  })

  test("accepts missing/null parts and non-array input", () => {
    expect(parseSessionMessages([{ info: { role: "user" } }])).toEqual([
      { info: { role: "user" }, parts: undefined },
    ])
    expect(parseSessionMessages([{ info: { role: "user" }, parts: null }])).toHaveLength(1)
    expect(parseSessionMessages("not an array")).toEqual([])
    expect(parseSessionMessages(undefined)).toEqual([])
  })
})

describe("eventSessionID", () => {
  test("reads the direct sessionID first", () => {
    expect(eventSessionID({ sessionID: "ses_1" })).toBe("ses_1")
    expect(eventSessionID({ sessionID: "ses_1", info: { sessionID: "ses_2" } })).toBe("ses_1")
  })

  test("falls back to info.sessionID", () => {
    expect(eventSessionID({ info: { sessionID: "ses_2" } })).toBe("ses_2")
  })

  test("a non-string direct value falls through to the nested one", () => {
    expect(eventSessionID({ sessionID: 42, info: { sessionID: "ses_2" } })).toBe("ses_2")
    expect(eventSessionID({ sessionID: 42, info: { sessionID: 7 } })).toBeUndefined()
  })

  test("returns undefined for junk or missing properties", () => {
    expect(eventSessionID(undefined)).toBeUndefined()
    expect(eventSessionID({})).toBeUndefined()
    expect(eventSessionID({ info: "junk" })).toBeUndefined()
  })
})

describe("modelFromRecord", () => {
  test("prefers id over modelID", () => {
    expect(modelFromRecord({ providerID: "openai", id: "gpt", modelID: "other" })).toEqual({
      providerID: "openai",
      modelID: "gpt",
    })
  })

  test("falls back to modelID when id is absent", () => {
    expect(modelFromRecord({ providerID: "openai", modelID: "gpt" })).toEqual({
      providerID: "openai",
      modelID: "gpt",
    })
  })

  test("rejects a non-string id even when modelID exists (id wins, then fails)", () => {
    expect(modelFromRecord({ providerID: "openai", id: 42, modelID: "gpt" })).toBeUndefined()
  })

  test("rejects non-objects and missing providerID/modelID", () => {
    expect(modelFromRecord("gpt")).toBeUndefined()
    expect(modelFromRecord(null)).toBeUndefined()
    expect(modelFromRecord({ id: "gpt" })).toBeUndefined()
    expect(modelFromRecord({ providerID: "openai" })).toBeUndefined()
  })
})

describe("sessionStatusMapSchema", () => {
  test("accepts well-formed maps with extra entry fields stripped", () => {
    const parsed = sessionStatusMapSchema.safeParse({
      ses_1: { type: "busy", message: "working" },
      ses_2: { type: "retry", extra: "ignored" },
    })
    expect(parsed.success).toBe(true)
  })

  test("rejects non-objects, arrays, and malformed entries (fail closed)", () => {
    expect(sessionStatusMapSchema.safeParse(null).success).toBe(false)
    expect(sessionStatusMapSchema.safeParse(undefined).success).toBe(false)
    expect(sessionStatusMapSchema.safeParse([]).success).toBe(false)
    expect(sessionStatusMapSchema.safeParse({ ses_1: { type: 42 } }).success).toBe(false)
    expect(sessionStatusMapSchema.safeParse({ ses_1: "busy" }).success).toBe(false)
  })
})
