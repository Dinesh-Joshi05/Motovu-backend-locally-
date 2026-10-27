import { pool } from "../src/config/db.js";

async function main() {
  const policies = await pool.query(
    "SELECT tablename, policyname, cmd, qual FROM pg_policies WHERE schemaname = 'app'"
  );
  console.log("POLICIES IN APP SCHEMA:", policies.rows);

  const rlsStatus = await pool.query(`
    SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app' AND c.relname IN ('memberships', 'role_requests')
  `);
  console.log("RLS STATUS:", rlsStatus.rows);

  await pool.end();
}

main().catch(console.error);
