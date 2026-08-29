import { describe, expect, test } from "bun:test"
import { collectAssistantText, lastAssistantText } from "../src/core/assistant-text"

describe("collectAssistantText", () => {
  test("joins every completed assistant text in message order", () => {
    const messages = [
      { info: { role: "user" }, parts: [{ type: "text", text: "prompt" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "first conclusion", state: { status: "completed" } }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "second conclusion", state: { status: "completed" } }] },
    ]
    expect(collectAssistantText(messages, 1000)).toBe("first conclusion\n\nsecond conclusion")
  })

  test("accepts parts without state (non-streaming providers) and skips incomplete streams", () => {
    const messages = [
      { info: { role: "assistant" }, parts: [{ type: "text", text: "no-state text" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "streaming", state: { status: "running" } }] },
    ]
    expect(collectAssistantText(messages, 1000)).toBe("no-state text")
  })

  test("caps the concatenation at maxChars", () => {
    const messages = [
      { info: { role: "assistant" }, parts: [{ type: "text", text: "a".repeat(60), state: { status: "completed" } }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "b".repeat(60), state: { status: "completed" } }] },
    ]
    const collected = collectAssistantText(messages, 80)
    expect(collected?.length).toBeLessThanOrEqual(80)
    expect(collected?.startsWith("a".repeat(60))).toBe(true)
  })

  test("returns null when there is no usable assistant text", () => {
    expect(collectAssistantText([], 100)).toBeNull()
    expect(collectAssistantText("not an array", 100)).toBeNull()
    expect(
      collectAssistantText([{ info: { role: "user" }, parts: [{ type: "text", text: "x" }] }], 100),
    ).toBeNull()
  })

  test("lastAssistantText still returns only the latest text", () => {
    const messages = [
      { info: { role: "assistant" }, parts: [{ type: "text", text: "older", state: { status: "completed" } }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "newer", state: { status: "completed" } }] },
    ]
    expect(lastAssistantText(messages)).toBe("newer")
  })

  test("tolerates malformed entries and parts between valid ones", () => {
    const messages = [
      "junk",
      { info: { role: "assistant" }, parts: ["junk", null, { type: "text", text: "before", state: "junk" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "after", state: { status: "completed" } }] },
    ]
    expect(lastAssistantText(messages)).toBe("after")
    expect(collectAssistantText(messages, 1000)).toBe("after")
  })

  test("skips whitespace-only text parts", () => {
    const messages = [
      { info: { role: "assistant" }, parts: [{ type: "text", text: "   ", state: { status: "completed" } }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "real", state: { status: "completed" } }] },
    ]
    expect(lastAssistantText(messages)).toBe("real")
  })
})
