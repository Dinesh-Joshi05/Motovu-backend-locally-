import { pool } from "../src/config/db.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, detail?: any) {
  if (condition) {
    console.log(`  \x1b[32m✔ PASS\x1b[0m: ${name}`);
    passed++;
  } else {
    console.error(`  \x1b[31m✖ FAIL\x1b[0m: ${name}`);
    if (detail) console.error("    Details:", detail);
    failed++;
  }
}

async function run() {
  console.log("\n=======================================================");
  console.log(" MOTOVU DATABASE ROW LEVEL SECURITY (RLS) TEST SUITE");
  console.log("=======================================================\n");

  const client = await pool.connect();
  try {
    // -------------------------------------------------------------
    // Step 1: Verify RLS is enabled and forced in Postgres catalog
    // -------------------------------------------------------------
    console.log("--- 1. Check PostgreSQL Catalog for RLS Status ---");

    const rlsCatalog = await client.query(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app' AND c.relname IN ('memberships', 'role_requests')
      ORDER BY c.relname;
    `);

    const memTable = rlsCatalog.rows.find((r: any) => r.relname === "memberships");
    const reqTable = rlsCatalog.rows.find((r: any) => r.relname === "role_requests");

    assert(Boolean(memTable?.relrowsecurity), "app.memberships has ROW LEVEL SECURITY enabled");
    assert(Boolean(memTable?.relforcerowsecurity), "app.memberships has FORCE ROW LEVEL SECURITY enabled");
    assert(Boolean(reqTable?.relrowsecurity), "app.role_requests has ROW LEVEL SECURITY enabled");
    assert(Boolean(reqTable?.relforcerowsecurity), "app.role_requests has FORCE ROW LEVEL SECURITY enabled");

    // -------------------------------------------------------------
    // Step 2: Verify Policies in pg_policies
    // -------------------------------------------------------------
    console.log("\n--- 2. Verify RLS Security Policies ---");

    const policies = await client.query(`
      SELECT tablename, policyname
      FROM pg_policies
      WHERE schemaname = 'app'
      ORDER BY tablename, policyname;
    `);

    const hasMemPolicy = policies.rows.some(
      (p: any) => p.tablename === "memberships" && p.policyname === "memberships_tenant_isolation"
    );
    const hasReqPolicy = policies.rows.some(
      (p: any) => p.tablename === "role_requests" && p.policyname === "role_requests_tenant_isolation"
    );

    assert(hasMemPolicy, "memberships_tenant_isolation policy is registered on app.memberships");
    assert(hasReqPolicy, "role_requests_tenant_isolation policy is registered on app.role_requests");

    // -------------------------------------------------------------
    // Step 3: Test Policy Isolation with a standard app_user role
    // -------------------------------------------------------------
    console.log("\n--- 3. Testing Database-Level Policy Enforcement ---");

    // Ensure non-superuser role exists for testing RLS enforcement
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
          CREATE ROLE app_user WITH LOGIN PASSWORD 'app_password';
        END IF;
      END
      $$;
    `);
    await client.query(`
      GRANT USAGE ON SCHEMA app TO app_user;
      GRANT ALL ON ALL TABLES IN SCHEMA app TO app_user;
      GRANT USAGE ON SCHEMA public TO app_user;
      GRANT ALL ON ALL TABLES IN SCHEMA public TO app_user;
    `);

    // Setup 2 test orgs and 2 test users
    const testOrgA = "11111111-aaaa-bbbb-cccc-111111111111";
    const testOrgB = "22222222-aaaa-bbbb-cccc-222222222222";
    const userAlice = "rls-test-user-alice";
    const userBob = "rls-test-user-bob";

    await client.query(`
      INSERT INTO app.organizations (id, name, status)
      VALUES ($1, 'RLS Test Org A', 'active'), ($2, 'RLS Test Org B', 'active')
      ON CONFLICT (id) DO NOTHING
    `, [testOrgA, testOrgB]);

    await client.query(`
      INSERT INTO public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      VALUES
        ($1, 'RLS Alice', 'alice-rls@test.com', true, NOW(), NOW()),
        ($2, 'RLS Bob', 'bob-rls@test.com', true, NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `, [userAlice, userBob]);

    await client.query(`
      INSERT INTO app.memberships (id, org_id, user_id, role, status)
      VALUES
        (gen_random_uuid(), $1, $2, 'org_admin', 'active'),
        (gen_random_uuid(), $3, $4, 'worker', 'active')
      ON CONFLICT (org_id, user_id) DO NOTHING
    `, [testOrgA, userAlice, testOrgB, userBob]);

    // Test A: No session context set -> Returns 0 rows (strict isolation)
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE app_user");
    const emptyContextQuery = await client.query("SELECT * FROM app.memberships");
    assert(
      emptyContextQuery.rows.length === 0,
      "Without RLS session variables: 0 rows returned (blocked by default)"
    );
    await client.query("ROLLBACK");

    // Test B: Alice's user context -> Returns ONLY Alice's records
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE app_user");
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [userAlice]);
    const aliceContextQuery = await client.query("SELECT * FROM app.memberships");
    assert(
      aliceContextQuery.rows.length === 1 && aliceContextQuery.rows[0].user_id === userAlice,
      "With Alice's current_user_id: Returns ONLY Alice's membership"
    );
    assert(
      !aliceContextQuery.rows.some((r: any) => r.user_id === userBob),
      "RLS strictly hides Bob's membership from Alice"
    );
    await client.query("ROLLBACK");

    // Test C: Org A context -> Returns ONLY members of Org A
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE app_user");
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [testOrgA]);
    const orgAContextQuery = await client.query("SELECT * FROM app.memberships");
    assert(
      orgAContextQuery.rows.length === 1 && orgAContextQuery.rows[0].org_id === testOrgA,
      "With Org A's current_org_id: Returns ONLY Org A members"
    );
    assert(
      !orgAContextQuery.rows.some((r: any) => r.org_id === testOrgB),
      "RLS strictly hides Org B members from Org A context"
    );
    await client.query("ROLLBACK");

    // Cleanup test records
    await client.query("DELETE FROM app.memberships WHERE user_id IN ($1, $2)", [userAlice, userBob]);
    await client.query("DELETE FROM app.organizations WHERE id IN ($1, $2)", [testOrgA, testOrgB]);
    await client.query('DELETE FROM public."user" WHERE id IN ($1, $2)', [userAlice, userBob]);

  } finally {
    client.release();
    await pool.end();
  }

  console.log("\n=======================================================");
  console.log(` RLS TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log("=======================================================\n");

  process.exitCode = failed > 0 ? 1 : 0;
}

run().catch(console.error);
