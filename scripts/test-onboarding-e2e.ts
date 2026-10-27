import "dotenv/config";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { pool } from "../src/config/db.js";

const BACKEND_URL = "http://localhost:5000";

const auth = betterAuth({
  database: pool,
  plugins: [jwt()],
  secret: process.env.BETTER_AUTH_SECRET || "xvmJsKNbiDLyjt7EKTiDCg1G7y1HCwRx",
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
});

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

async function signToken(user: { id: string; email: string; name: string }) {
  const result = await (auth.api as any).signJWT({
    body: {
      payload: {
        sub: user.id,
        email: user.email,
        name: user.name,
      },
    },
  });
  return result.token as string;
}

async function api(
  endpoint: string,
  options: { method?: string; token?: string; body?: any } = {}
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.token) headers["Authorization"] = `Bearer ${options.token}`;

  const res = await fetch(`${BACKEND_URL}${endpoint}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function run() {
  console.log("\n=======================================================");
  console.log(" OPTION A ONBOARDING WITH PLATFORM ADMIN APPROVAL TEST");
  console.log("=======================================================\n");

  const platformAdmin = { id: "test-super-admin", name: "Platform Admin", email: "platform-test@motovu.com" };
  const alice = { id: "new-user-alice", name: "Alice Founder", email: "alice-test@motovu.com" };

  console.log("[Setup] Creating users and generating tokens...");
  for (const u of [platformAdmin, alice]) {
    await pool.query(
      `INSERT INTO public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, true, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email`,
      [u.id, u.name, u.email]
    );
  }

  // Ensure platform admin status
  await pool.query(
    `INSERT INTO app.platform_admins (user_id)
     VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [platformAdmin.id]
  );

  const adminToken = await signToken(platformAdmin);
  const aliceToken = await signToken(alice);

  // Clean old test orgs and requests
  await pool.query(`DELETE FROM app.role_requests WHERE user_id IN ($1, $2)`, [platformAdmin.id, alice.id]);
  await pool.query(`DELETE FROM app.memberships WHERE user_id IN ($1, $2)`, [platformAdmin.id, alice.id]);
  await pool.query(`DELETE FROM app.organizations WHERE name = 'Apex Performance Garage'`);

  // =========================================================================
  // 1. Alice signs up and chooses Option A (Create New Organization)
  // =========================================================================
  console.log("--- 1. Alice chooses Option A (Create New Organization) ---");

  const createOrgRes = await api("/api/organizations", {
    method: "POST",
    token: aliceToken,
    body: { name: "Apex Performance Garage" },
  });

  assert(createOrgRes.status === 201, "Alice submits Option A via POST /api/organizations (201)", createOrgRes.data);
  const orgId = createOrgRes.data?.data?.organization?.id;
  const requestId = createOrgRes.data?.data?.request?.id;
  assert(Boolean(orgId), `Organization created with ID: ${orgId}`);
  assert(Boolean(requestId), `Pending role request created with ID: ${requestId}`);

  // DB Checks:
  const dbOrg = await pool.query("SELECT * FROM app.organizations WHERE id = $1", [orgId]);
  assert(dbOrg.rowCount === 1 && dbOrg.rows[0].name === "Apex Performance Garage", "DB: Organization created in app.organizations table");

  const dbReq = await pool.query("SELECT * FROM app.role_requests WHERE id = $1", [requestId]);
  assert(dbReq.rowCount === 1, "DB: Role request logged in app.role_requests");
  assert(dbReq.rows[0].requested_role === "org_admin", "DB: requested_role is 'org_admin'");
  assert(dbReq.rows[0].status === "pending", "DB: status is 'pending' (Awaiting Platform Admin approval!)");

  // Alice does NOT have active membership yet
  const aliceMems = await api("/api/memberships/me", { token: aliceToken });
  assert(
    aliceMems.data?.data?.length === 0,
    "Alice has 0 active memberships while request is pending"
  );
  assert(
    aliceMems.data?.roleRequests?.some((r: any) => r.id === requestId && r.status === "pending"),
    "Alice sees her pending org_admin role request"
  );

  // =========================================================================
  // 2. Platform Admin opens workspace in 2nd browser -> Sees pending request
  // =========================================================================
  console.log("\n--- 2. Platform Admin checks Workspace (Browser 2) ---");

  const adminPortalRes = await api("/api/memberships/me", { token: adminToken });
  assert(adminPortalRes.status === 200, "Platform Admin fetches workspace data (200)");
  assert(adminPortalRes.data?.isPlatformAdmin === true, "Platform Admin flag is true");

  const pendingList = adminPortalRes.data?.platformPendingRequests || [];
  const alicePendingReq = pendingList.find((r: any) => r.id === requestId);
  assert(Boolean(alicePendingReq), "Platform Admin sees Alice's pending request in platformPendingRequests!");
  assert(alicePendingReq?.user_email === alice.email, "Request identifies Alice's email");
  assert(alicePendingReq?.requested_role === "org_admin", "Request identifies role: 'org_admin'");
  assert(alicePendingReq?.organization_name === "Apex Performance Garage", "Request identifies Org Name: 'Apex Performance Garage'");

  // =========================================================================
  // 3. Platform Admin approves Alice's request
  // =========================================================================
  console.log("\n--- 3. Platform Admin Approves Alice's Request ---");

  const approveRes = await api(`/api/organizations/${orgId}/role-requests/${requestId}`, {
    method: "PATCH",
    token: adminToken,
    body: { action: "approved" },
  });
  assert(approveRes.status === 200, "Platform Admin approves Alice via PATCH role-request (200)", approveRes.data);

  // DB Verification:
  const dbReqApproved = await pool.query("SELECT * FROM app.role_requests WHERE id = $1", [requestId]);
  assert(dbReqApproved.rows[0].status === "approved", "DB: app.role_requests status is now 'approved'");
  assert(dbReqApproved.rows[0].reviewed_by === platformAdmin.id, "DB: reviewed_by is set to Platform Admin user_id");

  const dbAliceMem = await pool.query("SELECT * FROM app.memberships WHERE org_id = $1 AND user_id = $2", [orgId, alice.id]);
  assert(dbAliceMem.rowCount === 1, "DB: Alice is now inserted into app.memberships!");
  assert(dbAliceMem.rows[0].role === "org_admin", "DB: Alice's role is 'org_admin'");
  assert(dbAliceMem.rows[0].status === "active", "DB: Alice's membership status is 'active'");

  // =========================================================================
  // 4. Alice refreshes (Browser 1) -> Now full Org Admin!
  // =========================================================================
  console.log("\n--- 4. Alice Workspace Post-Approval ---");

  const aliceApprovedMems = await api("/api/memberships/me", { token: aliceToken });
  const aliceOrg = aliceApprovedMems.data?.data?.find((m: any) => m.org_id === orgId);
  assert(aliceOrg && aliceOrg.role === "org_admin", "Alice now has active 'org_admin' role in /api/memberships/me!");

  // Alice accesses admin routes
  const aliceAdminAudit = await api(`/api/organizations/${orgId}/admin/audit-log`, { token: aliceToken });
  assert(aliceAdminAudit.status === 200, "Alice now has full Org Admin access to the organization (200)");

  // =========================================================================
  // 5. Bob chooses Option B (Join Alice's Org as Worker)
  // =========================================================================
  console.log("\n--- 5. Bob chooses Option B (Join Alice's Org as Worker) ---");

  const bob = { id: "new-user-bob", name: "Bob Mechanic", email: "bob-test@motovu.com" };
  await pool.query(
    `INSERT INTO public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, true, NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email`,
    [bob.id, bob.name, bob.email]
  );
  const bobToken = await signToken(bob);

  const bobReqRes = await api(`/api/organizations/${orgId}/role-requests`, {
    method: "POST",
    token: bobToken,
    body: { requestedRole: "worker" },
  });
  assert(bobReqRes.status === 201, "Bob submits Option B via POST role-requests (201)", bobReqRes.data);
  const bobRequestId = bobReqRes.data?.data?.id;

  // =========================================================================
  // 6. Verify Platform Admin does NOT see Option B request
  // =========================================================================
  console.log("\n--- 6. Verify Platform Admin does NOT see Option B request ---");
  const adminPortalAfterBob = await api("/api/memberships/me", { token: adminToken });
  const platReqsAfterBob = adminPortalAfterBob.data?.platformPendingRequests || [];
  assert(
    !platReqsAfterBob.some((r: any) => r.id === bobRequestId),
    "Platform Admin CANNOT see Bob's Option B staff request (routes only to Org Admin!)"
  );

  // =========================================================================
  // 7. Alice (Org Admin) sees and approves Bob's Option B request
  // =========================================================================
  console.log("\n--- 7. Alice (Org Admin) sees and approves Bob's Option B request ---");
  const aliceOrgReqs = await api(`/api/organizations/${orgId}/role-requests?status=pending`, { token: aliceToken });
  assert(aliceOrgReqs.status === 200, "Alice fetches pending requests for her organization (200)");
  const bobInAliceList = aliceOrgReqs.data?.data?.find((r: any) => r.id === bobRequestId);
  assert(Boolean(bobInAliceList), "Alice (Org Admin) sees Bob's Option B request in her workshop portal!");
  assert(bobInAliceList?.requested_role === "worker", "Identifies requested role: 'worker'");

  // Alice approves Bob
  const aliceApproveBobRes = await api(`/api/organizations/${orgId}/role-requests/${bobRequestId}`, {
    method: "PATCH",
    token: aliceToken,
    body: { action: "approved" },
  });
  assert(aliceApproveBobRes.status === 200, "Alice (Org Admin) approves Bob's worker request (200)", aliceApproveBobRes.data);

  // Bob now has active worker role
  const bobApprovedMems = await api("/api/memberships/me", { token: bobToken });
  const bobMem = bobApprovedMems.data?.data?.find((m: any) => m.org_id === orgId);
  assert(bobMem && bobMem.role === "worker", "Bob now has active 'worker' role in Alice's organization!");

  // Bob can perform worker actions
  const workerTaskRes = await api(`/api/organizations/${orgId}/worker/tasks`, {
    method: "POST",
    token: bobToken,
    body: { taskId: "task-001", status: "in_progress" },
  });
  assert(workerTaskRes.status === 200, "Bob can execute worker task in Alice's organization (200)");

  // =========================================================================
  // CLEANUP
  // =========================================================================
  console.log("\n[Cleanup] Cleaning up test data...");
  await pool.query(`DELETE FROM app.role_requests WHERE user_id IN ($1, $2, $3)`, [platformAdmin.id, alice.id, bob.id]);
  await pool.query(`DELETE FROM app.memberships WHERE user_id IN ($1, $2, $3)`, [platformAdmin.id, alice.id, bob.id]);
  await pool.query(`DELETE FROM app.organizations WHERE id = $1`, [orgId]);
  await pool.query(`DELETE FROM app.platform_admins WHERE user_id = $1`, [platformAdmin.id]);
  await pool.query(`DELETE FROM public."user" WHERE id IN ($1, $2, $3)`, [platformAdmin.id, alice.id, bob.id]);

  console.log("\n=======================================================");
  console.log(` TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("=======================================================\n");

  await pool.end();
  process.exitCode = failed > 0 ? 1 : 0;
}

run();
