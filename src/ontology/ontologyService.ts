import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type pg from "pg";
import { z } from "zod";
import { logInfo } from "../diagnostics/index.js";

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
    logInfo("Loading ontology registry started.", {
      ontologyDirectory
    });
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
      logInfo("Loading ontology file.", {
        fileName,
        kind,
        termCount: parsed.terms.length
      });
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

    logInfo("Loading ontology registry completed.", {
      fileCount: fileNames.length,
      termCount: terms.length
    });
    return terms;
  }

  async proposeOntologyChange(input: unknown) {
    const parsedInput = proposalInputSchema.parse(input);
    const id = `OP${new Date().toISOString().replaceAll("-", "").replaceAll(":", "").replaceAll(".", "")}`;
    logInfo("Proposing ontology change started.", {
      proposalId: id,
      proposalType: parsedInput.proposalType,
      targetKind: parsedInput.targetKind,
      name: parsedInput.name
    });
    await this.pool.query(
      `INSERT INTO ontology_proposals (id, proposal_type, target_kind, name, reason, proposed_change)
        VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, parsedInput.proposalType, parsedInput.targetKind, parsedInput.name, parsedInput.reason, parsedInput.proposedChange]
    );

    const proposalPath = path.join(this.dataDirectory, "ontology", "proposals", `${id}.yaml`);
    await mkdir(path.dirname(proposalPath), { recursive: true });
    await writeFile(proposalPath, YAML.stringify({ id, ...parsedInput, status: "proposed" }), "utf8");
    logInfo("Proposing ontology change completed.", {
      proposalId: id,
      proposalPath
    });
    return { id, proposalPath };
  }

  async acceptOntologyProposal(id: string) {
    logInfo("Accepting ontology proposal started.", {
      proposalId: id
    });
    const result = await this.pool.query("SELECT * FROM ontology_proposals WHERE id = $1", [id]);
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Ontology proposal not found: ${id}`);
    }

    const proposal = parseProposalRow(row);
    await applyAcceptedProposal(this.pool, proposal);
    await this.pool.query(
      "UPDATE ontology_proposals SET status = 'accepted', decided_at = now() WHERE id = $1",
      [id]
    );
    await this.writeProposalFile({
      id: proposal.id,
      proposalType: proposal.proposalType,
      targetKind: proposal.targetKind,
      name: proposal.name,
      reason: proposal.reason,
      proposedChange: proposal.proposedChange,
      status: "accepted"
    });

    logInfo("Accepting ontology proposal completed.", {
      proposalId: id,
      proposalType: proposal.proposalType
    });
    return { id, status: "accepted" };
  }

  private async writeProposalFile(proposal: {
    id: string;
    proposalType: string;
    targetKind: string;
    name: string;
    reason: string;
    proposedChange: Record<string, unknown>;
    status: string;
  }) {
    const proposalPath = path.join(this.dataDirectory, "ontology", "proposals", `${proposal.id}.yaml`);
    await mkdir(path.dirname(proposalPath), { recursive: true });
    await writeFile(proposalPath, YAML.stringify(proposal), "utf8");
  }
}

type OntologyProposal = {
  id: string;
  proposalType: "add" | "deprecate" | "rename" | "merge" | "split";
  targetKind: "intent" | "domain" | "mode" | "memory_type" | "routing_policy";
  name: string;
  reason: string;
  proposedChange: Record<string, unknown>;
};

