import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expandLocalPath, normalizeImageBatch, normalizeImageUrl } from "../src/core/vision/image-utils"
import { VISION_IMAGE_MAX_BYTES } from "../src/config/constants"

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const PNG_DATA_URL = `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`

const originalFetch = globalThis.fetch
const fetchCalls: string[] = []

function stubFetch(responder: (url: string) => Response): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof URL ? input : typeof input === "string" ? input : input.url)
    fetchCalls.push(url)
    return responder(url)
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
  fetchCalls.length = 0
})

describe("normalizeImageUrl protocol safety", () => {
  test("rejects file:// URLs without fetching (no arbitrary local file read)", async () => {
    stubFetch(() => new Response(PNG_BYTES))
    const result = await normalizeImageUrl({ mime: "image/png", url: "file:///etc/hosts.png" })
    expect(result).toBeNull()
    expect(fetchCalls).toHaveLength(0)
  })

  test("rejects other non-http(s) protocols", async () => {
    stubFetch(() => new Response(PNG_BYTES))
    expect(await normalizeImageUrl({ mime: "image/png", url: "ftp://example.com/a.png" })).toBeNull()
    expect(await normalizeImageUrl({ mime: "image/png", url: "gopher://example.com/a.png" })).toBeNull()
    expect(fetchCalls).toHaveLength(0)
  })

  test("accepts https URLs and converts them to data URLs", async () => {
    stubFetch(() => new Response(PNG_BYTES))
    const result = await normalizeImageUrl({ mime: "image/png", url: "https://example.com/a.png" })
    expect(result?.mime).toBe("image/png")
    expect(result?.url.startsWith("data:image/png;base64,")).toBe(true)
    expect(fetchCalls).toEqual(["https://example.com/a.png"])
  })

  test("rejects an unparsable URL without fetching", async () => {
    stubFetch(() => new Response(PNG_BYTES))
    expect(await normalizeImageUrl({ mime: "image/png", url: "not a url" })).toBeNull()
    expect(fetchCalls).toHaveLength(0)
  })
})

describe("normalizeImageUrl data URLs", () => {
  test("valid image data URL passes with the sniffed mime", async () => {
    stubFetch(() => new Response(PNG_BYTES))
    const result = await normalizeImageUrl({ mime: "image/png", url: PNG_DATA_URL })
    expect(result?.mime).toBe("image/png")
    expect(result?.url).toBe(PNG_DATA_URL)
    expect(fetchCalls).toHaveLength(0)
  })

  test("claimed mime is not trusted: non-image content is rejected by the sniff", async () => {
    const fake = `data:image/png;base64,${Buffer.from("definitely not an image").toString("base64")}`
    expect(await normalizeImageUrl({ mime: "image/png", url: fake })).toBeNull()
  })

  test("oversized data URL is rejected before decode", async () => {
    // base64 length above the 4MB-equivalent threshold
    const oversized = `data:image/png;base64,${"A".repeat(6_000_000)}`
    expect(await normalizeImageUrl({ mime: "image/png", url: oversized })).toBeNull()
  })
})

