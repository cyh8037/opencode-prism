import { describe, expect, test } from "bun:test"
import { StaticModelCapabilities, parseModelRef, shouldRetryError } from "../src/models"

describe("parseModelRef", () => {
  test("parses provider/model", () => {
    expect(parseModelRef("anthropic/claude-fable-5")).toEqual({
      providerID: "anthropic",
      modelID: "claude-fable-5",
    })
  })

  test("parses provider/model with variant suffix", () => {
    expect(parseModelRef("deepseek/deepseek-v4-pro max")).toEqual({
      providerID: "deepseek",
      modelID: "deepseek-v4-pro",
      variant: "max",
    })
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

describe("StaticModelCapabilities", () => {
  const capabilities = new StaticModelCapabilities()

  test("knows vision-capable models", () => {
    expect(capabilities.isVisionCapable("claude-fable-5")).toBe(true)
    expect(capabilities.isVisionCapable("gpt-5.6-sol")).toBe(true)
  })

  test("knows non-vision models", () => {
    expect(capabilities.isVisionCapable("deepseek-v4-flash")).toBe(false)
    expect(capabilities.isVisionCapable("deepseek-v4-pro")).toBe(false)
  })

  test("returns null for unknown models", () => {
    expect(capabilities.isVisionCapable("brand-new-model")).toBeNull()
  })
})

describe("error classifier", () => {
  test("rate limit and 5xx are retryable", () => {
    expect(shouldRetryError({ message: "rate limit exceeded" })).toBe(true)
    expect(shouldRetryError({ statusCode: 503 })).toBe(true)
    expect(shouldRetryError({ message: "invalid api key" })).toBe(false)
  })
})
