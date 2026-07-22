import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, timingSafeEqual, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

/**
 * authorization server 동작에 필요한 값 전부.
 * 환경변수 이름이나 키 파일 경로처럼 앱 레이어에서만 의미 있는 표현은 담지 않는다 —
 * 해석은 호출자가 끝내고 여기에는 값만 넘긴다.
 */
export type OAuthServerOptions = {
  issuer: string;
  clientId: string;
  redirectUris: string[];
  loginCode: string;
  // 없으면 기동할 때마다 RSA 키를 새로 만든다. 그 경우 재시작 이전에 발급한 토큰은 모두 검증에 실패한다.
  signingPrivateKeyPem: string | undefined;
  accessTokenTtlSeconds: number;
  loginSessionTtlSeconds: number;
  userSubject: string;
  scopes: string[];
  requiredScopes: string[];
};

const authorizationRequestSchema = z.object({
  response_type: z.literal("code"),
  client_id: z.string(),
  redirect_uri: z.string().url(),
  scope: z.string().optional(),
  state: z.string().optional(),
  code_challenge: z.string().min(43).optional(),
  code_challenge_method: z.literal("S256").optional(),
  resource: z.string().url().optional()
});

const tokenRequestSchema = z.object({
  grant_type: z.literal("authorization_code"),
  code: z.string().min(1),
  redirect_uri: z.string().url(),
  client_id: z.string(),
  code_verifier: z.string().min(43).optional(),
  resource: z.string().url().optional()
});

const jwtHeaderSchema = z.object({
  alg: z.literal("RS256"),
  typ: z.literal("JWT"),
  kid: z.string()
});

const accessTokenPayloadSchema = z.object({
  iss: z.string(),
  sub: z.string(),
  aud: z.string(),
  exp: z.number().int(),
  iat: z.number().int(),
  scope: z.string(),
  token_use: z.literal("access"),
  resource: z.string()
});

const loginSessionPayloadSchema = z.object({
  iss: z.string(),
  sub: z.string(),
  aud: z.string(),
  exp: z.number().int(),
  iat: z.number().int(),
  token_use: z.literal("login_session")
});

type AuthorizationRequest = z.infer<typeof authorizationRequestSchema>;

type AuthorizationCodeRecord = {
  request: AuthorizationRequest;
  scope: string;
  expiresAt: number;
};

type VerifiedToken = {
  subject: string;
  scope: string;
};

type AuthorizationResult = {
  redirectUrl: URL;
  sessionCookie: string;
};

type RsaPublicJwk = {
  kty: "RSA";
  n: string;
  e: string;
};

const authorizationCodeTtlMilliseconds = 5 * 60 * 1000;
const loginSessionCookieName = "__Host-rationale_memory_oauth_session";

export class OAuthAuthorizationServer {
  private readonly authorizationCodes = new Map<string, AuthorizationCodeRecord>();
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private readonly keyId: string;
  private readonly issuer: string;
  private readonly resource: string;

  constructor(private readonly options: OAuthServerOptions) {
    if (options.signingPrivateKeyPem) {
      this.privateKey = createPrivateKey(options.signingPrivateKeyPem);
      this.publicKey = createPublicKey(this.privateKey);
    } else {
      const keyPair = generateKeyPairSync("rsa", {
        modulusLength: 2048
      });
      this.privateKey = keyPair.privateKey;
      this.publicKey = keyPair.publicKey;
    }
    this.keyId = createKeyId(this.publicKey);
    this.issuer = options.issuer;
    this.resource = this.issuer;
  }

