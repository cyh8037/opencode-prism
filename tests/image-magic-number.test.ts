import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isValidImageMagicNumber, normalizeImageUrl } from "../src/core/vision/image-utils"

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
const GIF87 = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) // GIF87a
const GIF89 = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]) // GIF89a
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]) // RIFF....WEBP
const TEXT = new Uint8Array(Buffer.from("just a log file, not an image"))

describe("isValidImageMagicNumber", () => {
  test("accepts the four supported signatures", () => {
    expect(isValidImageMagicNumber(PNG)).toBe(true)
    expect(isValidImageMagicNumber(JPEG)).toBe(true)
    expect(isValidImageMagicNumber(GIF87)).toBe(true)
    expect(isValidImageMagicNumber(GIF89)).toBe(true)
    expect(isValidImageMagicNumber(WEBP)).toBe(true)
  })

  test("rejects non-image content regardless of the claimed extension", () => {
    expect(isValidImageMagicNumber(TEXT)).toBe(false)
    // GIF signature corrupted at the last byte: "GIF9" is not GIF8
    expect(isValidImageMagicNumber(new Uint8Array([0x47, 0x49, 0x46, 0x39]))).toBe(false)
    // RIFF container whose form type is not WEBP (e.g. WAVE audio)
    const wave = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45])
    expect(isValidImageMagicNumber(wave)).toBe(false)
    // WEBP marker on a truncated RIFF header (<12 bytes)
    expect(isValidImageMagicNumber(WEBP.slice(0, 8))).toBe(false)
  })

  test("rejects buffers shorter than the shortest signature", () => {
    expect(isValidImageMagicNumber(new Uint8Array(0))).toBe(false)
    expect(isValidImageMagicNumber(new Uint8Array([0x89]))).toBe(false)
    expect(isValidImageMagicNumber(new Uint8Array([0x89, 0x50]))).toBe(false)
    expect(isValidImageMagicNumber(new Uint8Array([0x89, 0x50, 0x4e]))).toBe(false)
    expect(isValidImageMagicNumber(new Uint8Array([0xff, 0xd8]))).toBe(false)
  })
})

// End-to-end guard for the failure mode the sniff exists for: a tool writes
// log/binary output named "*.png"; sending those bytes to a vision provider
// used to fail the whole provider request (400 invalid image format). The
// file is now skipped while genuine images in the same batch still pass.
describe("fake-extension local files", () => {
  test("a text file named .png is skipped, a real PNG is accepted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prism-magic-"))
    try {
      writeFileSync(join(dir, "fake.png"), TEXT)
      writeFileSync(join(dir, "real.png"), PNG)
      expect(await normalizeImageUrl({ mime: "image/png", url: "fake.png" }, dir)).toBeNull()
      const ok = await normalizeImageUrl({ mime: "image/png", url: "real.png" }, dir)
      expect(ok?.mime).toBe("image/png")
      expect(ok?.url.startsWith("data:image/png;base64,")).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("each supported real format passes under its extension", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prism-magic-"))
    try {
      writeFileSync(join(dir, "a.jpg"), JPEG)
      writeFileSync(join(dir, "b.gif"), GIF89)
      writeFileSync(join(dir, "c.webp"), WEBP)
      expect((await normalizeImageUrl({ mime: "image/jpeg", url: "a.jpg" }, dir))?.mime).toBe("image/jpeg")
      expect((await normalizeImageUrl({ mime: "image/gif", url: "b.gif" }, dir))?.mime).toBe("image/gif")
      expect((await normalizeImageUrl({ mime: "image/webp", url: "c.webp" }, dir))?.mime).toBe("image/webp")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
