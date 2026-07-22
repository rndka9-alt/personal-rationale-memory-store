import { readFile } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "../config.js";
import type { McpServices } from "./server.js";
import { configureMcpServer } from "./server.js";
import { upsertMcpSession } from "../db/queries.js";
import { logError, logInfo, logWarn, runWithClientContext, type ClientContext } from "../diagnostics/index.js";
import { handleOAuthRequest, readBearerToken, OAuthAuthorizationServer } from "./oauth.js";
import { resolveOAuthServerOptions } from "./oauthOptions.js";

// initialize 요청에만 실리는 clientInfo를 이후 세션 요청에서도 참조하기 위한 세션 단위 보관소.
type SessionClientInfo = Pick<ClientContext, "clientName" | "clientVersion">;

export async function startHttpMcpServer(config: AppConfig, services: McpServices, pool: pg.Pool) {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const clientInfoBySession = new Map<string, SessionClientInfo>();
  const oauthServerOptions = resolveOAuthServerOptions(config.mcp.oauth);
  const oauthServer = oauthServerOptions ? new OAuthAuthorizationServer(oauthServerOptions) : undefined;

  const requestHandler = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      if (oauthServer && await handleOAuthRequest(request, response, oauthServer)) {
        return;
      }

      if (isOauthDiscoveryPath(request) || isOpenIdDiscoveryPath(request)) {
        writeJsonResponse(response, 404, {
          error: "oauth_not_configured",
          error_description: "This MCP server uses static headers or no auth, not OAuth discovery."
        });
        return;
      }

      if (isPath(request, "/health")) {
        writeJsonResponse(response, 200, await services.statusService.health());
        return;
      }

      if (isPath(request, "/status")) {
        if (!isAuthorized(request, config.mcp.authToken, oauthServer)) {
          setUnauthorizedChallenge(response, oauthServer);
          writePlainResponse(response, 401, "Unauthorized");
          return;
        }

        writeJsonResponse(response, 200, await services.statusService.status());
        return;
      }

      if (!isExpectedPath(request, config.mcp.path)) {
        writePlainResponse(response, 404, "Not found");
        return;
      }

      if (!isAuthorized(request, config.mcp.authToken, oauthServer)) {
        setUnauthorizedChallenge(response, oauthServer);
        writePlainResponse(response, 401, "Unauthorized");
        return;
      }

      if (request.method === "POST") {
        await handlePostRequest(request, response, services, transports, clientInfoBySession, pool);
        return;
      }

      if (request.method === "GET" || request.method === "DELETE") {
        await handleSessionRequest(request, response, transports, clientInfoBySession);
        return;
      }

      writePlainResponse(response, 405, "Method not allowed");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown MCP HTTP error";
      logError("MCP HTTP request failed.", error, {
        method: request.method,
        url: request.url
      });
      writePlainResponse(response, 500, message);
    }
  };

  const server = config.mcp.transport === "https"
    ? https.createServer(await loadTlsOptions(config), requestHandler)
    : http.createServer(requestHandler);

  await new Promise<void>((resolve) => {
    server.listen(config.mcp.port, config.mcp.host, resolve);
  });

  process.stderr.write(
    `Rationale Memory Store MCP ${config.mcp.transport.toUpperCase()} server listening on ${config.mcp.host}:${config.mcp.port}${config.mcp.path}\n`
  );
  logInfo("MCP HTTP server started.", {
    transport: config.mcp.transport,
    host: config.mcp.host,
    port: config.mcp.port,
    path: config.mcp.path,
    oauthEnabled: config.mcp.oauth.enabled
  });

  return server;
}

async function handlePostRequest(
  request: IncomingMessage,
  response: ServerResponse,
  services: McpServices,
  transports: Map<string, StreamableHTTPServerTransport>,
  clientInfoBySession: Map<string, SessionClientInfo>,
  pool: pg.Pool
) {
  const sessionId = readHeader(request, "mcp-session-id");
  if (sessionId) {
    const transport = transports.get(sessionId);
    if (!transport) {
      logWarn("MCP session request referenced an unknown session.", {
        method: request.method,
        url: request.url,
        sessionId
      });
      writeJsonRpcError(response, 404, -32000, "Session not found");
      return;
    }

    logInfo("MCP session request received.", {
      method: request.method,
      url: request.url,
      sessionId
    });
    await runWithClientContext(
      buildClientContext(request, clientInfoBySession.get(sessionId), sessionId),
      () => transport.handleRequest(request, response)
    );
    return;
  }

  const body = await readJsonBody(request);
  if (!isInitializeRequest(body)) {
    logWarn("MCP POST rejected without a valid session initialization.", {
      method: request.method,
      url: request.url
    });
    writeJsonRpcError(response, 400, -32000, "Bad Request: No valid session ID provided");
    return;
  }

  const sessionClientInfo: SessionClientInfo = {
    clientName: body.params.clientInfo.name,
    clientVersion: body.params.clientInfo.version
  };

  let transport: StreamableHTTPServerTransport | undefined;
  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (initializedSessionId) => {
      if (!transport) {
        throw new Error("Transport was not created before session initialization.");
      }
      logInfo("MCP session initialized.", {
        sessionId: initializedSessionId,
        clientName: sessionClientInfo.clientName,
        clientVersion: sessionClientInfo.clientVersion
      });
      transports.set(initializedSessionId, transport);
      clientInfoBySession.set(initializedSessionId, sessionClientInfo);
      // 관측 전용 업서트: 세션 메타데이터 기록 실패가 세션 초기화를 막으면 안 되므로
      // 응답 경로를 기다리지 않고 fire-and-forget으로 던지고 실패는 삼킨다.
      void upsertMcpSession(pool, {
        id: initializedSessionId,
        clientName: sessionClientInfo.clientName,
        clientVersion: sessionClientInfo.clientVersion,
        userAgent: readHeader(request, "user-agent")
      }).catch((error) => {
        logError("Recording MCP session failed.", error, { sessionId: initializedSessionId });
      });
    }
  });

  transport.onclose = () => {
    const initializedSessionId = transport?.sessionId;
    if (initializedSessionId) {
      logInfo("MCP session closed.", {
        sessionId: initializedSessionId
      });
      transports.delete(initializedSessionId);
      clientInfoBySession.delete(initializedSessionId);
    }
  };

  const server = createConfiguredServer(services);
  await server.connect(transport);
  await runWithClientContext(
    // 초기화 요청 자체는 도메인 쓰기를 하지 않는다. 세션 id는 handleRequest 도중 발급되므로
    // 이 시점엔 아직 undefined일 수 있다(관측 로그에 영향 없음).
    buildClientContext(request, sessionClientInfo, transport.sessionId),
    () => transport.handleRequest(request, response, body)
  );
}