  getProtectedResourceMetadata() {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      scopes_supported: this.options.scopes,
      resource_documentation: `${this.issuer}/`
    };
  }

  getAuthorizationServerMetadata() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      jwks_uri: `${this.issuer}/oauth/jwks.json`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: this.options.scopes,
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      userinfo_endpoint: `${this.issuer}/oauth/userinfo`
    };
  }

  getOpenIdConfiguration() {
    return this.getAuthorizationServerMetadata();
  }

  getJwks() {
    const publicJwk = exportRsaPublicJwk(this.publicKey);

    return {
      keys: [
        {
          kty: publicJwk.kty,
          n: publicJwk.n,
          e: publicJwk.e,
          kid: this.keyId,
          use: "sig",
          alg: "RS256",
          key_ops: ["verify"]
        }
      ]
    };
  }

  renderAuthorizationForm(searchParams: URLSearchParams) {
    const request = this.parseAuthorizationRequest(searchParams);
    const hiddenInputs = [
      ["response_type", request.response_type],
      ["client_id", request.client_id],
      ["redirect_uri", request.redirect_uri],
      ["scope", request.scope ?? ""],
      ["state", request.state ?? ""],
      ["code_challenge", request.code_challenge],
      ["code_challenge_method", request.code_challenge_method],
      ["resource", request.resource ?? ""]
    ]
      .filter((input): input is [string, string] => typeof input[1] === "string")
      .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`);

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize Rationale Memory</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; max-width: 36rem; }
    label, input, button { display: block; width: 100%; box-sizing: border-box; }
    input, button { font: inherit; padding: 0.75rem; margin-top: 0.5rem; }
    button { cursor: pointer; }
  </style>
</head>
<body>
  <h1>Authorize Rationale Memory</h1>
  <p>Enter the one-time login code configured on this MCP server.</p>
  <form method="post" action="/oauth/authorize">
    ${hiddenInputs.join("\n    ")}
    <label>
      Login code
      <input name="login_code" type="password" autocomplete="one-time-code" required autofocus>
    </label>
    <button type="submit">Authorize</button>
  </form>
</body>
</html>`;
  }

  authorize(searchParams: URLSearchParams): AuthorizationResult {
    const loginCode = searchParams.get("login_code");
    if (loginCode === null || !secureEquals(loginCode, this.options.loginCode)) {
      throw new OAuthHttpError(401, "invalid_login", "Invalid login code.");
    }

    return {
      redirectUrl: this.createAuthorizationRedirect(searchParams),
      sessionCookie: this.createLoginSessionCookie()
    };
  }

  authorizeWithLoginSession(searchParams: URLSearchParams, cookieHeader: string | undefined) {
    const loginSessionToken = readCookie(cookieHeader, loginSessionCookieName);
    if (!loginSessionToken || !this.verifyLoginSessionToken(loginSessionToken)) {
      return undefined;
    }
    return this.createAuthorizationRedirect(searchParams);
  }

  private createAuthorizationRedirect(searchParams: URLSearchParams) {
    const request = this.parseAuthorizationRequest(searchParams);
    const code = base64UrlEncode(randomBytes(32));
    this.authorizationCodes.set(code, {
      request,
      scope: this.resolveScope(request.scope),
      expiresAt: Date.now() + authorizationCodeTtlMilliseconds
    });

    const redirectUrl = new URL(request.redirect_uri);
    redirectUrl.searchParams.set("code", code);
    if (request.state) {
      redirectUrl.searchParams.set("state", request.state);
    }
    return redirectUrl;
  }

  exchangeToken(searchParams: URLSearchParams) {
    const request = tokenRequestSchema.parse(readParams(searchParams, [
      "grant_type",
      "code",
      "redirect_uri",
      "client_id",
      "code_verifier",
      "resource"
    ]));

    if (request.client_id !== this.options.clientId) {
      throw new OAuthHttpError(400, "invalid_client", "Unknown OAuth client.");
    }

    const codeRecord = this.authorizationCodes.get(request.code);
    if (!codeRecord) {
      throw new OAuthHttpError(400, "invalid_grant", "Authorization code was not found.");
    }
    this.authorizationCodes.delete(request.code);

    if (Date.now() > codeRecord.expiresAt) {
      throw new OAuthHttpError(400, "invalid_grant", "Authorization code expired.");
    }
    if (request.redirect_uri !== codeRecord.request.redirect_uri) {
      throw new OAuthHttpError(400, "invalid_grant", "Redirect URI did not match the authorization request.");
    }
    if (request.resource && !resourceIdentifiersMatch(request.resource, this.resource)) {
      throw new OAuthHttpError(400, "invalid_target", "Resource did not match this MCP server.");
    }
    if (codeRecord.request.code_challenge && !request.code_verifier) {
      throw new OAuthHttpError(400, "invalid_grant", "PKCE code verifier is required.");
    }
    if (codeRecord.request.code_challenge && request.code_verifier && !verifyPkce(request.code_verifier, codeRecord.request.code_challenge)) {
      throw new OAuthHttpError(400, "invalid_grant", "PKCE verification failed.");
    }

    const accessToken = this.signToken("access", codeRecord.scope, this.resource);
    const response: Record<string, string | number> = {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.options.accessTokenTtlSeconds,
      scope: codeRecord.scope
    };

    if (codeRecord.scope.split(" ").includes("openid")) {
      response.id_token = this.signToken("id", codeRecord.scope, this.options.clientId);
    }

    return response;
  }

  verifyBearerToken(token: string): VerifiedToken | undefined {
    const parsedToken = this.parseAndVerifyToken(token);
    if (!parsedToken) {
      return undefined;
    }

    const parsedPayload = accessTokenPayloadSchema.safeParse(parsedToken.payload);
    if (!parsedPayload.success) {
      return undefined;
    }

    const payload = parsedPayload.data;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (payload.iss !== this.issuer || payload.aud !== this.resource || payload.resource !== this.resource) {
      return undefined;
    }
    if (payload.exp <= nowSeconds) {
      return undefined;
    }

    const tokenScopes = payload.scope.split(" ");
    for (const requiredScope of this.options.requiredScopes) {
      if (!tokenScopes.includes(requiredScope)) {
        return undefined;
      }
    }

    return {
      subject: payload.sub,
      scope: payload.scope
    };
  }

  getUserInfo(token: string) {
    const verifiedToken = this.verifyBearerToken(token);
    if (!verifiedToken) {
      throw new OAuthHttpError(401, "invalid_token", "Access token is invalid.");
    }

    // OIDC userinfo에서 필수 claim은 sub뿐이다. 단일 소유자 전용 서버라 프로필 claim은 제공하지 않는다.
    return {
      sub: verifiedToken.subject
    };
  }

  createAuthenticateHeader() {
    return `Bearer resource_metadata="${this.issuer}/.well-known/oauth-protected-resource", scope="${this.options.requiredScopes.join(" ")}"`;
  }

  private parseAuthorizationRequest(searchParams: URLSearchParams) {
    const request = authorizationRequestSchema.parse(readParams(searchParams, [
      "response_type",
      "client_id",
      "redirect_uri",
      "scope",
      "state",
      "code_challenge",
      "code_challenge_method",
      "resource"
    ]));

    if (request.client_id !== this.options.clientId) {
      throw new OAuthHttpError(400, "invalid_client", "Unknown OAuth client.");
    }
    if (!this.options.redirectUris.includes(request.redirect_uri)) {
      throw new OAuthHttpError(400, "invalid_request", "Redirect URI is not allowed.");
    }
    if (request.resource && !resourceIdentifiersMatch(request.resource, this.resource)) {
      throw new OAuthHttpError(400, "invalid_target", "Resource did not match this MCP server.");
    }
    if (Boolean(request.code_challenge) !== Boolean(request.code_challenge_method)) {
      throw new OAuthHttpError(400, "invalid_request", "PKCE code challenge and method must be provided together.");
    }

    this.resolveScope(request.scope);
    return request;
  }

  private resolveScope(scope: string | undefined) {
    const requestedScopes = scope ? scope.split(" ").filter((part) => part.length > 0) : this.options.scopes;
    for (const requestedScope of requestedScopes) {
      if (!this.options.scopes.includes(requestedScope)) {
        throw new OAuthHttpError(400, "invalid_scope", `Unsupported scope: ${requestedScope}`);
      }
    }
    return requestedScopes.join(" ");
  }

  private signToken(tokenUse: "access" | "id", scope: string, audience: string) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    return signJwt(
      {
        alg: "RS256",
        typ: "JWT",
        kid: this.keyId
      },
      {
        iss: this.issuer,
        sub: this.options.userSubject,
        aud: audience,
        exp: nowSeconds + this.options.accessTokenTtlSeconds,
        iat: nowSeconds,
        scope,
        token_use: tokenUse,
        resource: this.resource
      },
      this.privateKey
    );
  }

  private createLoginSessionCookie() {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = signJwt(
      {
        alg: "RS256",
        typ: "JWT",
        kid: this.keyId
      },
      {
        iss: this.issuer,
        sub: this.options.userSubject,
        aud: this.issuer,
        exp: nowSeconds + this.options.loginSessionTtlSeconds,
        iat: nowSeconds,
        token_use: "login_session"
      },
      this.privateKey
    );
    return [
      `${loginSessionCookieName}=${token}`,
      `Max-Age=${this.options.loginSessionTtlSeconds}`,
      "Path=/",
      "HttpOnly",
      "Secure",
      "SameSite=Lax"
    ].join("; ");
  }

  private verifyLoginSessionToken(token: string) {
    const parsedToken = this.parseAndVerifyToken(token);
    if (!parsedToken) {
      return false;
    }

    const parsedPayload = loginSessionPayloadSchema.safeParse(parsedToken.payload);
    if (!parsedPayload.success) {
      return false;
    }

    const payload = parsedPayload.data;
    const nowSeconds = Math.floor(Date.now() / 1000);
    return payload.iss === this.issuer
      && payload.sub === this.options.userSubject
      && payload.aud === this.issuer
      && payload.exp > nowSeconds;
  }

  private parseAndVerifyToken(token: string) {
    const tokenParts = token.split(".");
    if (tokenParts.length !== 3) {
      return undefined;
    }

    const [encodedHeader, encodedPayload, encodedSignature] = tokenParts;
    if (!encodedHeader || !encodedPayload || !encodedSignature) {
      return undefined;
    }

    const parsedHeader = jwtHeaderSchema.safeParse(parseBase64UrlJson(encodedHeader));
    if (!parsedHeader.success || parsedHeader.data.kid !== this.keyId) {
      return undefined;
    }

    const signature = base64UrlDecode(encodedSignature);
    const signedPayload = Buffer.from(`${encodedHeader}.${encodedPayload}`);
    if (!verify("RSA-SHA256", signedPayload, this.publicKey, signature)) {
      return undefined;
    }

    return {
      header: parsedHeader.data,
      payload: parseBase64UrlJson(encodedPayload)
    };
  }
}

