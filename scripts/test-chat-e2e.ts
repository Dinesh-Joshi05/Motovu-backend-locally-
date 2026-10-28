import "dotenv/config";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { pool, withTenantContext } from "../src/config/db.js";
import { io as ClientSocket, Socket } from "socket.io-client";

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:5000";

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

function connectSocket(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = ClientSocket(BACKEND_URL, {
      auth: { token },
      transports: ["websocket", "polling"],
      reconnection: false,
    });

    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", (err) => reject(err));
  });
}

async function run() {
  console.log("\n=======================================================");
  console.log(" MOTOVU MULTI-TENANT SOCKET.IO & RLS END-TO-END TEST SUITE");
  console.log("=======================================================\n");

  const platformAdmin = {
    id: "test-admin-chat",
    name: "Platform Admin",
    email: "platform-chat@motovu.com",
  };
  const alice = {
    id: "user-alice-chat",
    name: "Alice Owner",
    email: "alice-chat@motovu.com",
  };
  const bob = {
    id: "user-bob-chat",
    name: "Bob Worker",
    email: "bob-chat@motovu.com",
  };
  const charlie = {
    id: "user-charlie-chat",
    name: "Charlie Outsider",
    email: "charlie-chat@motovu.com",
  };

  console.log("[Setup] Creating users and generating tokens...");
  for (const u of [platformAdmin, alice, bob, charlie]) {
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
  const bobToken = await signToken(bob);
  const charlieToken = await signToken(charlie);

  // Clean old test entities
  await pool.query(`DELETE FROM app.messages WHERE sender_membership_id IN (SELECT id FROM app.memberships WHERE user_id IN ($1, $2, $3, $4))`, [
    platformAdmin.id,
    alice.id,
    bob.id,
    charlie.id,
  ]);
  await pool.query(`DELETE FROM app.role_requests WHERE user_id IN ($1, $2, $3, $4)`, [
    platformAdmin.id,
    alice.id,
    bob.id,
    charlie.id,
  ]);
  await pool.query(`DELETE FROM app.memberships WHERE user_id IN ($1, $2, $3, $4)`, [
    platformAdmin.id,
    alice.id,
    bob.id,
    charlie.id,
  ]);
  await pool.query(`DELETE FROM app.organizations WHERE name IN ('Apex Moto Chat', 'Charlie Shop Chat')`);

  let orgId = "";
  let reqId = "";
  let conversationId = "";
  let aliceSocket: Socket | null = null;
  let bobSocket: Socket | null = null;
  let charlieSocket: Socket | null = null;

  try {
    // -------------------------------------------------------------
    // 1. OPTION A: Alice creates new Organization "Apex Moto Chat"
    // -------------------------------------------------------------
    console.log("--- 1. Option A: Create Org & Verify Chat NOT Created Before Approval ---");

    const createOrgRes = await api("/api/organizations", {
      method: "POST",
      token: aliceToken,
      body: { name: "Apex Moto Chat" },
    });

    assert(createOrgRes.status === 201, "Alice submits Option A via POST /api/organizations (201)", createOrgRes.data);
    orgId = createOrgRes.data?.data?.organization?.id;
    reqId = createOrgRes.data?.data?.request?.id;
    assert(Boolean(orgId), `Organization created with ID: ${orgId}`);
    assert(Boolean(reqId), `Pending role request created with ID: ${reqId}`);

    // Check DB: Chat room should NOT exist before approval!
    const convBeforeApproval = await pool.query(
      "SELECT id FROM app.conversations WHERE org_id = $1",
      [orgId]
    );
    assert(convBeforeApproval.rowCount === 0, "No chat room exists before approval in DB");

    // -------------------------------------------------------------
    // 2. Platform Admin Approves Option A
    // -------------------------------------------------------------
    console.log("\n--- 2. Platform Admin Approves Option A -> Chat Room Created Automatically ---");

    const approveAliceRes = await api(`/api/organizations/${orgId}/role-requests/${reqId}`, {
      method: "PATCH",
      token: adminToken,
      body: { action: "approved" },
    });
    assert(approveAliceRes.status === 200, "Platform admin approves Alice's Option A request (200)", approveAliceRes.data);

    // Check DB: Chat room MUST now be automatically created!
    const convAfterApproval = await pool.query(
      "SELECT id, org_id, name FROM app.conversations WHERE org_id = $1",
      [orgId]
    );
    assert(convAfterApproval.rowCount === 1, "Company Chat room automatically created in app.conversations!");
    conversationId = convAfterApproval.rows[0].id;

    // Check DB: Alice must be in app.conversation_members!
    const aliceConvMem = await pool.query(
      `SELECT cm.* FROM app.conversation_members cm
       JOIN app.memberships m ON m.id = cm.membership_id
       WHERE cm.conversation_id = $1 AND m.user_id = $2`,
      [conversationId, alice.id]
    );
    assert(aliceConvMem.rowCount === 1, "Alice is automatically added to conversation_members as org_admin");

    // -------------------------------------------------------------
    // 3. OPTION B: Bob requests to join existing org as 'worker'
    // -------------------------------------------------------------
    console.log("\n--- 3. Option B: Bob Requests to Join -> NOT in Chat Before Approval ---");

    const bobJoinRes = await api(`/api/organizations/${orgId}/role-requests`, {
      method: "POST",
      token: bobToken,
      body: { requestedRole: "worker" },
    });
    assert(bobJoinRes.status === 201, "Bob submits Option B join request as worker (201)");
    const bobReqId = bobJoinRes.data?.data?.id;

    // Check DB: Bob is NOT in conversation_members
    const bobConvMemBefore = await pool.query(
      `SELECT cm.* FROM app.conversation_members cm
       JOIN app.memberships m ON m.id = cm.membership_id
       WHERE cm.conversation_id = $1 AND m.user_id = $2`,
      [conversationId, bob.id]
    );
    assert(bobConvMemBefore.rowCount === 0, "Bob is NOT in chat group while join request is pending");

    // -------------------------------------------------------------
    // 4. Alice (Org Admin) Approves Bob (Option B)
    // -------------------------------------------------------------
    console.log("\n--- 4. Org Admin Approves Option B -> Bob Automatically Added to Chat ---");

    const approveBobRes = await api(`/api/organizations/${orgId}/role-requests/${bobReqId}`, {
      method: "PATCH",
      token: aliceToken,
      body: { action: "approved" },
    });
    assert(approveBobRes.status === 200, "Alice (Org Admin) approves Bob's Option B request (200)");

    // Check DB: Bob is now in conversation_members!
    const bobConvMemAfter = await pool.query(
      `SELECT cm.* FROM app.conversation_members cm
       JOIN app.memberships m ON m.id = cm.membership_id
       WHERE cm.conversation_id = $1 AND m.user_id = $2`,
      [conversationId, bob.id]
    );
    assert(bobConvMemAfter.rowCount === 1, "Bob is automatically added to conversation_members upon approval!");

    // -------------------------------------------------------------
    // 5. Real-Time Socket.IO Tests: Connect, Join Room, Bi-directional Chat
    // -------------------------------------------------------------
    console.log("\n--- 5. Real-Time Socket.IO Messaging Tests ---");

    aliceSocket = await connectSocket(aliceToken);
    assert(aliceSocket.connected, "Alice successfully connected to Socket.IO server");

    bobSocket = await connectSocket(bobToken);
    assert(bobSocket.connected, "Bob successfully connected to Socket.IO server");

    // Alice joins organization room
    const aliceJoinResult: any = await new Promise((resolve) => {
      aliceSocket!.emit("join_org_chat", { orgId }, (resp: any) => resolve(resp));
    });
    assert(aliceJoinResult.success === true, "Alice joins Socket.IO room org:" + orgId);

    // Bob joins organization room
    const bobJoinResult: any = await new Promise((resolve) => {
      bobSocket!.emit("join_org_chat", { orgId }, (resp: any) => resolve(resp));
    });
    assert(bobJoinResult.success === true, "Bob joins Socket.IO room org:" + orgId);

    // Setup listener on Bob's socket to catch Alice's incoming message
    const bobReceivedPromise = new Promise<any>((resolve) => {
      bobSocket!.once("new_message", (msg) => resolve(msg));
    });

    // Alice sends real-time message via Socket.IO
    const aliceSendResult: any = await new Promise((resolve) => {
      aliceSocket!.emit(
        "send_message",
        { orgId, content: "Live Socket.IO message from Alice!" },
        (resp: any) => resolve(resp)
      );
    });
    assert(aliceSendResult.success === true, "Alice sends message via Socket.IO emit");

    // Bob receives message in real time
    const bobReceivedMsg = await bobReceivedPromise;
    assert(bobReceivedMsg.content === "Live Socket.IO message from Alice!", "Bob receives Alice's message in real time over Socket.IO");
    assert(bobReceivedMsg.sender_name === "Alice Owner", "Sender name is Alice Owner");
    assert(bobReceivedMsg.sender_role === "org_admin", "Sender role is org_admin");
    assert(bobReceivedMsg.sender_user_id === alice.id, "Message contains sender_user_id matching Alice");
    assert(bobReceivedMsg.sender_user_id !== bob.id, "For Bob, sender_user_id does NOT match Bob");

    // Setup listener on Alice's socket to catch Bob's reply
    const aliceReceivedPromise = new Promise<any>((resolve) => {
      aliceSocket!.once("new_message", (msg) => resolve(msg));
    });

    // Bob sends reply via Socket.IO
    const bobSendResult: any = await new Promise((resolve) => {
      bobSocket!.emit(
        "send_message",
        { orgId, content: "Got it instantly, Alice! Socket.IO is blazing fast." },
        (resp: any) => resolve(resp)
      );
    });
    assert(bobSendResult.success === true, "Bob sends reply via Socket.IO emit");

    // Alice receives Bob's reply in real time
    const aliceReceivedMsg = await aliceReceivedPromise;
    assert(
      aliceReceivedMsg.content === "Got it instantly, Alice! Socket.IO is blazing fast.",
      "Alice receives Bob's reply in real time over Socket.IO"
    );
    assert(aliceReceivedMsg.sender_role === "worker", "Bob's role tag is worker");

    // -------------------------------------------------------------
    // 6. Multi-tenancy Isolation & RLS Enforcement over Socket.IO & API
    // -------------------------------------------------------------
    console.log("\n--- 6. Multi-Tenancy & Row Level Security (RLS) Enforcement ---");

    // Charlie belongs to another organization
    const charlieOrgRes = await api("/api/organizations", {
      method: "POST",
      token: charlieToken,
      body: { name: "Charlie Shop Chat" },
    });
    const charlieOrgId = charlieOrgRes.data?.data?.organization?.id;
    const charlieReqId = charlieOrgRes.data?.data?.request?.id;

    // Approve Charlie in his own shop
    await api(`/api/organizations/${charlieOrgId}/role-requests/${charlieReqId}`, {
      method: "PATCH",
      token: adminToken,
      body: { action: "approved" },
    });

    charlieSocket = await connectSocket(charlieToken);
    assert(charlieSocket.connected, "Charlie connected to Socket.IO");

    // Charlie attempts to join Alice's org chat room
    const charlieJoinBreach: any = await new Promise((resolve) => {
      charlieSocket!.emit("join_org_chat", { orgId }, (resp: any) => resolve(resp));
    });
    assert(charlieJoinBreach.success === false, "Charlie is BLOCKED from joining Org A Socket.IO room");

    // Charlie attempts to send message to Alice's org via Socket.IO
    const charlieSendBreach: any = await new Promise((resolve) => {
      charlieSocket!.emit(
        "send_message",
        { orgId, content: "Unauthorized intrusion message!" },
        (resp: any) => resolve(resp)
      );
    });
    assert(charlieSendBreach.success === false, "Charlie is BLOCKED from sending Socket.IO message to Org A");

    // Direct Database RLS Test: Query with Charlie's tenant context against app.messages
    const rlsQueryResult = await withTenantContext(
      { userId: charlie.id, orgId: charlieOrgId },
      async (rlsClient) => {
        return rlsClient.query(
          "SELECT * FROM app.messages WHERE conversation_id = $1",
          [conversationId]
        );
      }
    );
    assert(
      rlsQueryResult.rowCount === 0,
      "PostgreSQL RLS strictly hides Org A messages from Charlie (returns 0 rows)"
    );

    // -------------------------------------------------------------
    // Cleanup test data
    // -------------------------------------------------------------
    console.log("\n[Cleanup] Cleaning up test entities...");
    if (aliceSocket) aliceSocket.disconnect();
    if (bobSocket) bobSocket.disconnect();
    if (charlieSocket) charlieSocket.disconnect();

    await pool.query("DELETE FROM app.messages WHERE org_id IN ($1, $2)", [orgId, charlieOrgId]);
    await pool.query("DELETE FROM app.conversation_members WHERE org_id IN ($1, $2)", [orgId, charlieOrgId]);
    await pool.query("DELETE FROM app.conversations WHERE org_id IN ($1, $2)", [orgId, charlieOrgId]);
    await pool.query("DELETE FROM app.role_requests WHERE org_id IN ($1, $2)", [orgId, charlieOrgId]);
    await pool.query("DELETE FROM app.memberships WHERE org_id IN ($1, $2)", [orgId, charlieOrgId]);
    await pool.query("DELETE FROM app.organizations WHERE id IN ($1, $2)", [orgId, charlieOrgId]);
    await pool.query("DELETE FROM app.platform_admins WHERE user_id = $1", [platformAdmin.id]);
    await pool.query("DELETE FROM public.\"user\" WHERE id IN ($1, $2, $3, $4)", [
      platformAdmin.id,
      alice.id,
      bob.id,
      charlie.id,
    ]);

  } finally {
    if (aliceSocket) aliceSocket.disconnect();
    if (bobSocket) bobSocket.disconnect();
    if (charlieSocket) charlieSocket.disconnect();
    await pool.end();
  }

  console.log("\n=======================================================");
  console.log(` SOCKET.IO & CHAT E2E TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log("=======================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Test execution failed with unexpected error:", err);
  process.exit(1);
});
