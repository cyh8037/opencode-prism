import { randomUUID } from "node:crypto"

// Part ids for parts injected from hooks (chat.message). opencode 1.18.23
// requires a "prt" prefix ("Expected a string starting with \"prt\"" at save)
// and MessageV2.parts orders rows by PartTable.id (string order), so an
// injected part's id must sort AFTER the original parts' ids. Mimic
// opencode's own Identifier.ascending() encoding exactly — 6-byte big-endian
// (ts*0x1000 + per-ms counter) mod 2^48 — with the counter at its max, so a
// same-millisecond injection still sorts last. (A naive ts-mod-2^48 encoding
// does NOT sort after opencode ids: the shift changes the leading nibbles.)
// The random suffix only disambiguates retries.
export function makePartID(): string {
  const t = BigInt(Date.now())
  const encoded = ((t % 2n ** 36n) << 12n) + 0xfffn // per-ms counter at max
  return `prt_${encoded.toString(16).padStart(12, "0")}${randomUUID().slice(0, 8)}`
}