export class OAuthHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export async function handleOAuthRequest(
  request: IncomingMessage,
  response: ServerResponse,
  oauthServer: OAuthAuthorizationServer
) {
  if (!request.url) {
    return false;
  }

  const url = new URL(request.url, "http://localhost");

  if (request.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
    writeJsonResponse(response, 200, oauthServer.getProtectedResourceMetadata());
    return true;
  }
  if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
    writeJsonResponse(response, 200, oauthServer.getAuthorizationServerMetadata());
    return true;
  }
  if (request.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
    writeJsonResponse(response, 200, oauthServer.getOpenIdConfiguration());
    return true;
  }
  if (request.method === "GET" && url.pathname === "/oauth/jwks.json") {
    writeJsonResponse(response, 200, oauthServer.getJwks());
    return true;
  }
  if (request.method === "GET" && url.pathname === "/oauth/authorize") {
    try {
      const redirectUrl = oauthServer.authorizeWithLoginSession(url.searchParams, request.headers.cookie);
      if (redirectUrl) {
        response.statusCode = 302;
        response.setHeader("Location", redirectUrl.toString());
        response.end();
        return true;
      }
      writeHtmlResponse(response, 200, oauthServer.renderAuthorizationForm(url.searchParams));
    } catch (error) {
      writeOAuthError(response, error);
    }
    return true;
  }
  if (request.method === "POST" && url.pathname === "/oauth/authorize") {
    try {
      const authorizationResult = oauthServer.authorize(await readFormBody(request));
      response.statusCode = 302;
      response.setHeader("Location", authorizationResult.redirectUrl.toString());
      response.setHeader("Set-Cookie", authorizationResult.sessionCookie);
      response.end();
    } catch (error) {
      writeOAuthError(response, error);
    }
    return true;
  }
  if (request.method === "POST" && url.pathname === "/oauth/token") {
    try {
      writeJsonResponse(response, 200, oauthServer.exchangeToken(await readFormBody(request)));
    } catch (error) {
      writeOAuthError(response, error);
    }
    return true;
  }
  if (request.method === "GET" && url.pathname === "/oauth/userinfo") {
    try {
      const token = readBearerToken(request);
      if (!token) {
        throw new OAuthHttpError(401, "invalid_token", "Missing bearer token.");
      }
      writeJsonResponse(response, 200, oauthServer.getUserInfo(token));
    } catch (error) {
      writeOAuthError(response, error);
    }
    return true;
  }

  if (url.pathname.startsWith("/oauth/")) {
    writeJsonResponse(response, 404, {
      error: "not_found",
      error_description: "OAuth endpoint was not found."
    });
    return true;
  }

  return false;
}

