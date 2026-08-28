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
  return text.replace(/<\/system-reminder>/gi, "<\\/system-reminder>")
}
