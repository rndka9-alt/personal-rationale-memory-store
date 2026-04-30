import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type pg from "pg";
import { z } from "zod";

const proposalInputSchema = z.object({
  proposalType: z.enum(["add", "deprecate", "rename", "merge", "split"]),
  targetKind: z.enum(["intent", "domain", "mode", "memory_type", "routing_policy"]),
  name: z.string().min(1),
  reason: z.string().min(1),
  proposedChange: z.record(z.unknown())
});

const ontologyFileSchema = z.object({
  terms: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    status: z.string().default("accepted"),
    parent_id: z.string().optional(),
    metadata: z.record(z.unknown()).default({})
  })).default([])
});

export class OntologyService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly dataDirectory: string
  ) {}

  async loadRegistry() {
    const ontologyDirectory = path.join(this.dataDirectory, "ontology");
    await mkdir(ontologyDirectory, { recursive: true });
    const fileNames = (await readdir(ontologyDirectory)).filter((fileName) => fileName.endsWith(".yaml"));
    const terms: Array<{ kind: string; id: string; name: string; description?: string; status: string; metadata: Record<string, unknown> }> = [];

    for (const fileName of fileNames) {
      if (fileName === "routing-policies.yaml") {
        continue;
      }

      const yamlText = await readFile(path.join(ontologyDirectory, fileName), "utf8");
      const parsed = ontologyFileSchema.parse(YAML.parse(yamlText));
      const kind = kindFromFileName(fileName);
      for (const term of parsed.terms) {
        terms.push({
          kind,
          id: term.id,
          name: term.name,
          description: term.description,
          status: term.status,
          metadata: term.metadata
        });
        await this.pool.query(
          `INSERT INTO ontology_terms (id, kind, name, description, status, parent_id, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (id) DO UPDATE SET
              kind = EXCLUDED.kind,
              name = EXCLUDED.name,
              description = EXCLUDED.description,
              status = EXCLUDED.status,
              parent_id = EXCLUDED.parent_id,
              metadata = EXCLUDED.metadata,
              updated_at = now()`,
          [term.id, kind, term.name, term.description, term.status, term.parent_id, term.metadata]
        );
      }
    }

    return terms;
  }

  async proposeOntologyChange(input: unknown) {
    const parsedInput = proposalInputSchema.parse(input);
    const id = `OP${new Date().toISOString().replaceAll("-", "").replaceAll(":", "").replaceAll(".", "")}`;
    await this.pool.query(
      `INSERT INTO ontology_proposals (id, proposal_type, target_kind, name, reason, proposed_change)
        VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, parsedInput.proposalType, parsedInput.targetKind, parsedInput.name, parsedInput.reason, parsedInput.proposedChange]
    );

    const proposalPath = path.join(this.dataDirectory, "ontology", "proposals", `${id}.yaml`);
    await mkdir(path.dirname(proposalPath), { recursive: true });
    await writeFile(proposalPath, YAML.stringify({ id, ...parsedInput, status: "proposed" }), "utf8");
    return { id, proposalPath };
  }

  async acceptOntologyProposal(id: string) {
    const result = await this.pool.query("SELECT * FROM ontology_proposals WHERE id = $1", [id]);
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Ontology proposal not found: ${id}`);
    }

    await this.pool.query(
      "UPDATE ontology_proposals SET status = 'accepted', decided_at = now() WHERE id = $1",
      [id]
    );

    if (row.proposal_type === "add") {
      await this.pool.query(
        `INSERT INTO ontology_terms (id, kind, name, description, status, metadata)
          VALUES ($1, $2, $3, $4, 'accepted', $5)
          ON CONFLICT (id) DO UPDATE SET status = 'accepted', updated_at = now()`,
        [
          `${row.target_kind}-${String(row.name).replaceAll(" ", "-")}`,
          row.target_kind,
          row.name,
          row.reason,
          row.proposed_change
        ]
      );
    }

    return { id, status: "accepted" };
  }
}

function kindFromFileName(fileName: string) {
  if (fileName === "memory-types.yaml") {
    return "memory_type";
  }
  return fileName.replace(".yaml", "").replace(/s$/, "");
}

