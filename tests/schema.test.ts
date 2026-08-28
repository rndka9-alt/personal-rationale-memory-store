import { describe, expect, it } from "vitest";
import {
  applyEntryLifecycleOverlay,
  autoCaptureRationaleInputSchema,
  memoryUsageEventTypeSchema,
  noteSourceConversationSchema,
  rateNoteInputSchema,
  recordNoteInputSchema,
  recordUsageFeedbackInputSchema,
  rationaleEntrySchema,
  storedNoteSourceConversationSchema,
  type MemoryEntryRecord
} from "../src/memory/schema.js";

describe("rationaleEntrySchema", () => {
  it("requires rationale-centered content", () => {
    const entry = rationaleEntrySchema.parse({
      frontmatter: {
        id: "R2026-04-30-001",
        type: "rationale",
        status: "candidate",
        acceptanceState: "candidate",
        reviewState: "unreviewed",
        decisionState: "unknown",
        scope: "general",
        domains: ["development"],
        intents: ["design"],
        modes: ["planning"],
        confidence: 0.8,
        project: {
          name: "personal-rationale-memory-store",
          repo: "maetdol/personal-rationale-memory-store"
        },
        metadata: {}
      },
      title: "Prefer rationale over bare decisions",
      body: "The reusable reason matters more than the final decision."
    });

    expect(entry.frontmatter.id).toBe("R2026-04-30-001");
    expect(entry.frontmatter.project?.name).toBe("personal-rationale-memory-store");
    expect(entry.frontmatter.acceptanceState).toBe("candidate");
    expect(entry.frontmatter.reviewState).toBe("unreviewed");
    expect(entry.frontmatter.decisionState).toBe("unknown");
    expect(entry.body).toContain("reusable reason");
  });
});

describe("autoCaptureRationaleInputSchema", () => {
  it("accepts captures with a title and body", () => {
    const input = autoCaptureRationaleInputSchema.parse({
      title: "Capture reusable rationale",
      body: "Boundary information belongs in the document body when it matters."
    });

    expect(input.body).toContain("document body");
  });

  it("requires a non-blank body", () => {
    expect(() => autoCaptureRationaleInputSchema.parse({
      title: "Capture without body"
    })).toThrow();
    expect(() => autoCaptureRationaleInputSchema.parse({
      title: "Capture blank body",
      body: "   "
    })).toThrow();
  });

  it("does not accept a caller-assigned memory type", () => {
    const input = autoCaptureRationaleInputSchema.parse({
      title: "Prefer fail-fast over silent fallback",
      body: "Silent fallbacks hide corrupted data until it is expensive to repair.",
      type: "preference"
    });

    expect(input).not.toHaveProperty("type");
  });
});

describe("memoryUsageEventTypeSchema", () => {
  it("accepts composed usage and rejects unknown event types", () => {
    expect(memoryUsageEventTypeSchema.parse("composed")).toBe("composed");
    expect(() => memoryUsageEventTypeSchema.parse("previewed")).toThrow();
  });
});

describe("recordUsageFeedbackInputSchema", () => {
  it("accepts explicit feedback events and rejects passive retrieval events", () => {
    const feedback = recordUsageFeedbackInputSchema.parse({
      id: "V2026-05-19-001",
      eventType: "user_helpful"
    });

    expect(feedback.eventType).toBe("user_helpful");
    expect(() => recordUsageFeedbackInputSchema.parse({
      id: "V2026-05-19-001",
      eventType: "composed"
    })).toThrow();
  });
});

