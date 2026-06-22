import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { OAuthAuthorizationServer } from "../src/mcp/oauth.js";

describe("OAuthAuthorizationServer", () => {
  it("publishes MCP OAuth and OpenID metadata", () => {
    const oauthServer = createOAuthServer();

    expect(oauthServer.getProtectedResourceMetadata()).toEqual({
      resource: "https://memory-mcp.mtdl.kr",
      authorization_servers: ["https://memory-mcp.mtdl.kr"],
      scopes_supported: ["openid", "email", "profile", "rationale:read", "rationale:write"],
      resource_documentation: "https://memory-mcp.mtdl.kr/"
    });

    expect(oauthServer.getOpenIdConfiguration()).toMatchObject({
      issuer: "https://memory-mcp.mtdl.kr",
      authorization_endpoint: "https://memory-mcp.mtdl.kr/oauth/authorize",
      token_endpoint: "https://memory-mcp.mtdl.kr/oauth/token",
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      userinfo_endpoint: "https://memory-mcp.mtdl.kr/oauth/userinfo"
    });
  });

  it("exchanges an authorization code for a verifiable bearer token", () => {
    const oauthServer = createOAuthServer();
    const codeVerifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
    const authorizationParams = new URLSearchParams({
      response_type: "code",
      client_id: "mtdl-memory-mcp",
      redirect_uri: "https://chatgpt.com/connector/oauth/ZT7uG4vEQ1CV",
      scope: "openid email profile rationale:read rationale:write",
      state: "state-1",
      code_challenge: createPkceChallenge(codeVerifier),
      code_challenge_method: "S256",
      resource: "https://memory-mcp.mtdl.kr",
      login_code: "test-login-code"
    });

    const authorizationResult = oauthServer.authorize(authorizationParams);
    const redirectUrl = authorizationResult.redirectUrl;
    const code = redirectUrl.searchParams.get("code");
    if (!code) {
      throw new Error("Authorization redirect did not include a code.");
    }

    const tokenResponse = oauthServer.exchangeToken(new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://chatgpt.com/connector/oauth/ZT7uG4vEQ1CV",
      client_id: "mtdl-memory-mcp",
      code_verifier: codeVerifier,
      resource: "https://memory-mcp.mtdl.kr"
    }));

    expect(tokenResponse.token_type).toBe("Bearer");
    expect(tokenResponse.expires_in).toBe(7 * 24 * 60 * 60);
    expect(tokenResponse.scope).toBe("openid email profile rationale:read rationale:write");
    expect(typeof tokenResponse.id_token).toBe("string");

    const accessToken = tokenResponse.access_token;
    if (typeof accessToken !== "string") {
      throw new Error("Token response did not include a string access token.");
    }
    expect(oauthServer.verifyBearerToken(accessToken)).toMatchObject({
      subject: "mtdl",
      email: "owner@example.com",
      name: "Rationale Memory Owner",
      scope: "openid email profile rationale:read rationale:write"
    });
  });

  it("accepts the ChatGPT authorization request shape without PKCE parameters", () => {
    const oauthServer = createOAuthServer();
    const authorizationParams = new URLSearchParams({
      response_type: "code",
      client_id: "mtdl-memory-mcp",
      redirect_uri: "https://chatgpt.com/connector/oauth/ZT7uG4vEQ1CV",
      scope: "openid email profile rationale:read rationale:write",
      resource: "https://memory-mcp.mtdl.kr",
      state: "oauth_s_6a2a1f5ff9b88191863311231bb163f1",
      ui_locales: "ko-KR",
      login_code: "test-login-code"
    });

    const authorizationResult = oauthServer.authorize(authorizationParams);
    const redirectUrl = authorizationResult.redirectUrl;
    const code = redirectUrl.searchParams.get("code");
    if (!code) {
      throw new Error("Authorization redirect did not include a code.");
    }

    const tokenResponse = oauthServer.exchangeToken(new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://chatgpt.com/connector/oauth/ZT7uG4vEQ1CV",
      client_id: "mtdl-memory-mcp",
      resource: "https://memory-mcp.mtdl.kr"
    }));

    expect(tokenResponse.token_type).toBe("Bearer");
    expect(tokenResponse.scope).toBe("openid email profile rationale:read rationale:write");
  });

  it("accepts additional OAuth redirect URIs from the allowlist", () => {
    const oauthServer = createOAuthServer({
      MCP_OAUTH_ALLOWED_REDIRECT_URIS: "https://claude.ai/api/mcp/auth_callback"
    });
    const codeVerifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
    const authorizationResult = oauthServer.authorize(new URLSearchParams({
      response_type: "code",
      client_id: "mtdl-memory-mcp",
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      scope: "openid email profile rationale:read rationale:write",
      code_challenge: createPkceChallenge(codeVerifier),
      code_challenge_method: "S256",
      resource: "https://memory-mcp.mtdl.kr",
      login_code: "test-login-code"
    }));
    const code = authorizationResult.redirectUrl.searchParams.get("code");
    if (!code) {
      throw new Error("Authorization redirect did not include a code.");
    }

    const tokenResponse = oauthServer.exchangeToken(new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      client_id: "mtdl-memory-mcp",
      code_verifier: codeVerifier,
      resource: "https://memory-mcp.mtdl.kr"
    }));

    expect(tokenResponse.token_type).toBe("Bearer");
    expect(tokenResponse.scope).toBe("openid email profile rationale:read rationale:write");
  });

  it("accepts OAuth resource identifiers with a root trailing slash", () => {
    const oauthServer = createOAuthServer({
      MCP_OAUTH_ALLOWED_REDIRECT_URIS: "https://claude.ai/api/mcp/auth_callback"
    });
    const codeVerifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
    const authorizationResult = oauthServer.authorize(new URLSearchParams({
      response_type: "code",
      client_id: "mtdl-memory-mcp",
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      scope: "rationale:read rationale:write",
      code_challenge: createPkceChallenge(codeVerifier),
      code_challenge_method: "S256",
      resource: "https://memory-mcp.mtdl.kr/",
      login_code: "test-login-code"
    }));
    const code = authorizationResult.redirectUrl.searchParams.get("code");
    if (!code) {
      throw new Error("Authorization redirect did not include a code.");
    }

    const tokenResponse = oauthServer.exchangeToken(new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      client_id: "mtdl-memory-mcp",
      code_verifier: codeVerifier,
      resource: "https://memory-mcp.mtdl.kr/"
    }));

    expect(tokenResponse.token_type).toBe("Bearer");
    expect(tokenResponse.scope).toBe("rationale:read rationale:write");
  });

  it("sets a login session cookie that can authorize the next OAuth request", () => {
    const oauthServer = createOAuthServer();
    const firstAuthorizationResult = oauthServer.authorize(new URLSearchParams({
      response_type: "code",
      client_id: "mtdl-memory-mcp",
      redirect_uri: "https://chatgpt.com/connector/oauth/ZT7uG4vEQ1CV",
      scope: "openid email profile rationale:read rationale:write",
      resource: "https://memory-mcp.mtdl.kr",
      login_code: "test-login-code"
    }));

    expect(firstAuthorizationResult.sessionCookie).toContain("__Host-rationale_memory_oauth_session=");
    expect(firstAuthorizationResult.sessionCookie).toContain("Max-Age=2592000");
    expect(firstAuthorizationResult.sessionCookie).toContain("HttpOnly");
    expect(firstAuthorizationResult.sessionCookie).toContain("Secure");
    expect(firstAuthorizationResult.sessionCookie).toContain("SameSite=Lax");

    const secondRedirectUrl = oauthServer.authorizeWithLoginSession(new URLSearchParams({
      response_type: "code",
      client_id: "mtdl-memory-mcp",
      redirect_uri: "https://chatgpt.com/connector/oauth/ZT7uG4vEQ1CV",
      scope: "openid email profile rationale:read rationale:write",
      resource: "https://memory-mcp.mtdl.kr",
      state: "state-from-cookie"
    }), firstAuthorizationResult.sessionCookie);

    if (!secondRedirectUrl) {
      throw new Error("Login session cookie did not authorize the request.");
    }

    expect(secondRedirectUrl.searchParams.get("code")).toBeTruthy();
    expect(secondRedirectUrl.searchParams.get("state")).toBe("state-from-cookie");
  });

  it("allows OAuth token and login session TTL overrides", () => {
    const oauthServer = createOAuthServer({
      MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "120",
      MCP_OAUTH_LOGIN_SESSION_TTL_SECONDS: "240"
    });
    const authorizationResult = oauthServer.authorize(new URLSearchParams({
      response_type: "code",
      client_id: "mtdl-memory-mcp",
      redirect_uri: "https://chatgpt.com/connector/oauth/ZT7uG4vEQ1CV",
      scope: "openid email profile rationale:read rationale:write",
      resource: "https://memory-mcp.mtdl.kr",
      login_code: "test-login-code"
    }));
    const code = authorizationResult.redirectUrl.searchParams.get("code");
    if (!code) {
      throw new Error("Authorization redirect did not include a code.");
    }

    const tokenResponse = oauthServer.exchangeToken(new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://chatgpt.com/connector/oauth/ZT7uG4vEQ1CV",
      client_id: "mtdl-memory-mcp",
      resource: "https://memory-mcp.mtdl.kr"
    }));

    expect(tokenResponse.expires_in).toBe(120);
    expect(authorizationResult.sessionCookie).toContain("Max-Age=240");
  });

  it("keeps bearer tokens verifiable across server instances when a signing key is configured", () => {
    const keyPair = generateKeyPairSync("rsa", {
      modulusLength: 2048
    });
    const signingPrivateKeyPem = keyPair.privateKey.export({
      type: "pkcs8",
      format: "pem"
    }).toString();

    const firstOAuthServer = createOAuthServer({
      MCP_OAUTH_SIGNING_PRIVATE_KEY_PEM: signingPrivateKeyPem
    });
    const secondOAuthServer = createOAuthServer({
      MCP_OAUTH_SIGNING_PRIVATE_KEY_PEM: signingPrivateKeyPem
    });
    const codeVerifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";

    const authorizationResult = firstOAuthServer.authorize(new URLSearchParams({
      response_type: "code",
      client_id: "mtdl-memory-mcp",
      redirect_uri: "https://chatgpt.com/connector/oauth/ZT7uG4vEQ1CV",
      scope: "openid email profile rationale:read rationale:write",
      code_challenge: createPkceChallenge(codeVerifier),
      code_challenge_method: "S256",
      resource: "https://memory-mcp.mtdl.kr",
      login_code: "test-login-code"
    }));
    const redirectUrl = authorizationResult.redirectUrl;
    const code = redirectUrl.searchParams.get("code");
    if (!code) {
      throw new Error("Authorization redirect did not include a code.");
    }

    const tokenResponse = firstOAuthServer.exchangeToken(new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://chatgpt.com/connector/oauth/ZT7uG4vEQ1CV",
      client_id: "mtdl-memory-mcp",
      code_verifier: codeVerifier,
      resource: "https://memory-mcp.mtdl.kr"
    }));
    const accessToken = tokenResponse.access_token;
    if (typeof accessToken !== "string") {
      throw new Error("Token response did not include a string access token.");
    }

    expect(secondOAuthServer.verifyBearerToken(accessToken)).toMatchObject({
      subject: "mtdl",
      email: "owner@example.com"
    });
  });
});

function createOAuthServer(overrides: NodeJS.ProcessEnv = {}) {
  const config = loadConfig({
    DATABASE_URL: "postgres://rationale:rationale@localhost:54329/rationale_memory",
    MCP_OAUTH_ENABLED: "true",
    MCP_PUBLIC_URL: "https://memory-mcp.mtdl.kr",
    MCP_OAUTH_CLIENT_ID: "mtdl-memory-mcp",
    MCP_OAUTH_REDIRECT_URI: "https://chatgpt.com/connector/oauth/ZT7uG4vEQ1CV",
    MCP_OAUTH_LOGIN_CODE: "test-login-code",
    MCP_OAUTH_USER_EMAIL: "owner@example.com",
    ...overrides
  });
  return new OAuthAuthorizationServer(config.mcp.oauth);
}

function createPkceChallenge(codeVerifier: string) {
  return createHash("sha256").update(codeVerifier).digest().toString("base64url");
}