export function readBearerToken(request: IncomingMessage) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") {
    return undefined;
  }

  const [scheme, token] = authorization.split(" ");
  if (scheme !== "Bearer" || !token) {
    return undefined;
  }
  return token;
}

function signJwt(header: Record<string, unknown>, payload: Record<string, unknown>, privateKey: KeyObject) {
  const encodedHeader = base64UrlEncode(Buffer.from(JSON.stringify(header)));
  const encodedPayload = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
  const signature = sign("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedPayload}`), privateKey);
  return `${encodedHeader}.${encodedPayload}.${base64UrlEncode(signature)}`;
}

function createKeyId(publicKey: KeyObject) {
  const publicJwk = exportRsaPublicJwk(publicKey);
  return createHash("sha256")
    .update(`${publicJwk.kty}.${publicJwk.n}.${publicJwk.e}`)
    .digest("base64url");
}

function exportRsaPublicJwk(publicKey: KeyObject): RsaPublicJwk {
  const publicJwk = publicKey.export({ format: "jwk" });
  if (publicJwk.kty !== "RSA" || typeof publicJwk.n !== "string" || typeof publicJwk.e !== "string") {
    throw new Error("OAuth signing key did not export as an RSA JWK.");
  }

  return {
    kty: publicJwk.kty,
    n: publicJwk.n,
    e: publicJwk.e
  };
}

function verifyPkce(codeVerifier: string, codeChallenge: string) {
  const digest = createHash("sha256").update(codeVerifier).digest();
  return base64UrlEncode(digest) === codeChallenge;
}

function resourceIdentifiersMatch(requestedResource: string, configuredResource: string) {
  return normalizeRootResourceIdentifier(requestedResource) === normalizeRootResourceIdentifier(configuredResource);
}

function normalizeRootResourceIdentifier(resource: string) {
  const parsedResource = new URL(resource);
  if (parsedResource.pathname === "/" && parsedResource.search === "" && parsedResource.hash === "") {
    return parsedResource.origin;
  }
  return resource;
}

async function readFormBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
    } else {
      chunks.push(Buffer.from(chunk));
    }
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function readParams(searchParams: URLSearchParams, names: string[]) {
  const result: Record<string, string> = {};
  for (const name of names) {
    const value = searchParams.get(name);
    if (value !== null && value.length > 0) {
      result[name] = value;
    }
  }
  return result;
}

