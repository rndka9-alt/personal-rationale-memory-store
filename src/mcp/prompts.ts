import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerPrompts(server: McpServer) {
  server.prompt("compose_task_context", {
    task: z.string().describe("Task that needs rationale context.")
  }, ({ task }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Compose rationale context for this task:\n\n${task}`
      }
    }]
  }));

  server.prompt("close_session_and_extract_rationales", {
    sessionSummary: z.string().describe("Summary of a completed work session.")
  }, ({ sessionSummary }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Extract rationale candidates from this session. Actively record anything that could help other tasks or later conversations — decisions, reasoning, preferences, lessons learned.\n\n${sessionSummary}`
      }
    }]
  }));
}
