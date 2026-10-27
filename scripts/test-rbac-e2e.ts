import "dotenv/config";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { pool } from "../src/config/db.js";

const BACKEND_BASE = "http://localhost:5000";

const auth = betterAuth({
  database: pool,
  plugins: [jwt()],
  secret: process.env.BETTER_AUTH_SECRET || "xvmJsKNbiDLyjt7EKTiDCg1G7y1HCwRx",
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
});

interface TestUser {
  id: string;
  name: string;
  email: string;
  token?: string;
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: any) {
  if (condition) {
    console.log(`  \x1b[32m✔ PASS\x1b[0m: ${message}`);
    passed++;
  } else {
    console.error(`  \x1b[31m✖ FAIL\x1b[0m: ${message}`);
    if (detail) console.error("    Details:", detail);
    failed++;
  }
}

async function signToken(user: TestUser) {
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

async function request(
  endpoint: string,
  options: {
    method?: string;
    token?: string;
    body?: any;
    headers?: Record<string, string>;
  } = {}
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  if (options.token) {
    headers["Authorization"] = `Bearer ${options.token}`;
  }

  const res = await fetch(`${BACKEND_BASE}${endpoint}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  return { status: res.status, headers: res.headers, data };
}

async function run() {
  console.log("\n=======================================================");
  console.log(" MOTOVU MULTI-TENANT RBAC END-TO-END TEST SUITE");
  console.log("=======================================================\n");

  // 1. SEED DATA
  console.log("[Setup] Seeding test database entities...");

  const users: Record<string, TestUser> = {
    admin: { id: "test-user-admin-01", name: "Org Admin", email: "admin@motovu-test.com" },
    advisor: { id: "test-user-advisor-02", name: "Service Advisor", email: "advisor@motovu-test.com" },
    guard: { id: "test-user-guard-03", name: "Security Guard", email: "guard@motovu-test.com" },
    worker: { id: "test-user-worker-04", name: "Workshop Worker", email: "worker@motovu-test.com" },
    storekeeper: { id: "test-user-store-05", name: "Store Keeper", email: "store@motovu-test.com" },
    invited: { id: "test-user-invited-06", name: "Invited Worker", email: "invited@motovu-test.com" },
    outsider: { id: "test-user-outsider-07", name: "Outsider User", email: "outsider@motovu-test.com" },
    platformAdmin: { id: "test-user-super-08", name: "Platform Admin", email: "platform@motovu-test.com" },
  };

  // Upsert test users into public."user"
  for (const u of Object.values(users)) {
    await pool.query(
      `INSERT INTO public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, true, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email`,
      [u.id, u.name, u.email]
    );
    u.token = await signToken(u);
  }

  // Set platform admin
  await pool.query(
    `INSERT INTO app.platform_admins (user_id)
     VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [users.platformAdmin.id]
  );

  // Clean old test orgs
  await pool.query(`DELETE FROM app.role_requests WHERE user_id LIKE 'test-user-%'`);
  await pool.query(`DELETE FROM app.memberships WHERE user_id LIKE 'test-user-%'`);
  await pool.query(`DELETE FROM app.organizations WHERE name LIKE 'E2E Test Org%'`);

  // Create Organizations
  const org1Res = await pool.query(
    `INSERT INTO app.organizations (id, name, status)
     VALUES (gen_random_uuid(), 'E2E Test Org 1 - North Hub', 'active')
     RETURNING id, name, status`
  );
  const org1Id = org1Res.rows[0].id;

  const org2Res = await pool.query(
    `INSERT INTO app.organizations (id, name, status)
     VALUES (gen_random_uuid(), 'E2E Test Org 2 - South Hub', 'active')
     RETURNING id, name, status`
  );
  const org2Id = org2Res.rows[0].id;

  const org3SuspendedRes = await pool.query(
    `INSERT INTO app.organizations (id, name, status)
     VALUES (gen_random_uuid(), 'E2E Test Org 3 - Suspended Garage', 'suspended')
     RETURNING id, name, status`
  );
  const org3Id = org3SuspendedRes.rows[0].id;

  // Insert Memberships in Org 1
  const rolesInOrg1 = [
    { user: users.admin, role: "org_admin", status: "active" },
    { user: users.advisor, role: "advisor", status: "active" },
    { user: users.guard, role: "guard", status: "active" },
    { user: users.worker, role: "worker", status: "active" },
    { user: users.storekeeper, role: "store_keeper", status: "active" },
    { user: users.invited, role: "worker", status: "invited" },
  ];

  for (const item of rolesInOrg1) {
    await pool.query(
      `INSERT INTO app.memberships (id, org_id, user_id, role, status)
       VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
      [org1Id, item.user.id, item.role, item.status]
    );
  }

  // Insert Membership in Org 2 (Outsider is admin of Org 2 ONLY)
  await pool.query(
    `INSERT INTO app.memberships (id, org_id, user_id, role, status)
     VALUES (gen_random_uuid(), $1, $2, 'org_admin', 'active')`,
    [org2Id, users.outsider.id]
  );

  // Insert Membership in Org 3 (Suspended)
  await pool.query(
    `INSERT INTO app.memberships (id, org_id, user_id, role, status)
     VALUES (gen_random_uuid(), $1, $2, 'org_admin', 'active')`,
    [org3Id, users.admin.id]
  );

  console.log("  ✔ Seeding completed successfully.\n");

  // =========================================================================
  // STEP 1: JWT Verification
  // =========================================================================
  console.log("--- STEP 1: JWT Verification ---");

  // 1.1: No Bearer Token
  const noTokenRes = await request("/api/test/me");
  assert(noTokenRes.status === 401, "Rejects request without Bearer token (401)", noTokenRes.data);
  assert(noTokenRes.data?.message === "Missing Bearer token", "Response has clear 'Missing Bearer token' message");

  // 1.2: Tampered / Invalid Token
  const tamperedRes = await request("/api/test/me", { token: "invalid.tampered.token" });
  assert(tamperedRes.status === 401, "Rejects tampered / invalid token (401)", tamperedRes.data);
  assert(tamperedRes.data?.message === "Invalid or expired token", "Response has 'Invalid or expired token' message");

  // 1.3: Valid Signed Token
  const validTokenRes = await request("/api/test/me", { token: users.admin.token });
  assert(validTokenRes.status === 200, "Accepts valid Better Auth signed token (200)", validTokenRes.data);
  assert(validTokenRes.data?.success === true, "Response payload indicates success");

  // =========================================================================
  // STEP 2: Authentication Middleware
  // =========================================================================
  console.log("\n--- STEP 2: Authentication Middleware ---");

  assert(
    validTokenRes.data?.user?.id === users.admin.id,
    `Identifies user ID reliably: ${validTokenRes.data?.user?.id}`
  );
  assert(
    validTokenRes.data?.user?.isPlatformAdmin === false,
    "Correctly sets isPlatformAdmin: false for regular tenant admin"
  );

  // Platform admin check
  const platformAdminRes = await request("/api/test/me", { token: users.platformAdmin.token });
  assert(
    platformAdminRes.data?.user?.isPlatformAdmin === true,
    "Correctly sets isPlatformAdmin: true for platform administrator"
  );

  // =========================================================================
  // STEP 3: Membership Authorization
  // =========================================================================
  console.log("\n--- STEP 3: Membership Authorization ---");

  // 3.1: Current user memberships
  const workerMembershipsRes = await request("/api/memberships/me", { token: users.worker.token });
  assert(workerMembershipsRes.status === 200, "Worker fetches memberships via /api/memberships/me (200)");
  const workerOrg1 = workerMembershipsRes.data?.data?.find((m: any) => m.org_id === org1Id);
  assert(workerOrg1 && workerOrg1.role === "worker", "Worker role is correctly retrieved from app.memberships");

  // 3.2: Admin memberships
  const adminMembershipsRes = await request("/api/memberships/me", { token: users.admin.token });
  const adminOrgs = adminMembershipsRes.data?.data || [];
  assert(
    adminOrgs.some((m: any) => m.org_id === org1Id && m.role === "org_admin"),
    "Admin role correctly retrieved from app.memberships"
  );

  // =========================================================================
  // STEP 4: Organization Isolation (Cross-Tenant Security)
  // =========================================================================
  console.log("\n--- STEP 4: Organization Isolation ---");

  // 4.1: Cross-organization access attempt (Outsider is in Org 2, NOT Org 1)
  const crossTenantRes = await request(`/api/organizations/${org1Id}`, { token: users.outsider.token });
  assert(
    crossTenantRes.status === 403,
    "Organization Isolation: Outsider accessing Org 1 is BLOCKED (403)",
    crossTenantRes.data
  );
  assert(
    crossTenantRes.data?.message?.includes("Forbidden"),
    "Forbidden error message returned for cross-tenant breach attempt"
  );

  // 4.2: Worker in Org 1 attempting to view Org 2
  const workerCrossRes = await request(`/api/organizations/${org2Id}`, { token: users.worker.token });
  assert(
    workerCrossRes.status === 403,
    "Organization Isolation: Worker in Org 1 accessing Org 2 is BLOCKED (403)"
  );

  // 4.3: Suspended Organization Access
  const suspendedRes = await request(`/api/organizations/${org3Id}`, { token: users.admin.token });
  assert(
    suspendedRes.status === 403,
    "Organization Isolation: Access to suspended organization is BLOCKED (403)",
    suspendedRes.data
  );
  assert(
    suspendedRes.data?.message?.includes("Organization is suspended"),
    "Proper suspended reason provided"
  );

  // 4.4: Inactive/Invited membership status
  const invitedRes = await request(`/api/organizations/${org1Id}`, { token: users.invited.token });
  assert(
    invitedRes.status === 403,
    "Organization Isolation: Inactive ('invited') member is BLOCKED (403)",
    invitedRes.data
  );

  // 4.5: Valid active member accessing Org 1
  const validMemberRes = await request(`/api/organizations/${org1Id}`, { token: users.worker.token });
  assert(
    validMemberRes.status === 200,
    "Active member successfully accesses their own organization (200)"
  );

  // =========================================================================
  // STEP 5: Role-Based Permissions (RBAC Enforcement for All 5 Roles)
  // =========================================================================
  console.log("\n--- STEP 5: Role-Based Permissions (RBAC) ---");

  // 5.1 GUARD ROLE
  console.log("  [Guard Role Tests]");
  const guardOk = await request(`/api/organizations/${org1Id}/guard/entry`, {
    method: "POST",
    token: users.guard.token,
    body: { vehicleNumber: "DL-01-AB-1234", driverName: "John Doe" },
  });
  assert(guardOk.status === 200, "Guard can log vehicle check-in (200)", guardOk.data);

  const guardDeniedJobCard = await request(`/api/organizations/${org1Id}/advisor/job-cards`, {
    method: "POST",
    token: users.guard.token,
    body: { vehicleNumber: "DL-01-AB-1234", serviceDetails: "Brake service" },
  });
  assert(guardDeniedJobCard.status === 403, "Guard is DENIED opening job card (403)");

  const guardDeniedInventory = await request(`/api/organizations/${org1Id}/store-keeper/inventory`, {
    method: "POST",
    token: users.guard.token,
    body: { partNumber: "OIL-FILTER-01", quantity: 2 },
  });
  assert(guardDeniedInventory.status === 403, "Guard is DENIED inventory dispatch (403)");

  // 5.2 ADVISOR ROLE
  console.log("  [Advisor Role Tests]");
  const advisorOk = await request(`/api/organizations/${org1Id}/advisor/job-cards`, {
    method: "POST",
    token: users.advisor.token,
    body: { vehicleNumber: "MH-02-CD-5678", serviceDetails: "Full oil & brake overhaul" },
  });
  assert(advisorOk.status === 201, "Advisor can open job card (201)", advisorOk.data);

  const advisorDeniedWorker = await request(`/api/organizations/${org1Id}/worker/tasks`, {
    method: "POST",
    token: users.advisor.token,
    body: { taskId: "TASK-101", status: "completed" },
  });
  assert(advisorDeniedWorker.status === 403, "Advisor is DENIED worker task update (403)");

  const advisorDeniedAudit = await request(`/api/organizations/${org1Id}/admin/audit-log`, {
    token: users.advisor.token,
  });
  assert(advisorDeniedAudit.status === 403, "Advisor is DENIED admin audit log (403)");

  // 5.3 WORKER ROLE
  console.log("  [Worker Role Tests]");
  const workerOk = await request(`/api/organizations/${org1Id}/worker/tasks`, {
    method: "POST",
    token: users.worker.token,
    body: { taskId: "TASK-202", status: "in_progress", notes: "Replaced spark plugs" },
  });
  assert(workerOk.status === 200, "Worker can update repair task (200)", workerOk.data);

  const workerDeniedGuard = await request(`/api/organizations/${org1Id}/guard/entry`, {
    method: "POST",
    token: users.worker.token,
    body: { vehicleNumber: "KA-03-EF-9999" },
  });
  assert(workerDeniedGuard.status === 403, "Worker is DENIED guard check-in (403)");

  const workerDeniedInventory = await request(`/api/organizations/${org1Id}/store-keeper/inventory`, {
    method: "POST",
    token: users.worker.token,
    body: { partNumber: "SPARK-PLUG", quantity: 4 },
  });
  assert(workerDeniedInventory.status === 403, "Worker is DENIED inventory dispatch (403)");

  // 5.4 STORE KEEPER ROLE
  console.log("  [Store Keeper Role Tests]");
  const storeOk = await request(`/api/organizations/${org1Id}/store-keeper/inventory`, {
    method: "POST",
    token: users.storekeeper.token,
    body: { partNumber: "DISC-BRAKE-09", quantity: 1, jobCardId: "JC-001" },
  });
  assert(storeOk.status === 200, "Store Keeper can dispatch parts (200)", storeOk.data);

  const storeDeniedWorker = await request(`/api/organizations/${org1Id}/worker/tasks`, {
    method: "POST",
    token: users.storekeeper.token,
    body: { taskId: "TASK-303", status: "done" },
  });
  assert(storeDeniedWorker.status === 403, "Store Keeper is DENIED worker task update (403)");

  // 5.5 ORG ADMIN ROLE
  console.log("  [Org Admin Role Tests]");
  const adminAudit = await request(`/api/organizations/${org1Id}/admin/audit-log`, {
    token: users.admin.token,
  });
  assert(adminAudit.status === 200, "Org Admin can view administrative audit log (200)", adminAudit.data);

  const adminMembersList = await request(`/api/organizations/${org1Id}/members`, {
    token: users.admin.token,
  });
  assert(adminMembersList.status === 200, "Org Admin can view organization member list (200)");
  assert(adminMembersList.data?.data?.length >= 5, "Member list returns all tenant members");

  const adminPatchOrg = await request(`/api/organizations/${org1Id}`, {
    method: "PATCH",
    token: users.admin.token,
    body: { name: "E2E Test Org 1 - Updated Name" },
  });
  assert(adminPatchOrg.status === 200, "Org Admin can update organization settings (200)");

  // Non-admin trying to update org settings
  const workerPatchOrg = await request(`/api/organizations/${org1Id}`, {
    method: "PATCH",
    token: users.worker.token,
    body: { name: "Hacked Org Name" },
  });
  assert(workerPatchOrg.status === 403, "Worker is DENIED updating organization settings (403)");

  // =========================================================================
  // STEP 6: Role Requests & Dynamic Membership Lifecycle
  // =========================================================================
  console.log("\n--- STEP 6: Role Requests Lifecycle & Promotion ---");

  // 6.1: Outsider submits role request for Org 1 as 'advisor'
  const createReqRes = await request(`/api/organizations/${org1Id}/role-requests`, {
    method: "POST",
    token: users.outsider.token,
    body: { requestedRole: "advisor" },
  });
  assert(createReqRes.status === 201, "User can submit a role request for an organization (201)");
  const roleReqId = createReqRes.data?.data?.id;

  // 6.2: Org Admin views pending requests
  const listReqRes = await request(`/api/organizations/${org1Id}/role-requests?status=pending`, {
    token: users.admin.token,
  });
  assert(listReqRes.status === 200, "Org Admin can list pending role requests (200)");
  assert(
    listReqRes.data?.data?.some((r: any) => r.id === roleReqId),
    "Submitted role request is in the pending list"
  );

  // 6.3: Org Admin approves the role request
  const approveRes = await request(`/api/organizations/${org1Id}/role-requests/${roleReqId}`, {
    method: "PATCH",
    token: users.admin.token,
    body: { action: "approved" },
  });
  assert(approveRes.status === 200, "Org Admin approves role request (200)", approveRes.data);
  assert(approveRes.data?.data?.membership?.role === "advisor", "Membership record created with 'advisor' role");

  // 6.4: The newly approved user can now access Org 1 as an advisor!
  const outsiderNowAdvisor = await request(`/api/organizations/${org1Id}/advisor/job-cards`, {
    method: "POST",
    token: users.outsider.token,
    body: { vehicleNumber: "DL-PROMOTED-01", serviceDetails: "First advisor action after approval" },
  });
  assert(
    outsiderNowAdvisor.status === 201,
    "Promoted user now immediately has access to Advisor operations in Org 1 (201)",
    outsiderNowAdvisor.data
  );

  // =========================================================================
  // CLEANUP & REPORT
  // =========================================================================
  console.log("\n[Cleanup] Cleaning up temporary test entities...");
  await pool.query(`DELETE FROM app.role_requests WHERE user_id LIKE 'test-user-%'`);
  await pool.query(`DELETE FROM app.memberships WHERE user_id LIKE 'test-user-%'`);
  await pool.query(`DELETE FROM app.organizations WHERE name LIKE 'E2E Test Org%'`);
  await pool.query(`DELETE FROM app.platform_admins WHERE user_id = $1`, [users.platformAdmin.id]);
  for (const u of Object.values(users)) {
    await pool.query(`DELETE FROM public."user" WHERE id = $1`, [u.id]);
  }
  await pool.end();

  console.log("\n=======================================================");
  console.log(` TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log("=======================================================\n");

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

run().catch((err) => {
  console.error("Unhandled test runner exception:", err);
  process.exit(1);
});
