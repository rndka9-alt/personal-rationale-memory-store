import path from "node:path";
import { z } from "zod";

const embeddingModeSchema = z.enum(["standard", "contextualized", "mock"]);
const embeddingDtypeSchema = z.enum(["float", "int8", "uint8", "binary", "ubinary"]);
const mcpTransportSchema = z.enum(["stdio", "http", "https"]);
const optionalUrlSchema = z.preprocess(emptyStringToUndefined, z.string().url().optional());
const optionalEmailSchema = z.preprocess(emptyStringToUndefined, z.string().email().optional());

const environmentSchema = z.object({
  DATABASE_URL: z.string().default("postgres://rationale:rationale@localhost:54329/rationale_memory"),
  DATA_DIR: z.string().default(path.resolve(process.cwd(), "data/memory")),
  MCP_TRANSPORT: mcpTransportSchema.default("stdio"),
  MCP_HOST: z.string().default("127.0.0.1"),
  MCP_PORT: z.coerce.number().int().positive().default(3443),
  MCP_PATH: z.string().default("/mcp"),
  MCP_AUTH_TOKEN: z.string().optional(),
  MCP_TLS_CERT_PATH: z.string().optional(),
  MCP_TLS_KEY_PATH: z.string().optional(),
  MCP_PUBLIC_URL: optionalUrlSchema,
  MCP_OAUTH_ENABLED: z.string().default("false"),
  MCP_OAUTH_CLIENT_ID: z.string().default("mtdl-memory-mcp"),
  MCP_OAUTH_REDIRECT_URI: optionalUrlSchema,
  MCP_OAUTH_LOGIN_CODE: z.string().optional(),
  MCP_OAUTH_SIGNING_PRIVATE_KEY_PATH: z.preprocess(emptyStringToUndefined, z.string().optional()),
  MCP_OAUTH_SIGNING_PRIVATE_KEY_PEM: z.preprocess(emptyStringToUndefined, z.string().optional()),
  MCP_OAUTH_USER_SUBJECT: z.string().default("mtdl"),
  MCP_OAUTH_USER_EMAIL: optionalEmailSchema,
  MCP_OAUTH_USER_NAME: z.string().default("Rationale Memory Owner"),
  MCP_OAUTH_SCOPES: z.string().default("openid email profile rationale:read rationale:write"),
  MCP_OAUTH_REQUIRED_SCOPES: z.string().default("rationale:read rationale:write"),
  WEB_HOST: z.string().default("0.0.0.0"),
  WEB_PORT: z.coerce.number().int().positive().default(3450),
  WEB_AUTH_TOKEN: z.string().optional(),
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
  const oauthEnabled = parseBoolean(parsedEnvironment.MCP_OAUTH_ENABLED, "MCP_OAUTH_ENABLED");

  if (oauthEnabled) {
    if (!parsedEnvironment.MCP_PUBLIC_URL) {
      throw new Error("MCP_PUBLIC_URL is required when MCP_OAUTH_ENABLED=true.");
    }
    if (!parsedEnvironment.MCP_OAUTH_REDIRECT_URI) {
      throw new Error("MCP_OAUTH_REDIRECT_URI is required when MCP_OAUTH_ENABLED=true.");
    }
    if (!parsedEnvironment.MCP_OAUTH_LOGIN_CODE) {
      throw new Error("MCP_OAUTH_LOGIN_CODE is required when MCP_OAUTH_ENABLED=true.");
    }
    if (parsedEnvironment.MCP_OAUTH_SIGNING_PRIVATE_KEY_PATH && parsedEnvironment.MCP_OAUTH_SIGNING_PRIVATE_KEY_PEM) {
      throw new Error("Set only one of MCP_OAUTH_SIGNING_PRIVATE_KEY_PATH or MCP_OAUTH_SIGNING_PRIVATE_KEY_PEM.");
    }
  }

  return {
    databaseUrl: parsedEnvironment.DATABASE_URL,
    dataDirectory: parsedEnvironment.DATA_DIR,
    mcp: {
      transport: parsedEnvironment.MCP_TRANSPORT,
      host: parsedEnvironment.MCP_HOST,
      port: parsedEnvironment.MCP_PORT,
      path: normalizePath(parsedEnvironment.MCP_PATH),
      authToken: parsedEnvironment.MCP_AUTH_TOKEN,
      tlsCertPath: parsedEnvironment.MCP_TLS_CERT_PATH,
      tlsKeyPath: parsedEnvironment.MCP_TLS_KEY_PATH,
      oauth: {
        enabled: oauthEnabled,
        publicUrl: parsedEnvironment.MCP_PUBLIC_URL,
        clientId: parsedEnvironment.MCP_OAUTH_CLIENT_ID,
        redirectUri: parsedEnvironment.MCP_OAUTH_REDIRECT_URI,
        loginCode: parsedEnvironment.MCP_OAUTH_LOGIN_CODE,
        signingPrivateKeyPath: parsedEnvironment.MCP_OAUTH_SIGNING_PRIVATE_KEY_PATH,
        signingPrivateKeyPem: parsedEnvironment.MCP_OAUTH_SIGNING_PRIVATE_KEY_PEM,
        userSubject: parsedEnvironment.MCP_OAUTH_USER_SUBJECT,
        userEmail: parsedEnvironment.MCP_OAUTH_USER_EMAIL,
        userName: parsedEnvironment.MCP_OAUTH_USER_NAME,
        scopes: splitSpaceSeparatedList(parsedEnvironment.MCP_OAUTH_SCOPES),
        requiredScopes: splitSpaceSeparatedList(parsedEnvironment.MCP_OAUTH_REQUIRED_SCOPES)
      }
    },
    web: {
      host: parsedEnvironment.WEB_HOST,
      port: parsedEnvironment.WEB_PORT,
      authToken: parsedEnvironment.WEB_AUTH_TOKEN
    },
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

function normalizePath(value: string) {
  return value.startsWith("/") ? value : `/${value}`;
}

function parseBoolean(value: string, name: string) {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${name} must be "true" or "false".`);
}

function splitSpaceSeparatedList(value: string) {
  return value.split(/\s+/).filter((part) => part.length > 0);
}

function emptyStringToUndefined(value: unknown) {
  return value === "" ? undefined : value;
}
