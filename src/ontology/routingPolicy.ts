import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

export async function loadRoutingPolicies(dataDirectory: string) {
  const policyPath = path.join(dataDirectory, "ontology", "routing-policies.yaml");
  const yamlText = await readFile(policyPath, "utf8");
  return YAML.parse(yamlText);
}