async function handleSessionRequest(
  request: IncomingMessage,
  response: ServerResponse,
  transports: Map<string, StreamableHTTPServerTransport>,
  clientInfoBySession: Map<string, SessionClientInfo>
) {
  const sessionId = readHeader(request, "mcp-session-id");
  if (!sessionId) {
    logWarn("MCP session request rejected without a session id.", {
      method: request.method,
      url: request.url
    });
    writePlainResponse(response, 400, "Invalid or missing session ID");
    return;
  }

  const transport = transports.get(sessionId);
  if (!transport) {
    logWarn("MCP session request referenced an unknown session.", {
      method: request.method,
      url: request.url,
      sessionId
    });
    writePlainResponse(response, 404, "Session not found");
    return;
  }

  logInfo("MCP session request received.", {
    method: request.method,
    url: request.url,
    sessionId
  });
  await runWithClientContext(
    buildClientContext(request, clientInfoBySession.get(sessionId), sessionId),
    () => transport.handleRequest(request, response)
  );
}

async function loadTlsOptions(config: AppConfig) {
  if (!config.mcp.tlsCertPath || !config.mcp.tlsKeyPath) {
    throw new Error("MCP_TLS_CERT_PATH and MCP_TLS_KEY_PATH are required when MCP_TRANSPORT=https.");
  }

  const [cert, key] = await Promise.all([
    readFile(config.mcp.tlsCertPath),
    readFile(config.mcp.tlsKeyPath)
  ]);

  return { cert, key };
}

function createConfiguredServer(services: McpServices) {
  const server = new McpServer({
    name: "rationale-memory-store",
    version: "0.1.0"
  });
  configureMcpServer(server, services);
  return server;
}

async function readJsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
    } else {
      chunks.push(Buffer.from(chunk));
    }
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");
  if (rawBody.trim().length === 0) {
    logWarn("MCP request body was empty.");
    throw new Error("Request body is empty.");
  }

  return JSON.parse(rawBody);
}

function isOauthDiscoveryPath(request: IncomingMessage) {
  if (!request.url) {
    return false;
  }

  const url = new URL(request.url, "http://localhost");
  return url.pathname.startsWith("/.well-known/oauth-");
}

function isOpenIdDiscoveryPath(request: IncomingMessage) {
  if (!request.url) {
    return false;
  }

  const url = new URL(request.url, "http://localhost");
  return url.pathname === "/.well-known/openid-configuration";
}

function isExpectedPath(request: IncomingMessage, expectedPath: string) {
  return isPath(request, expectedPath);
}

function isPath(request: IncomingMessage, expectedPath: string) {
  if (!request.url) {
    return false;
  }

  const url = new URL(request.url, "http://localhost");
  return url.pathname === expectedPath;
}

function isAuthorized(
  request: IncomingMessage,
  authToken: string | undefined,
  oauthServer: OAuthAuthorizationServer | undefined
) {
  if (!authToken && !oauthServer) {
    return true;
  }

  const bearerToken = readBearerToken(request);
  if (!bearerToken) {
    return false;
  }

  if (authToken && bearerToken === authToken) {
    return true;
  }

  return Boolean(oauthServer?.verifyBearerToken(bearerToken));
}

function setUnauthorizedChallenge(response: ServerResponse, oauthServer: OAuthAuthorizationServer | undefined) {
  if (oauthServer) {
    response.setHeader("WWW-Authenticate", oauthServer.createAuthenticateHeader());
    return;
  }

  response.setHeader("WWW-Authenticate", "Bearer");
}

function buildClientContext(
  request: IncomingMessage,
  sessionClientInfo: SessionClientInfo | undefined,
  sessionId: string | undefined
): ClientContext {
  return {
    ...sessionClientInfo,
    userAgent: readHeader(request, "user-agent"),
    sessionId
  };
}

function readHeader(request: IncomingMessage, name: string) {
  const value = request.headers[name];
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value[0];
  }
  return undefined;
}

function writeJsonRpcError(response: ServerResponse, statusCode: number, code: number, message: string) {
  writeJsonResponse(response, statusCode, {
    jsonrpc: "2.0",
    error: { code, message },
    id: null
  });
}

function writeJsonResponse(response: ServerResponse, statusCode: number, body: unknown) {
  if (response.headersSent) {
    response.end();
    return;
  }

  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}

function writePlainResponse(response: ServerResponse, statusCode: number, body: string) {
  if (response.headersSent) {
    response.end();
    return;
  }

  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(body);
}