describe("normalizeImageUrl local paths", () => {
  test("windows-style relative path (.\\shot.png) is recognized as a local file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prism-img-"))
    try {
      writeFileSync(join(dir, "shot.png"), PNG_BYTES)
      stubFetch(() => new Response(PNG_BYTES))
      const result = await normalizeImageUrl({ mime: "image/png", url: ".\\shot.png" }, dir)
      expect(result?.mime).toBe("image/png")
      expect(result?.url.startsWith("data:image/png;base64,")).toBe(true)
      expect(fetchCalls).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("expandLocalPath", () => {
  // The regression: isLocalPath normalizes backslashes BEFORE matching "~/",
  // so "~\shot.png" is classified as a home path — expandLocalPath used to
  // check the raw string, missed the branch, and resolved to
  // <baseDir>/~/shot.png on every platform.
  test("windows-style home paths (~\\...) expand against home, not the project dir", () => {
    expect(expandLocalPath("~\\Pictures\\shot.png", "/work", "/home/tester")).toBe("/home/tester/Pictures/shot.png")
    expect(expandLocalPath("~/Pictures/shot.png", "/work", "/home/tester")).toBe("/home/tester/Pictures/shot.png")
    // mixed separators survive the same normalization
    expect(expandLocalPath("~/a\\b.png", "/work", "/home/tester")).toBe("/home/tester/a/b.png")
  })

  test("absolute and drive-letter paths pass through unchanged", () => {
    expect(expandLocalPath("/abs/shot.png", "/work", "/home/tester")).toBe("/abs/shot.png")
    expect(expandLocalPath("C:\\Users\\j\\shot.png", "/work", "/home/tester")).toBe("C:\\Users\\j\\shot.png")
    expect(expandLocalPath("\\\\server\\share\\shot.png", "/work", "/home/tester")).toBe("\\\\server\\share\\shot.png")
  })
})

describe("normalizeImageUrl remote size limits", () => {
  test("a Content-Length over the cap is rejected from the header alone", async () => {
    stubFetch(
      () =>
        new Response(PNG_BYTES, {
          headers: { "content-length": String(VISION_IMAGE_MAX_BYTES + 1) },
        }),
    )
    const result = await normalizeImageUrl({ mime: "image/png", url: "https://example.com/big.png" })
    expect(result).toBeNull()
  })
})

describe("normalizeImageUrl streaming truncation", () => {
  // Chunked responses carry no Content-Length, so the header check cannot
  // reject them — the streaming reader must. A naive arrayBuffer() would
  // buffer the whole (arbitrarily large) body into memory before rejecting.
  test("a chunked body over the cap aborts the download, never buffering it", async () => {
    let cancelled = false
    const chunk = new Uint8Array(1024 * 1024) // 1MB chunks
    // An ENDLESS chunked stream (never closed): only the reader's cancel at
    // the cap ends the test — if the cap logic regressed, the read would
    // hang and the test would fail by timeout instead of silently passing.
    // (Calling close() in the source would make reader.cancel() a no-op per
    // the streams spec, so the cancel callback could never fire.)
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk)
      },
      cancel() {
        cancelled = true
      },
    })
    stubFetch(() => new Response(stream, { status: 200 }))
    const result = await normalizeImageUrl({ mime: "image/png", url: "https://example.com/chunked.png" })
    expect(result).toBeNull()
    expect(cancelled).toBe(true) // the reader cancelled the transfer at the cap
  })

  test("a chunked body within the cap is still read and accepted", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(PNG_BYTES)
        controller.close()
      },
    })
    stubFetch(() => new Response(stream, { status: 200 }))
    const result = await normalizeImageUrl({ mime: "image/png", url: "https://example.com/small-chunked.png" })
    expect(result?.mime).toBe("image/png")
    expect(result?.url.startsWith("data:image/png;base64,")).toBe(true)
  })
})

describe("normalizeImageBatch total cap", () => {
  // Providers cap the whole inline request (Gemini at 20MB) — the cap is on
  // the encoded payload, and the images that fit are kept, the tail dropped.
  const pngOfEncodedLength = (encodedLen: number): string => {
    const raw = Math.floor((encodedLen * 3) / 4)
    const bytes = new Uint8Array(raw)
    bytes.set(PNG_BYTES.subarray(0, Math.min(PNG_BYTES.length, raw)))
    return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`
  }

  test("keeps the images that fit and drops the rest", async () => {
    stubFetch(() => new Response(PNG_BYTES))
    // ~3.4MB raw each: within the per-image cap, but three of them exceed the
    // 16MB encoded batch cap together with a fourth.
    const perImage = 4_500_000
    const images = [1, 2, 3, 4].map(() => ({ mime: "image/png", url: pngOfEncodedLength(perImage) }))
    const kept = await normalizeImageBatch(images)
    expect(kept).toHaveLength(3)
  })

  test("a small batch passes through untouched", async () => {
    stubFetch(() => new Response(PNG_BYTES))
    const kept = await normalizeImageBatch([{ mime: "image/png", url: PNG_DATA_URL }])
    expect(kept).toHaveLength(1)
    expect(kept[0]?.url).toBe(PNG_DATA_URL)
  })
})
