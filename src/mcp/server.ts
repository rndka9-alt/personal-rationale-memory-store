import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ToolServices } from "./tools.js";
import { toolDefinitions } from "./tools.js";
import { registerResources, type ResourceServices } from "./resources.js";
import { registerPrompts } from "./prompts.js";
import type { StatusService } from "../diagnostics/statusService.js";

export type McpServices = ToolServices & ResourceServices & {
  statusService: StatusService;
};

export function configureMcpServer(server: McpServer, services: McpServices) {
  for (const definition of toolDefinitions(services)) {
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: definition.schema,
        outputSchema: definition.outputSchema,
        annotations: definition.annotations,
        _meta: definition.metadata
      },
      definition.handler
    );
  }

  registerResources(server, services);
  registerPrompts(server);
}

export async function startStdioMcpServer(services: McpServices) {
  const server = new McpServer({
    name: "rationale-memory-store",
    version: "0.1.0"
  });

  configureMcpServer(server, services);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