describe("note input schemas", () => {
  it("accepts notes with optional source context and rejects blank or overlong content", () => {
    const input = recordNoteInputSchema.parse({
      content: "쭈인님은 노트 원문을 요약 없이 보관하길 원한다.",
      topic: "노트 provenance 설계",
      sourceConversation: {
        messages: [
          { role: "user", text: "노트가 꽤 재밌게 저장되더라구..." },
          { role: "assistant", text: "그때 분위기를 보는 쪽이 좋겟어요." }
        ]
      }
    });

    expect(input.content).toContain("요약 없이");
    expect(input.topic).toBe("노트 provenance 설계");
    expect(input.sourceConversation?.messages[0]?.role).toBe("user");
    expect(() => recordNoteInputSchema.parse({ content: "   " })).toThrow();
    expect(() => recordNoteInputSchema.parse({ content: "x".repeat(1001) })).toThrow();
    expect(() => recordNoteInputSchema.parse({
      content: "invalid role",
      topic: "역할 검증",
      sourceConversation: { messages: [{ role: "system", text: "hidden" }] }
    })).toThrow();
    // topic이 필수가 됐음을 확인: content만으로는 통과하지 못한다.
    expect(() => recordNoteInputSchema.parse({ content: "topic 없이 기록" })).toThrow();
  });

  it("accepts note rating values", () => {
    expect(rateNoteInputSchema.parse({ slot: "a3", rating: "up" }).rating).toBe("up");
    expect(() => rateNoteInputSchema.parse({ slot: "a3", rating: "sideways" })).toThrow();
  });

  it("rejects broken Unicode from hand-transcribed escapes before it reaches storage", () => {
    const loneSurrogate = "\uD835 잘린 서로게이트";
    const replacementCharacter = "오염된 � 문자";

    expect(() => recordNoteInputSchema.parse({ content: loneSurrogate, topic: "검증" })).toThrow(/literal characters/);
    expect(() => recordNoteInputSchema.parse({ content: "정상", topic: replacementCharacter })).toThrow(/literal characters/);
    expect(() => recordNoteInputSchema.parse({
      content: "정상",
      topic: "검증",
      sourceConversation: { messages: [{ role: "user", text: loneSurrogate }] }
    })).toThrow(/literal characters/);
    expect(recordNoteInputSchema.parse({ content: "이모지 🐛 정상 서로게이트 쌍", topic: "검증" }).content).toContain("🐛");
  });

  it("reads back stored source conversations that predate the Unicode guard", () => {
    // 실제 오염 데이터 형태: 한글 한 글자가 바이트 단위로 잘려 각 바이트가 U+FFFD로 치환됐다.
    const storedConversation = { messages: [{ role: "user", text: "일단 넣어놓야���!!" }] };

    expect(() => noteSourceConversationSchema.parse(storedConversation)).toThrow(/literal characters/);
    expect(storedNoteSourceConversationSchema.parse(storedConversation).messages[0].text).toContain("넣어놓야");
  });

  it("still rejects structurally broken stored source conversations", () => {
    expect(() => storedNoteSourceConversationSchema.parse({ messages: [{ role: "narrator", text: "정상" }] })).toThrow();
    expect(() => storedNoteSourceConversationSchema.parse({ messages: [{ role: "user", text: 42 }] })).toThrow();
    expect(() => storedNoteSourceConversationSchema.parse({ messages: "정상" })).toThrow();
  });

  it("guards rationale write inputs against broken Unicode", () => {
    expect(() => autoCaptureRationaleInputSchema.parse({
      title: "제목 \uDD35 깨짐",
      body: "정상 본문"
    })).toThrow(/literal characters/);
    expect(() => autoCaptureRationaleInputSchema.parse({
      title: "정상 제목",
      body: "본문에 \u0000 널 문자"
    })).toThrow(/literal characters/);
  });
});

