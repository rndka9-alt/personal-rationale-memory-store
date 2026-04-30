import path from "node:path";
import { z } from "zod";

const embeddingModeSchema = z.enum(["standard", "contextualized", "mock"]);
const embeddingDtypeSchema = z.enum(["float", "int8", "uint8", "binary", "ubinary"]);

const environmentSchema = z.object({
  DATABASE_URL: z.string().default("postgres://rationale:rationale@localhost:54329/rationale_memory"),
  DATA_DIR: z.string().default(path.resolve(process.cwd(), "data/memory")),
  VOYAGE_API_KEY: z.string().optional(),
  EMBEDDING_PROVIDER: z.string().default("mock"),
  EMBEDDING_MODEL: z.string().default("mock"),
  EMBEDDING_DIMENSION: z.coerce.number().int().positive().default(1024),
  EMBEDDING_DTYPE: embeddingDtypeSchema.default("float"),
  EMBEDDING_MODE: embeddingModeSchema.default("mock")
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsedEnvironment = environmentSchema.parse(environment);
  const provider = parsedEnvironment.EMBEDDING_PROVIDER;
  const mode = parsedEnvironment.EMBEDDING_MODE;
  const shouldUseVoyageDefaults = provider === "voyage" && mode !== "mock";

  return {
    databaseUrl: parsedEnvironment.DATABASE_URL,
    dataDirectory: parsedEnvironment.DATA_DIR,
    embedding: {
      provider,
      model: parsedEnvironment.EMBEDDING_MODEL === "mock" && shouldUseVoyageDefaults
        ? "voyage-context-3"
        : parsedEnvironment.EMBEDDING_MODEL,
      dimension: parsedEnvironment.EMBEDDING_DIMENSION,
      dtype: parsedEnvironment.EMBEDDING_DTYPE,
      mode,
      voyageApiKey: parsedEnvironment.VOYAGE_API_KEY
    }
  };
}

