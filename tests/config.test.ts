import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("MCP authentication configuration", () => {
  it("rejects an HTTP server without an authentication method", () => {
    expect(() => loadConfig({ MCP_TRANSPORT: "http" })).toThrow(
      "MCP_AUTH_TOKEN or MCP_OAUTH_ENABLED=true is required"
    );
  });

  it("allows an HTTP server with a static bearer token", () => {
    const config = loadConfig({
      MCP_TRANSPORT: "http",
      MCP_AUTH_TOKEN: "test-auth-token"
    });

    expect(config.mcp.authToken).toBe("test-auth-token");
  });

  it("allows an HTTP server with OAuth enabled", () => {
    const config = loadConfig({
      MCP_TRANSPORT: "http",
      MCP_OAUTH_ENABLED: "true"
    });

    expect(config.mcp.oauth.enabled).toBe(true);
  });
});
