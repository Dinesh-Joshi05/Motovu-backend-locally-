import "dotenv/config";
import { Pool, type PoolClient } from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing from .env");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL error:", err);
});

/**
 * Beginner-Friendly RLS Helper:
 * Runs a query or transaction with the current user and organization RLS context set.
 * 
 * - Sets app.current_user_id for this transaction
 * - Sets app.current_org_id for this transaction
 * - Automatically rolls back on error and releases the connection
 */
export async function withTenantContext<T>(
  context: { userId?: string; orgId?: string },
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Switch to non-superuser app_user so PostgreSQL enforces Row Level Security (RLS)
    await client.query("SET LOCAL ROLE app_user");
    if (context.userId) {
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [context.userId]);
    }
    if (context.orgId) {
      await client.query("SELECT set_config('app.current_org_id', $1, true)", [context.orgId]);
    }
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
