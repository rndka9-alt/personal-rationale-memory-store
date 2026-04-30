import { readFile } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "../config.js";
import type { McpServices } from "./server.js";
import { configureMcpServer } from "./server.js";
import { logError, logInfo, logWarn } from "../diagnostics/index.js";

export async function startHttpMcpServer(config: AppConfig, services: McpServices) {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const requestHandler = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      if (isOauthDiscoveryPath(request)) {
        writeJsonResponse(response, 404, {
          error: "oauth_not_configured",
          error_description: "This MCP server uses static headers or no auth, not OAuth discovery."
        });
        return;
      }


      if (!isExpectedPath(request, config.mcp.path)) {
        writePlainResponse(response, 404, "Not found");
        return;
      }

      if (!isAuthorized(request, config.mcp.authToken)) {
        response.setHeader("WWW-Authenticate", "Bearer");
        writePlainResponse(response, 401, "Unauthorized");
        return;
      }

      if (request.method === "POST") {
        await handlePostRequest(request, response, services, transports);
        return;
      }

      if (request.method === "GET" || request.method === "DELETE") {
        await handleSessionRequest(request, response, transports);
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
    path: config.mcp.path
  });

  return server;
}

async function handlePostRequest(
  request: IncomingMessage,
  response: ServerResponse,
  services: McpServices,
  transports: Map<string, StreamableHTTPServerTransport>
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
    await transport.handleRequest(request, response);
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

  let transport: StreamableHTTPServerTransport | undefined;
  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (initializedSessionId) => {
      if (!transport) {
        throw new Error("Transport was not created before session initialization.");
      }
      logInfo("MCP session initialized.", {
        sessionId: initializedSessionId
      });
      transports.set(initializedSessionId, transport);
    }
  });

  transport.onclose = () => {
    const initializedSessionId = transport?.sessionId;
    if (initializedSessionId) {
      logInfo("MCP session closed.", {
        sessionId: initializedSessionId
      });
      transports.delete(initializedSessionId);
    }
  };

  const server = createConfiguredServer(services);
  await server.connect(transport);
  await transport.handleRequest(request, response, body);
}

async function handleSessionRequest(
  request: IncomingMessage,
  response: ServerResponse,
  transports: Map<string, StreamableHTTPServerTransport>
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
  await transport.handleRequest(request, response);
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

function isExpectedPath(request: IncomingMessage, expectedPath: string) {
  if (!request.url) {
    return false;
  }

  const url = new URL(request.url, "http://localhost");
  return url.pathname === expectedPath;
}

function isAuthorized(request: IncomingMessage, authToken: string | undefined) {
  if (!authToken) {
    return true;
  }

  return request.headers.authorization === `Bearer ${authToken}`;
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
