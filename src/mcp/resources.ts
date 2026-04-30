import { readFile } from "node:fs/promises";
import path from "node:path";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContextComposer } from "../memory/contextComposer.js";
import type { RationaleService } from "../memory/rationaleService.js";
import type { OntologyService } from "../ontology/ontologyService.js";

export type ResourceServices = {
  dataDirectory: string;
  rationaleService: RationaleService;
  ontologyService: OntologyService;
  contextComposer: ContextComposer;
};

export function registerResources(server: McpServer, services: ResourceServices) {
  server.resource("global-principles", "rationale://kernel/global-principles", async (uri) => ({
    contents: [{
      uri: uri.href,
      text: await readFile(path.join(services.dataDirectory, "kernel", "global-principles.md"), "utf8")
    }]
  }));

  server.resource("ontology", "rationale://ontology", async (uri) => ({
    contents: [{
      uri: uri.href,
      text: JSON.stringify(await services.ontologyService.loadRegistry(), null, 2)
    }]
  }));

  server.resource("recent", "rationale://recent", async (uri) => ({
    contents: [{
      uri: uri.href,
      text: JSON.stringify(await services.rationaleService.listRecent(10), null, 2)
    }]
  }));

  server.resource(
    "entry",
    new ResourceTemplate("rationale://entry/{id}", { list: undefined }),
    async (uri, variables) => {
      const id = readSingleVariable(variables.id, "id");
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify(await services.rationaleService.getRationale(id), null, 2)
        }]
      };
    }
  );

  server.resource(
    "context-pack",
    new ResourceTemplate("rationale://context-pack/{name}", { list: undefined }),
    async (uri, variables) => {
      const name = readSingleVariable(variables.name, "name");
      const contextPackPath = path.join(services.dataDirectory, "context-packs", `${name}.md`);
      return {
        contents: [{
          uri: uri.href,
          text: await readFile(contextPackPath, "utf8")
        }]
      };
    }
  );
}

function readSingleVariable(value: string | string[] | undefined, name: string) {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  throw new Error(`Missing resource variable: ${name}`);
}