function readCookie(cookieHeader: string | undefined, name: string) {
  if (!cookieHeader) {
    return undefined;
  }

  for (const cookiePart of cookieHeader.split(";")) {
    const [cookieName, ...cookieValueParts] = cookiePart.trim().split("=");
    if (cookieName === name) {
      return cookieValueParts.join("=");
    }
  }
  return undefined;
}

function parseBase64UrlJson(value: string) {
  const parsed: unknown = JSON.parse(base64UrlDecode(value).toString("utf8"));
  return parsed;
}

function base64UrlEncode(value: Buffer) {
  return value.toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url");
}

function secureEquals(actual: string, expected: string) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function writeOAuthError(response: ServerResponse, error: unknown) {
  if (error instanceof OAuthHttpError) {
    writeJsonResponse(response, error.statusCode, {
      error: error.code,
      error_description: error.message
    });
    return;
  }
  if (error instanceof z.ZodError) {
    writeJsonResponse(response, 400, {
      error: "invalid_request",
      error_description: error.issues.map((issue) => issue.message).join("; ")
    });
    return;
  }
  throw error;
}

function writeJsonResponse(response: ServerResponse, statusCode: number, body: unknown) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}

function writeHtmlResponse(response: ServerResponse, statusCode: number, body: string) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(body);
}
