import pg from "pg";
import { loadConfig } from "../config.js";

const { Pool } = pg;

export function createPool(databaseUrl = loadConfig().databaseUrl) {
  return new Pool({ connectionString: databaseUrl });
}

