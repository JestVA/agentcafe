import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_LOCK_KEY = Number(process.env.API_DB_MIGRATION_LOCK_KEY || 942516431);

function checksum(sql) {
  return createHash("sha256").update(sql).digest("hex");
}

function defaultMigrationsDir() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
}

async function listMigrationFiles(migrationsDir) {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
}

export async function applyPostgresMigrations({
  pool,
  migrationsDir = defaultMigrationsDir(),
  lockKey = DEFAULT_LOCK_KEY
} = {}) {
  if (!pool) {
    return { applied: [], skipped: [] };
  }

  const client = await pool.connect();
  const applied = [];
  const skipped = [];

  try {
    await client.query("SELECT pg_advisory_lock($1)", [lockKey]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        migration_name TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const existing = await client.query("SELECT migration_name, checksum FROM schema_migrations");
    const appliedChecksums = new Map(
      existing.rows.map((row) => [String(row.migration_name), String(row.checksum)])
    );
    const files = await listMigrationFiles(migrationsDir);

    for (const file of files) {
      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      const digest = checksum(sql);
      const previous = appliedChecksums.get(file);

      if (previous) {
        if (previous !== digest) {
          throw new Error(
            `migration checksum mismatch for ${file}; existing=${previous} current=${digest}`
          );
        }
        skipped.push(file);
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          `
            INSERT INTO schema_migrations (migration_name, checksum, applied_at)
            VALUES ($1, $2, now())
          `,
          [file, digest]
        );
        await client.query("COMMIT");
        applied.push(file);
        appliedChecksums.set(file, digest);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [lockKey]);
    } catch {
      // no-op: unlocking errors should not hide the original failure
    }
    client.release();
  }

  return { applied, skipped };
}
