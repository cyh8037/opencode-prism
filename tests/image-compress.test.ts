import { describe, expect, it } from "bun:test"
import { VISION_COMPRESS_DEFAULT_MAX_BYTES } from "../src/config/constants"
import { prismConfigSchema, visionCompressSchema } from "../src/config/schema"
import { parseConfig } from "../src/config/load"
import { compressImageBuffer } from "../src/core/vision/image-compress"
import { normalizeImageUrl, normalizeImageBatch } from "../src/core/vision/image-utils"
import { mkdtempSync, writeFileSync as writeSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("vision.compress schema", () => {
  it("defaults to true with 100KB", () => {
    const parsed = visionCompressSchema.parse(undefined)
    expect(parsed).toEqual({ enabled: true, maxBytes: 100 * 1024 })
  })

  it("accepts boolean true", () => {
    const parsed = visionCompressSchema.parse(true)
    expect(parsed).toEqual({ enabled: true, maxBytes: 100 * 1024 })
  })

  it("accepts boolean false", () => {
    const parsed = visionCompressSchema.parse(false)
    expect(parsed).toEqual({ enabled: false, maxBytes: 100 * 1024 })
  })

  it("accepts custom positive number as byte threshold", () => {
    const parsed = visionCompressSchema.parse(50 * 1024)
    expect(parsed).toEqual({ enabled: true, maxBytes: 50 * 1024 })
  })

  it("re-parses transformed object idempotently without error", () => {
    const initial = visionCompressSchema.parse(true)
    const second = visionCompressSchema.parse(initial)
    expect(second).toEqual(initial)
  })

  it("integrates into parseConfig with default compress enabled", () => {
    const cfg = parseConfig({})
    expect(cfg.vision.compress).toEqual({ enabled: true, maxBytes: 100 * 1024 })
  })

  it("integrates into parseConfig with compress disabled", () => {
    const cfg = parseConfig({ vision: { compress: false } })
    expect(cfg.vision.compress).toEqual({ enabled: false, maxBytes: 100 * 1024 })
  })

  it("integrates into parseConfig with numeric compress value", () => {
    const cfg = parseConfig({ vision: { compress: 51200 } })
    expect(cfg.vision.compress).toEqual({ enabled: true, maxBytes: 51200 })
  })
})

describe("compressImageBuffer", () => {
  const smallPngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNk+M9Qz0AEYBxVSF+FAAhKDveksOjuAAAAAElFTkSuQmCC"
  const smallPngBuffer = Buffer.from(smallPngBase64, "base64")

  it("returns original buffer if size is within maxBytes limit", async () => {
    const res = await compressImageBuffer(smallPngBuffer, "image/png", {
      enabled: true,
      maxBytes: 100 * 1024,
    })
    expect(res.buffer).toBe(smallPngBuffer)
    expect(res.mime).toBe("image/png")
  })

  it("returns original buffer if compression is disabled", async () => {
    const res = await compressImageBuffer(smallPngBuffer, "image/png", {
      enabled: false,
      maxBytes: 10,
    })
    expect(res.buffer).toBe(smallPngBuffer)
    expect(res.mime).toBe("image/png")
  })

  it("gracefully falls back to original buffer on corrupted/invalid data", async () => {
    const corruptBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00])
    const res = await compressImageBuffer(corruptBuffer, "image/png", {
      enabled: true,
      maxBytes: 1,
    })
    expect(res.buffer).toBe(corruptBuffer)
    expect(res.mime).toBe("image/png")
  })

  it("compresses a large image down to within maxBytes limit", async () => {
    const img = new Bun.Image(smallPngBuffer)
    const largePng = Buffer.from(await img.resize(1200, 1200, { fit: "fill" }).png().bytes())
    expect(largePng.length).toBeGreaterThan(5000)

    // Set targetMax smaller than largePng.length to trigger compression
    const targetMax = 3 * 1024
    const res = await compressImageBuffer(largePng, "image/png", {
      enabled: true,
      maxBytes: targetMax,
    })
    expect(res.buffer.length).toBeLessThanOrEqual(targetMax)
    expect(["image/webp", "image/jpeg"]).toContain(res.mime)
  })
})

describe("normalizeImageUrl with compression", () => {
  const smallPngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNk+M9Qz0AEYBxVSF+FAAhKDveksOjuAAAAAElFTkSuQmCC"
  const smallPngBuffer = Buffer.from(smallPngBase64, "base64")

  it("preserves small data URL without re-encoding when <= maxBytes", async () => {
    const dataUrl = `data:image/png;base64,${smallPngBase64}`
    const normalized = await normalizeImageUrl(
      { mime: "image/png", url: dataUrl },
      undefined,
      { enabled: true, maxBytes: 100 * 1024 },
    )
    expect(normalized).not.toBeNull()
    expect(normalized?.mime).toBe("image/png")
    expect(normalized?.url).toBe(dataUrl)
  })

  it("compresses large local image file when exceeds maxBytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prism-compress-test-"))
    try {
      const img = new Bun.Image(smallPngBuffer)
      const largePng = Buffer.from(await img.resize(1200, 1200, { fit: "fill" }).png().bytes())
      const filePath = join(dir, "large.png")
      writeSync(filePath, largePng)

      const targetMax = 3 * 1024
      const normalized = await normalizeImageUrl(
        { mime: "image/png", url: filePath },
        dir,
        { enabled: true, maxBytes: targetMax },
      )
      expect(normalized).not.toBeNull()
      expect(["image/webp", "image/jpeg"]).toContain(normalized?.mime ?? "")
      const comma = normalized?.url.indexOf(",") ?? -1
      const payloadLen = (normalized?.url.length ?? 0) - comma - 1
      const decodedBytes = Math.floor((payloadLen * 3) / 4)
      expect(decodedBytes).toBeLessThanOrEqual(targetMax)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
