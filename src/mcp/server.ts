import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ToolServices } from "./tools.js";
import { toolDefinitions } from "./tools.js";
import { registerResources, type ResourceServices } from "./resources.js";
import { registerPrompts } from "./prompts.js";

export type McpServices = ToolServices & ResourceServices;

export async function startMcpServer(services: McpServices) {
  const server = new McpServer({
    name: "rationale-memory-store",
    version: "0.1.0"
  });

  for (const definition of toolDefinitions(services)) {
    server.tool(definition.name, definition.description, definition.schema, definition.handler);
  }

  registerResources(server, services);
  registerPrompts(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

