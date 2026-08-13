import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { handleOAuthRequest, OAuthAuthorizationServer } from "../src/mcp/oauth.js";

describe("OAuth HTTP boundary", () => {
  it("adds no-store and browser hardening headers to the authorization form", async () => {
    await withOAuthHttpServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/oauth/authorize?${createAuthorizationParams()}`, {
        headers: { "cf-connecting-ip": "198.51.100.10" }
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
    });
  });

  it("rejects oversized OAuth form bodies", async () => {
    await withOAuthHttpServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/oauth/token`, {
        method: "POST",
        headers: {
          "cf-connecting-ip": "198.51.100.11",
          "content-type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({ padding: "x".repeat(17 * 1024) })
      });

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
    });
  });

  it("rate limits repeated authorization attempts from one client", async () => {
    await withOAuthHttpServer(async (baseUrl) => {
      const requestBody = createAuthorizationParams();
      requestBody.set("login_code", "wrong-code");

      for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await fetch(`${baseUrl}/oauth/authorize`, {
          method: "POST",
          headers: {
            "cf-connecting-ip": "198.51.100.12",
            "content-type": "application/x-www-form-urlencoded"
          },
          body: requestBody
        });
        expect(response.status).toBe(401);
      }

      const limitedResponse = await fetch(`${baseUrl}/oauth/authorize`, {
        method: "POST",
        headers: {
          "cf-connecting-ip": "198.51.100.12",
          "content-type": "application/x-www-form-urlencoded"
        },
        body: requestBody
      });

      expect(limitedResponse.status).toBe(429);
      expect(limitedResponse.headers.get("retry-after")).not.toBeNull();
    });
  });
});

async function withOAuthHttpServer(run: (baseUrl: string) => Promise<void>) {
  const oauthServer = createOAuthServer();
  const server = createServer(async (request, response) => {
    if (await handleOAuthRequest(request, response, oauthServer)) {
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(readServerBaseUrl(server));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

function readServerBaseUrl(server: Server) {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("OAuth test server did not bind to a TCP port.");
  }
  return `http://127.0.0.1:${address.port}`;
}

function createOAuthServer() {
  return new OAuthAuthorizationServer({
    issuer: "https://memory-mcp.mtdl.kr",
    clientId: "mtdl-memory-mcp",
    redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
    loginCode: "test-login-code",
    signingPrivateKeyPem: undefined,
    accessTokenTtlSeconds: 3600,
    loginSessionTtlSeconds: 3600,
    userSubject: "mtdl",
    scopes: ["rationale:read", "rationale:write"],
    requiredScopes: ["rationale:read", "rationale:write"]
  });
}

function createAuthorizationParams() {
  return new URLSearchParams({
    response_type: "code",
    client_id: "mtdl-memory-mcp",
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    scope: "rationale:read rationale:write",
    state: "test-state"
  });
}