async function applyAcceptedProposal(pool: pg.Pool, proposal: OntologyProposal) {
  if (proposal.proposalType === "add") {
    const termId = readOptionalString(proposal.proposedChange.id) ?? createTermId(proposal.targetKind, proposal.name);
    const description = readOptionalString(proposal.proposedChange.description) ?? proposal.reason;
    await upsertOntologyTerm(pool, {
      id: termId,
      kind: proposal.targetKind,
      name: proposal.name,
      description,
      status: "accepted",
      metadata: proposal.proposedChange
    });
    return;
  }

  if (proposal.proposalType === "deprecate") {
    const targetId = readRequiredString(proposal.proposedChange.targetId, "targetId");
    await updateOntologyTermStatus(pool, targetId, "deprecated", {
      deprecated_reason: proposal.reason,
      proposal_id: proposal.id
    });
    return;
  }

  if (proposal.proposalType === "rename") {
    const targetId = readRequiredString(proposal.proposedChange.targetId, "targetId");
    const newName = readOptionalString(proposal.proposedChange.newName) ?? proposal.name;
    await pool.query(
      `UPDATE ontology_terms
        SET name = $2,
            metadata = metadata || $3::jsonb,
            updated_at = now()
        WHERE id = $1`,
      [targetId, newName, { rename_reason: proposal.reason, proposal_id: proposal.id }]
    );
    return;
  }

  if (proposal.proposalType === "merge") {
    const sourceIds = readStringArray(proposal.proposedChange.sourceIds, "sourceIds");
    const targetId = readRequiredString(proposal.proposedChange.targetId, "targetId");
    for (const sourceId of sourceIds) {
      await updateOntologyTermStatus(pool, sourceId, "deprecated", {
        deprecated_reason: proposal.reason,
        merged_into: targetId,
        proposal_id: proposal.id
      });
    }
    return;
  }

  const sourceId = readRequiredString(proposal.proposedChange.sourceId, "sourceId");
  const newTerms = readNewTerms(proposal.proposedChange.newTerms);
  for (const term of newTerms) {
    await upsertOntologyTerm(pool, {
      id: term.id,
      kind: proposal.targetKind,
      name: term.name,
      description: term.description ?? proposal.reason,
      status: "accepted",
      metadata: {
        split_from: sourceId,
        proposal_id: proposal.id
      }
    });
  }
  await updateOntologyTermStatus(pool, sourceId, "deprecated", {
    deprecated_reason: proposal.reason,
    split_into: newTerms.map((term) => term.id),
    proposal_id: proposal.id
  });
}

async function upsertOntologyTerm(pool: pg.Pool, term: {
  id: string;
  kind: string;
  name: string;
  description: string;
  status: string;
  metadata: Record<string, unknown>;
}) {
  await pool.query(
    `INSERT INTO ontology_terms (id, kind, name, description, status, metadata)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO UPDATE SET
        kind = EXCLUDED.kind,
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        status = EXCLUDED.status,
        metadata = ontology_terms.metadata || EXCLUDED.metadata,
        updated_at = now()`,
    [term.id, term.kind, term.name, term.description, term.status, term.metadata]
  );
}

async function updateOntologyTermStatus(
  pool: pg.Pool,
  id: string,
  status: string,
  metadataPatch: Record<string, unknown>
) {
  await pool.query(
    `UPDATE ontology_terms
      SET status = $2,
          metadata = metadata || $3::jsonb,
          updated_at = now()
      WHERE id = $1`,
    [id, status, metadataPatch]
  );
}

function parseProposalRow(row: pg.QueryResultRow): OntologyProposal {
  return proposalInputSchema.extend({
    id: z.string().min(1)
  }).transform((value) => ({
    id: value.id,
    proposalType: value.proposalType,
    targetKind: value.targetKind,
    name: value.name,
    reason: value.reason,
    proposedChange: value.proposedChange
  })).parse({
    id: row.id,
    proposalType: row.proposal_type,
    targetKind: row.target_kind,
    name: row.name,
    reason: row.reason,
    proposedChange: row.proposed_change
  });
}

function createTermId(kind: string, name: string) {
  return `${kind}-${name.toLowerCase().replaceAll(" ", "-")}`;
}

function readRequiredString(value: unknown, fieldName: string) {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  throw new Error(`Ontology proposal requires proposedChange.${fieldName}.`);
}

function readOptionalString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readStringArray(value: unknown, fieldName: string) {
  if (Array.isArray(value) && value.every(isString)) {
    return value;
  }

  throw new Error(`Ontology proposal requires proposedChange.${fieldName} as a string array.`);
}

function readNewTerms(value: unknown) {
  if (!Array.isArray(value)) {
    throw new Error("Ontology split proposal requires proposedChange.newTerms.");
  }

  return value.map((item) => z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional()
  }).parse(item));
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function kindFromFileName(fileName: string) {
  if (fileName === "memory-types.yaml") {
    return "memory_type";
  }
  return fileName.replace(".yaml", "").replace(/s$/, "");
}
