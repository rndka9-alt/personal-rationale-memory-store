import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";

const migrationAdvisoryLockKey = 260519001;

export async function runMigrations(pool: pg.Pool, migrationsDirectory = path.resolve(process.cwd(), "migrations")) {
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort();

  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [migrationAdvisoryLockKey]);
    for (const migrationFile of migrationFiles) {
      const migrationSql = await readFile(path.join(migrationsDirectory, migrationFile), "utf8");
      await client.query(migrationSql);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [migrationAdvisoryLockKey]);
    client.release();
  }
}
