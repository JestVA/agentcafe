export async function createPostgresPool({
  connectionString = process.env.DATABASE_URL || "",
  required = String(process.env.API_DB_REQUIRED || "false").toLowerCase() === "true",
  max = Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis = Number(process.env.PG_IDLE_TIMEOUT_MS || 30000)
} = {}) {
  const target = String(connectionString || "").trim();
  if (!target) {
    if (required) {
      throw new Error("API_DB_REQUIRED=true but DATABASE_URL is not set");
    }
    return null;
  }

  let Pool;
  try {
    ({ Pool } = await import("pg"));
  } catch (error) {
    if (required) {
      throw new Error(
        `DATABASE_URL is set but "pg" package is unavailable (${error instanceof Error ? error.message : String(error)})`
      );
    }
    return null;
  }

  const pool = new Pool({
    connectionString: target,
    max: Math.max(1, max),
    idleTimeoutMillis: Math.max(1000, idleTimeoutMillis)
  });

  try {
    await pool.query("SELECT 1");
    return pool;
  } catch (error) {
    await pool.end().catch(() => {});
    if (required) {
      throw error;
    }
    return null;
  }
}
