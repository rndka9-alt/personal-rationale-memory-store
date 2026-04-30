import { readFile } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AppConfig } from "../config.js";
import type { McpServices } from "./server.js";
import { configureMcpServer } from "./server.js";

export async function startHttpMcpServer(config: AppConfig, services: McpServices) {
  const mcpServer = new McpServer({
    name: "rationale-memory-store",
    version: "0.1.0"
  });
  configureMcpServer(mcpServer, services);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID()
  });
  await mcpServer.connect(transport);

  const requestHandler = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      if (!isExpectedPath(request, config.mcp.path)) {
        writePlainResponse(response, 404, "Not found");
        return;
      }

      if (!isAuthorized(request, config.mcp.authToken)) {
        response.setHeader("WWW-Authenticate", "Bearer");
        writePlainResponse(response, 401, "Unauthorized");
        return;
      }

      await transport.handleRequest(request, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown MCP HTTP error";
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

  return server;
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

function writePlainResponse(response: ServerResponse, statusCode: number, body: string) {
  if (response.headersSent) {
    response.end();
    return;
  }

  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(body);
}

