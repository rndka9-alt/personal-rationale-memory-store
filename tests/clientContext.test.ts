import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { readClientContext, runWithClientContext } from "../src/diagnostics/clientContext.js";
import { recordRetrievalQueryEvent } from "../src/db/queries.js";

describe("clientContext", () => {
  it("propagates the context across await boundaries and stays empty outside", async () => {
    expect(readClientContext()).toBeUndefined();

    const observed = await runWithClientContext(
      { clientName: "claude-code", clientVersion: "2.1.0", userAgent: "claude-code/2.1.0" },
      async () => {
        await Promise.resolve();
        return readClientContext();
      }
    );

    expect(observed).toEqual({
      clientName: "claude-code",
      clientVersion: "2.1.0",
      userAgent: "claude-code/2.1.0"
    });
    expect(readClientContext()).toBeUndefined();
  });

  it("keeps concurrent contexts isolated per run", async () => {
    const [first, second] = await Promise.all([
      runWithClientContext({ clientName: "claude-code" }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return readClientContext()?.clientName;
      }),
      runWithClientContext({ clientName: "chatgpt" }, async () => {
        return readClientContext()?.clientName;
      })
    ]);

    expect(first).toBe("claude-code");
    expect(second).toBe("chatgpt");
  });
});

describe("recordRetrievalQueryEvent client metadata", () => {
  it("writes client columns when the insert payload carries them", async () => {
    const pool = new pg.Pool();
    const query = vi.spyOn(pool, "query").mockImplementation(async () => ({
      rows: [],
      rowCount: 0,
      command: "INSERT",
      oid: 0,
      fields: []
    }));

    await recordRetrievalQueryEvent(pool, {
      sourceKind: "compose",
      query: "compose_context 클라이언트 식별 테스트",
      resultCount: 3,
      warningKinds: [],
      clientName: "claude-code",
      clientVersion: "2.1.0",
      userAgent: "claude-code/2.1.0"
    });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, values] = query.mock.calls[0];
    expect(String(sql)).toContain("client_name, client_version, user_agent");
    expect(values.slice(-3)).toEqual(["claude-code", "2.1.0", "claude-code/2.1.0"]);
  });
});
