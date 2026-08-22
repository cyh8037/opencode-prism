import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { normalizeImageUrl } from "../src/core/vision/image-utils"

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
    // base64 length above the 8MB-equivalent threshold (~11.2M chars)
    const oversized = `data:image/png;base64,${"A".repeat(12_000_000)}`
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
