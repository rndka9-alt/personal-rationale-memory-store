import { describe, expect, it } from "vitest";
import { fingerprintRationaleContent } from "../src/memory/rationaleContentFingerprint.js";

describe("rationale content fingerprint", () => {
  it("ignores metadata, source, and project context", () => {
    const first = fingerprintRationaleContent({
      title: "Prefer content-addressed dedupe",
      rationale: "Identical rationale content should reuse the existing memory.",
      source: { kind: "session", ref: "first-session" },
      project: { name: "first-project" },
      metadata: {
        session_ref: "first-session",
        captured_at: "2026-06-08T00:00:00.000Z"
      }
    });
    const second = fingerprintRationaleContent({
      title: "Prefer content-addressed dedupe",
      rationale: "Identical rationale content should reuse the existing memory.",
      source: { kind: "session", ref: "second-session" },
      project: { name: "second-project" },
      metadata: {
        session_ref: "second-session",
        captured_at: "2026-06-08T01:00:00.000Z"
      }
    });

    expect(second).toBe(first);
  });

  it("normalizes line endings and surrounding whitespace", () => {
    const first = fingerprintRationaleContent({
      title: "  Keep one memory  ",
      rationale: "A duplicated rationale should not crowd search results.\r\n"
    });
    const second = fingerprintRationaleContent({
      title: "Keep one memory",
      rationale: "A duplicated rationale should not crowd search results."
    });

    expect(second).toBe(first);
  });

  it("changes when meaningful rationale content changes", () => {
    const first = fingerprintRationaleContent({
      title: "Keep one memory",
      rationale: "A duplicated rationale should not crowd search results."
    });
    const second = fingerprintRationaleContent({
      title: "Keep one memory",
      rationale: "A distinct rationale should remain searchable.",
      tradeoff: "The review queue may contain more candidates."
    });

    expect(second).not.toBe(first);
  });
});
