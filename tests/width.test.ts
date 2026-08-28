import { describe, expect, test } from "bun:test"
import { getStringWidth, padEndWidth, truncateWidth } from "../src/core/shared/width"

describe("getStringWidth", () => {
  test("ASCII is 1 column per char", () => {
    expect(getStringWidth("abc")).toBe(3)
    expect(getStringWidth("bg_a1b2c3")).toBe(9)
  })

  test("CJK ideographs are 2 columns per char", () => {
    expect(getStringWidth("调研")).toBe(4)
    expect(getStringWidth("性能瓶颈")).toBe(8)
  })

  test("mixed ASCII + CJK adds up", () => {
    expect(getStringWidth("bg_a1b2c3 调研")).toBe(14)
  })

  test("fullwidth punctuation counts as 2", () => {
    expect(getStringWidth("（测试）")).toBe(8)
    expect(getStringWidth("，。！")).toBe(6)
  })

  test("kana and hangul count as 2", () => {
    expect(getStringWidth("かたかな")).toBe(8)
    expect(getStringWidth("한글")).toBe(4)
  })

  test("BMP emoji (U+2600-U+27BF) counts as 2", () => {
    expect(getStringWidth("✅")).toBe(2)
    expect(getStringWidth("❤")).toBe(2)
    expect(getStringWidth("✨")).toBe(2)
  })

  test("supplementary-plane emoji counts as 2", () => {
    expect(getStringWidth("🔥")).toBe(2)
    expect(getStringWidth("🎉")).toBe(2)
  })

  test("ZWJ sequences count as 2 (one rendered cell)", () => {
    const family = "👨‍👩‍👧"
    expect(getStringWidth(family)).toBe(2)
  })

  test("skin-tone modifier clusters count as 2, not per-code-point sum", () => {
    // 🏃 + U+1F3FB 修饰符:终端渲染为单格双列(审查 M2:此前按码点求和计 4)
    const runner = "🏃🏻"
    expect(getStringWidth(runner)).toBe(2)
  })

  test("combining marks are zero-width (e + U+0301 renders as 1 column)", () => {
    expect(getStringWidth("é")).toBe(1)
  })

  test("box-drawing chars count as 1", () => {
    expect(getStringWidth("┌───┐")).toBe(5)
    expect(getStringWidth("├──────┤")).toBe(8)
  })

  test("variation selectors are zero-width", () => {
    // U+2764 ❤ + U+FE0F 变体选择符:渲染为单格 ❤️
    expect(getStringWidth("❤️")).toBe(2)
  })
})

describe("truncateWidth", () => {
  test("cuts CJK at the width boundary", () => {
    expect(truncateWidth("调研性能瓶颈", 6)).toBe("调研性")
  })

  test("never splits a surrogate pair", () => {
    // 6 宽放 3 个 emoji,截断结果必须是完整的 emoji
    const truncated = truncateWidth("🔥🔥🔥", 5)
    expect(truncated).toBe("🔥🔥")
    expect([...truncated].length).toBe(2)
  })

  test("keeps ZWJ sequences whole or drops them whole", () => {
    const family = "👨‍👩‍👧"
    expect(truncateWidth(family + "x", 2)).toBe(family)
    expect(truncateWidth(family + "x", 1)).toBe("")
  })

  test("maxWidth 0 or negative yields empty string", () => {
    expect(truncateWidth("abc", 0)).toBe("")
    expect(truncateWidth("abc", -1)).toBe("")
  })

  test("short text passes through untouched", () => {
    expect(truncateWidth("调研", 8)).toBe("调研")
  })
})

describe("padEndWidth", () => {
  test("pads ASCII to the target width", () => {
    expect(padEndWidth("ab", 4)).toBe("ab  ")
  })

  test("pads CJK-aware (2 columns per char)", () => {
    expect(getStringWidth(padEndWidth("调研", 6))).toBe(6)
  })

  test("no-op when already at or beyond the width", () => {
    expect(padEndWidth("abcdef", 4)).toBe("abcdef")
    expect(padEndWidth("abc", 3)).toBe("abc")
  })
})
