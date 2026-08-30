// Defenses for internal message injection. Every injected message goes
// through the PromptGate (see Invariant #2), and the injected templates wrap
// UNTRUSTED text — child task outputs and subtask results — that must not be
// able to break out of the template structure. Child models can emit an
// arbitrary string; a "</system-reminder>" inside a result would close the
// gate's reminder block early and let the remaining text read as real system
// instructions to the parent model (prompt injection through the plugin).

// Escape the reminder close tag in untrusted text. The "</" -> "<\/" rewrite
// is the same trick used for embedding untrusted text in XML-like contexts:
// it keeps the bytes readable while making the exact close sequence
// unmatchable. Case-insensitive: a model emitting "</SYSTEM-REMINDER>" must
// be neutralized too.
export function sanitizeSystemReminder(text: string): string {
  // Whitespace-tolerant: the close-tag consumer is the parent MODEL, not a
  // parser — "</system-reminder >" or "</ system-reminder>" can read as the
  // block's end just as well as the canonical form. Every fuzzed variant is
  // rewritten to the one canonical escaped form (what column measurement
  // sees too: sanitize always runs before width computation).
  return text.replace(/<\/\s*system-reminder\s*>/gi, "<\\/system-reminder>")
}
