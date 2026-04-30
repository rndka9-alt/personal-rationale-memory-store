import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";

export async function runMigrations(pool: pg.Pool, migrationsDirectory = path.resolve(process.cwd(), "migrations")) {
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort();

  for (const migrationFile of migrationFiles) {
    const migrationSql = await readFile(path.join(migrationsDirectory, migrationFile), "utf8");
    await pool.query(migrationSql);
  }
}

