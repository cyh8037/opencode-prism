import { describe, expect, test } from "bun:test"
import { CurrentModelTracker } from "../src/core/vision/model-tracker"

describe("CurrentModelTracker", () => {
  test("chat.params records the model and its image capability", () => {
    const tracker = new CurrentModelTracker()
    tracker.onChatParams({
      sessionID: "s1",
      model: { providerID: "anthropic", id: "claude-fable-5", capabilities: { input: { image: true } } },
    })
    expect(tracker.get("s1")).toEqual({
      model: { providerID: "anthropic", modelID: "claude-fable-5" },
      visionCapable: true,
      capabilityKnown: true,
    })
  })

  test("non-image models are marked non-vision", () => {
    const tracker = new CurrentModelTracker()
    tracker.onChatParams({
      sessionID: "s1",
      model: { providerID: "deepseek", id: "deepseek-v4-flash", capabilities: { input: { image: false } } },
    })
    expect(tracker.get("s1")?.visionCapable).toBe(false)
  })

  test("missing capability info is treated as non-vision (conservative)", () => {
    const tracker = new CurrentModelTracker()
    tracker.onChatParams({ sessionID: "s1", model: { providerID: "p", id: "m" } })
    expect(tracker.get("s1")?.visionCapable).toBe(false)
  })

  test("a model switch refreshes the snapshot in both directions", () => {
    const tracker = new CurrentModelTracker()
    tracker.onChatParams({
      sessionID: "s1",
      model: { providerID: "a", id: "vision", capabilities: { input: { image: true } } },
    })
    tracker.onChatParams({
      sessionID: "s1",
      model: { providerID: "b", id: "text-only", capabilities: { input: { image: false } } },
    })
    expect(tracker.get("s1")?.model).toEqual({ providerID: "b", modelID: "text-only" })
    expect(tracker.get("s1")?.visionCapable).toBe(false)
    // and back
    tracker.onChatParams({
      sessionID: "s1",
      model: { providerID: "a", id: "vision", capabilities: { input: { image: true } } },
    })
    expect(tracker.get("s1")?.visionCapable).toBe(true)
  })

  test("chat.message fills the model and preserves the capability", () => {
    const tracker = new CurrentModelTracker()
    tracker.onChatParams({
      sessionID: "s1",
      model: { providerID: "a", id: "m", capabilities: { input: { image: true } } },
    })
    tracker.onChatMessage({ sessionID: "s1", model: { providerID: "a", modelID: "m" } })
    expect(tracker.get("s1")?.model).toEqual({ providerID: "a", modelID: "m" })
    expect(tracker.get("s1")?.visionCapable).toBe(true)
    expect(tracker.get("s1")?.capabilityKnown).toBe(true)
  })

  test("a chat.message-only snapshot has unknown capability", () => {
    const tracker = new CurrentModelTracker()
    tracker.onChatMessage({ sessionID: "s1", model: { providerID: "a", modelID: "m" } })
    expect(tracker.get("s1")?.model).toEqual({ providerID: "a", modelID: "m" })
    expect(tracker.get("s1")?.visionCapable).toBe(false)
    expect(tracker.get("s1")?.capabilityKnown).toBe(false)
  })

  test("clear removes the snapshot", () => {
    const tracker = new CurrentModelTracker()
    tracker.onChatParams({
      sessionID: "s1",
      model: { providerID: "a", id: "m", capabilities: { input: { image: true } } },
    })
    tracker.clear("s1")
    expect(tracker.get("s1")).toBeUndefined()
  })

  test("ignores chat.params without a model", () => {
    const tracker = new CurrentModelTracker()
    tracker.onChatParams({ sessionID: "s1" })
    expect(tracker.get("s1")).toBeUndefined()
  })
})
