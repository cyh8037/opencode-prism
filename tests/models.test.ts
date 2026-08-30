import { describe, expect, test } from "bun:test"
import { parseModelRef, shouldRetryError } from "../src/models"

describe("parseModelRef", () => {
  test("parses provider/model", () => {
    expect(parseModelRef("anthropic/claude-fable-5")).toEqual({
      providerID: "anthropic",
      modelID: "claude-fable-5",
    })
  })

  test("rejects a variant suffix (variants are not supported)", () => {
    expect(parseModelRef("deepseek/deepseek-v4-pro max")).toBeNull()
  })

  test("allows slashes inside the model id", () => {
    expect(parseModelRef("openrouter/deepseek/deepseek-chat")).toEqual({
      providerID: "openrouter",
      modelID: "deepseek/deepseek-chat",
    })
  })

  test("rejects malformed references", () => {
    expect(parseModelRef("no-slash")).toBeNull()
    expect(parseModelRef("/missing-provider")).toBeNull()
    expect(parseModelRef("provider/")).toBeNull()
    expect(parseModelRef("a/b bogus-variant")).toBeNull()
    expect(parseModelRef("a b c")).toBeNull()
    expect(parseModelRef("")).toBeNull()
  })
})

describe("error classifier", () => {
  test("rate limit and 5xx are retryable", () => {
    expect(shouldRetryError({ message: "rate limit exceeded" })).toBe(true)
    expect(shouldRetryError({ statusCode: 503 })).toBe(true)
    expect(shouldRetryError({ message: "invalid api key" })).toBe(false)
  })

  // 回归（0.5.0 审查）：裸 /500/ 会命中 "1500 tokens" 之类的正文数字。
  test("status-code words are word-boundary anchored", () => {
    expect(shouldRetryError({ message: "HTTP 500 internal" })).toBe(true)
    expect(shouldRetryError({ message: "quota of 1500 tokens exceeded" })).toBe(false)
    expect(shouldRetryError({ message: "429 encountered" })).toBe(true)
  })
})
