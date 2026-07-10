import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listActiveNotes } from "../src/db/queries.js";
import { NoteService } from "../src/memory/noteService.js";

vi.mock("../src/db/queries.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/db/queries.js")>();
  return {
    ...original,
    listActiveNotes: vi.fn()
  };
});

describe("composeNotesContext with digest disabled", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns the existing note-only output unchanged", async () => {
    vi.mocked(listActiveNotes).mockResolvedValue([{
      id: "note-1",
      content: "원문 쪽지",
      upvotes: 0,
      downvotes: 0,
      archived: false,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z"
    }]);
    const service = new NoteService(new pg.Pool());

    await expect(service.composeNotesContext()).resolves.toBe(
      "━━━ 00 ━━━\n원문 쪽지\n\n도움이 됐거나 별로였던 쪽지는 rate_note로 평가해 주세요 (slot: 각 ━━━ 헤더의 값, rating: \"up\" 또는 \"down\")."
    );
  });

  it("prepends the stored digest and schedules refresh without awaiting it", async () => {
    vi.mocked(listActiveNotes).mockResolvedValue([{
      id: "note-1",
      content: "원문 쪽지",
      upvotes: 0,
      downvotes: 0,
      archived: false,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z"
    }]);
    let refreshed = false;
    const digestService = {
      getDigestSection: async () => "━━━ digest ━━━\n합성본",
      maybeRefreshInBackground: async () => {
        refreshed = true;
      }
    };
    const service = new NoteService(new pg.Pool(), digestService);

    const context = await service.composeNotesContext();

    expect(context.startsWith("━━━ digest ━━━\n합성본\n\n━━━ 00 ━━━")).toBe(true);
    expect(refreshed).toBe(false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(refreshed).toBe(true);
  });
});