describe("applyEntryLifecycleOverlay", () => {
  function createSnapshotEntry(metadata: Record<string, unknown> = {}) {
    return rationaleEntrySchema.parse({
      frontmatter: {
        id: "R20260828T000000000Z-abc123",
        type: "rationale",
        status: "candidate",
        acceptanceState: "candidate",
        reviewState: "unreviewed",
        decisionState: "unknown",
        scope: "general",
        domains: ["development"],
        intents: ["design"],
        modes: ["planning"],
        confidence: 0.8,
        metadata: { capture_kind: "auto", ...metadata }
      },
      title: "Snapshot title",
      body: "Snapshot body."
    });
  }

  function createEntryRecord(overrides: Partial<MemoryEntryRecord> = {}): MemoryEntryRecord {
    return {
      id: "R20260828T000000000Z-abc123",
      type: "rationale",
      status: "candidate",
      acceptanceState: "candidate",
      reviewState: "unreviewed",
      decisionState: "unknown",
      title: "Snapshot title",
      canonicalPath: "data/memory/rationales/R20260828T000000000Z-abc123.md",
      scope: "general",
      confidence: 0.8,
      useCount: 0,
      metadata: {},
      ...overrides
    };
  }

  it("overlays deprecation state and lifecycle metadata from the entry record", () => {
    const entry = createSnapshotEntry();
    const record = createEntryRecord({
      status: "deprecated",
      acceptanceState: "deprecated",
      deprecatedBy: "R20260828T111111111Z-repl01",
      metadata: {
        deprecation_reason: "새 분석으로 대체됨",
        replacement_id: "R20260828T111111111Z-repl01",
        pre_deprecation_acceptance_state: "accepted"
      }
    });

    const overlaid = applyEntryLifecycleOverlay(entry, record);

    expect(overlaid.frontmatter.acceptanceState).toBe("deprecated");
    expect(overlaid.frontmatter.status).toBe("deprecated");
    expect(overlaid.frontmatter.deprecatedBy).toBe("R20260828T111111111Z-repl01");
    expect(overlaid.frontmatter.metadata.deprecation_reason).toBe("새 분석으로 대체됨");
    expect(overlaid.frontmatter.metadata.pre_deprecation_acceptance_state).toBe("accepted");
    expect(overlaid.frontmatter.metadata.capture_kind).toBe("auto");
    expect(overlaid.title).toBe("Snapshot title");
    expect(overlaid.body).toBe("Snapshot body.");
  });

  it("clears stale lifecycle metadata when the entry record was restored", () => {
    const entry = createSnapshotEntry({
      deprecation_reason: "리비전에 남은 옛 사유",
      replacement_id: "R20260828T111111111Z-repl01",
      pre_deprecation_acceptance_state: "accepted"
    });
    entry.frontmatter.deprecatedBy = "R20260828T111111111Z-repl01";
    const record = createEntryRecord({
      status: "accepted",
      acceptanceState: "accepted",
      metadata: { restore_reason: "잘못 폐기해서 복원" }
    });

    const overlaid = applyEntryLifecycleOverlay(entry, record);

    expect(overlaid.frontmatter.acceptanceState).toBe("accepted");
    expect(overlaid.frontmatter.deprecatedBy).toBeUndefined();
    expect(overlaid.frontmatter.metadata.deprecation_reason).toBeUndefined();
    expect(overlaid.frontmatter.metadata.replacement_id).toBeUndefined();
    expect(overlaid.frontmatter.metadata.pre_deprecation_acceptance_state).toBeUndefined();
    expect(overlaid.frontmatter.metadata.restore_reason).toBe("잘못 폐기해서 복원");
  });

  it("overlays promotion state from the entry record", () => {
    const entry = createSnapshotEntry();
    const record = createEntryRecord({
      type: "principle",
      status: "accepted",
      acceptanceState: "accepted",
      promotedTo: "principle",
      metadata: { promoted_reason: "반복 검증된 원칙" }
    });

    const overlaid = applyEntryLifecycleOverlay(entry, record);

    expect(overlaid.frontmatter.type).toBe("principle");
    expect(overlaid.frontmatter.promotedTo).toBe("principle");
    expect(overlaid.frontmatter.metadata.promoted_reason).toBe("반복 검증된 원칙");
  });
});
