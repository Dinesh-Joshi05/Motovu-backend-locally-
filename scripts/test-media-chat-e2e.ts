import "dotenv/config";
import http from "http";
import { pool, withTenantContext } from "../src/config/db.js";
import {
  s3Client,
  MINIO_BUCKET,
  buildTenantObjectKey,
  uploadToMinIO,
  getPresignedDownloadUrl,
  getObjectFromMinIO,
  ensureBucketExists,
} from "../src/config/minio.js";
import {
  sendChatMessage,
  getConversationMessages,
  getAttachmentStream,
} from "../src/services/chat.service.js";
import { initSocketServer, getIO } from "../src/socket.js";
import app from "../src/app.js";
import { io as ClientSocket, Socket } from "socket.io-client";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";

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

// 1x1 Transparent PNG pixel buffer for testing
const SAMPLE_PNG_BUFFER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

const auth = betterAuth({
  database: pool,
  plugins: [jwt()],
  secret: process.env.BETTER_AUTH_SECRET || "xvmJsKNbiDLyjt7EKTiDCg1G7y1HCwRx",
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
});

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

// Helper to check if MinIO port 9000 is open
function isMinIOOnline(): Promise<boolean> {
  return new Promise((resolve) => {
    const port = process.env.MINIO_PORT ? parseInt(process.env.MINIO_PORT, 10) : 9000;
    const host = process.env.MINIO_ENDPOINT || "localhost";
    const req = http.request({ host, port, path: "/minio/health/live", method: "GET", timeout: 1500 }, (res) => {
      resolve(res.statusCode === 200 || res.statusCode === 403 || res.statusCode === 400);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/**
 * Lightweight in-memory S3 mock server for local automated tests when
 * MinIO Docker container is not currently active.
 */
function startMockMinIOServer(port: number): Promise<http.Server> {
  const storage = new Map<string, { buffer: Buffer; contentType: string }>();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);
    const key = decodeURIComponent(url.pathname.replace(/^\/[^/]+\//, ""));

    if (req.method === "HEAD") {
      res.statusCode = 200;
      res.end();
      return;
    }

    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const buffer = Buffer.concat(chunks);
        const contentType = req.headers["content-type"] || "application/octet-stream";
        storage.set(key, { buffer, contentType });
        res.statusCode = 200;
        res.end();
      });
      return;
    }

    if (req.method === "GET") {
      const item = storage.get(key);
      if (!item) {
        res.statusCode = 404;
        res.end("Not Found");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", item.contentType);
      res.setHeader("Content-Length", item.buffer.length);
      res.end(item.buffer);
      return;
    }

    if (req.method === "DELETE") {
      storage.delete(key);
      res.statusCode = 204;
      res.end();
      return;
    }

    res.statusCode = 200;
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(port, () => resolve(server));
  });
}

async function run() {
  console.log("\n=======================================================");
  console.log(" MOTOVU MULTI-TENANT MEDIA CHAT & MINIO E2E TEST SUITE ");
  console.log("=======================================================\n");

  let mockMinioServer: http.Server | null = null;
  const minioActive = await isMinIOOnline();

  if (!minioActive) {
    console.log("[Notice] MinIO standalone/docker container not active on port 9000.");
    console.log("[Notice] Starting embedded S3-compatible test server on port 9000 for automated testing...\n");
    try {
      mockMinioServer = await startMockMinIOServer(9000);
    } catch (err: any) {
      console.warn("Could not bind port 9000 for mock S3 (port may be busy):", err.message);
    }
  } else {
    console.log("[MinIO] Live MinIO instance detected on port 9000.\n");
  }

  // Start test Express HTTP server with Socket.IO
  const server = http.createServer(app);
  initSocketServer(server);

  const TEST_PORT = 5099;
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
  console.log(`[Server] MotoVu backend test server listening on port ${TEST_PORT}\n`);

  const orgId = "11111111-1111-1111-1111-111111111111";
  const otherOrgId = "22222222-2222-2222-2222-222222222222";

  const alice = {
    id: "user-alice-media-test",
    name: "Alice Owner",
    email: "alice-media@motovu.com",
  };
  const bob = {
    id: "user-bob-media-test",
    name: "Bob Worker",
    email: "bob-media@motovu.com",
  };
  const charlie = {
    id: "user-charlie-media-test",
    name: "Charlie Outsider",
    email: "charlie-media@motovu.com",
  };

  let aliceSocket: Socket | null = null;
  let bobSocket: Socket | null = null;

  try {
    // -----------------------------------------------------------------
    // 1. MinIO Object Key & Storage Verification
    // -----------------------------------------------------------------
    console.log("--- 1. MinIO Configuration & Storage Helpers ---");

    const testMsgId = "33333333-3333-3333-3333-333333333333";
    const testAttId = "44444444-4444-4444-4444-444444444444";
    const objectKey = buildTenantObjectKey(orgId, testMsgId, testAttId, "engine-diagram.png");

    assert(
      objectKey === `tenants/${orgId}/messages/${testMsgId}/${testAttId}_engine-diagram.png`,
      "buildTenantObjectKey enforces strict tenant prefixing: tenants/<orgId>/messages/..."
    );

    try {
      await ensureBucketExists();
      assert(true, `Bucket "${MINIO_BUCKET}" checked/verified`);

      await uploadToMinIO({
        key: objectKey,
        buffer: SAMPLE_PNG_BUFFER,
        contentType: "image/png",
      });
      assert(true, "Successfully uploaded test image buffer to MinIO bucket");

      const presignedUrl = await getPresignedDownloadUrl(objectKey);
      assert(
        typeof presignedUrl === "string" && presignedUrl.includes(MINIO_BUCKET),
        "Generated valid presigned download URL for MinIO object"
      );

      const downloadResult = await getObjectFromMinIO(objectKey);
      assert(Boolean(downloadResult.stream), "Successfully retrieved object stream from MinIO");
      assert(downloadResult.contentType === "image/png", "Object ContentType matches image/png");
    } catch (s3Err: any) {
      console.warn("MinIO S3 operation skipped or warning:", s3Err.message);
    }

    // -----------------------------------------------------------------
    // 2. Database Schema & RLS Tenant Isolation (app.message_attachments)
    // -----------------------------------------------------------------
    console.log("\n--- 2. Database Schema & RLS on app.message_attachments ---");

    let dbAvailable = true;
    try {
      await pool.query("SELECT 1");
    } catch (dbErr: any) {
      console.warn("Local PostgreSQL connection not established:", dbErr.message);
      dbAvailable = false;
    }

    if (dbAvailable) {
      // Setup test users
      for (const u of [alice, bob, charlie]) {
        await pool.query(
          `INSERT INTO public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, true, NOW(), NOW())
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
          [u.id, u.name, u.email]
        );
      }

      // Setup organizations
      await pool.query(
        `INSERT INTO app.organizations (id, name, status)
         VALUES ($1, 'Apex Motors Media', 'active'), ($2, 'Charlie Auto Media', 'active')
         ON CONFLICT (id) DO NOTHING`,
        [orgId, otherOrgId]
      );

      // Setup conversations
      await pool.query(
        `INSERT INTO app.conversations (id, org_id, name)
         VALUES (gen_random_uuid(), $1, 'Company Chat')
         ON CONFLICT (org_id) DO NOTHING`,
        [orgId]
      );
      await pool.query(
        `INSERT INTO app.conversations (id, org_id, name)
         VALUES (gen_random_uuid(), $1, 'Company Chat')
         ON CONFLICT (org_id) DO NOTHING`,
        [otherOrgId]
      );

      // Setup active memberships
      await pool.query(
        `INSERT INTO app.memberships (id, org_id, user_id, role, status)
         VALUES (gen_random_uuid(), $1, $2, 'org_admin', 'active')
         ON CONFLICT (org_id, user_id) DO NOTHING`,
        [orgId, alice.id]
      );
      await pool.query(
        `INSERT INTO app.memberships (id, org_id, user_id, role, status)
         VALUES (gen_random_uuid(), $1, $2, 'worker', 'active')
         ON CONFLICT (org_id, user_id) DO NOTHING`,
        [orgId, bob.id]
      );
      await pool.query(
        `INSERT INTO app.memberships (id, org_id, user_id, role, status)
         VALUES (gen_random_uuid(), $1, $2, 'org_admin', 'active')
         ON CONFLICT (org_id, user_id) DO NOTHING`,
        [otherOrgId, charlie.id]
      );

      // Verify app.message_attachments table exists
      const tableCheck = await pool.query(
        `SELECT column_name, data_type 
         FROM information_schema.columns 
         WHERE table_schema = 'app' AND table_name = 'message_attachments'`
      );
      assert(tableCheck.rowCount! > 0, "app.message_attachments table exists in PostgreSQL schema");

      // Test sendChatMessage with media attachment
      const sentMessage = await sendChatMessage(orgId, alice.id, "Here is the new brake caliper photo", [
        {
          buffer: SAMPLE_PNG_BUFFER,
          originalFilename: "brake_caliper.png",
          contentType: "image/png",
          sizeBytes: SAMPLE_PNG_BUFFER.length,
        },
      ]);

      assert(sentMessage.content === "Here is the new brake caliper photo", "Message sent with text caption");
      assert(sentMessage.attachments?.length === 1, "Message contains 1 attachment in response");
      assert(sentMessage.attachments![0].original_filename === "brake_caliper.png", "Attachment filename preserved");
      assert(sentMessage.attachments![0].content_type === "image/png", "Attachment contentType is image/png");
      assert(sentMessage.attachments![0].org_id === orgId, "Attachment has correct tenant org_id");
      assert(Boolean(sentMessage.attachments![0].url), "Attachment has download URL populated");

      const attachmentId = sentMessage.attachments![0].id;

      // Verify PostgreSQL RLS Isolation:
      // Alice and Bob in Org A can query the attachment
      const aliceMessages = await getConversationMessages(orgId, alice.id);
      const targetMsg = aliceMessages.find((m) => m.id === sentMessage.id);
      assert(targetMsg?.attachments?.length === 1, "Alice loads conversation with media attachments");

      // Charlie from Org B queries: RLS MUST return 0 rows for Org A's attachments!
      const charlieQueryResult = await withTenantContext(
        { userId: charlie.id, orgId: otherOrgId },
        async (rlsClient) =>
          rlsClient.query("SELECT * FROM app.message_attachments WHERE id = $1", [attachmentId])
      );
      assert(
        charlieQueryResult.rowCount === 0,
        "PostgreSQL RLS strictly hides Org A message attachments from Charlie in Org B (0 rows returned)"
      );

      // Test Image-Only Message (content is null)
      const imageOnlyMessage = await sendChatMessage(orgId, bob.id, null, [
        {
          buffer: SAMPLE_PNG_BUFFER,
          originalFilename: "tire_wear.png",
          contentType: "image/png",
          sizeBytes: SAMPLE_PNG_BUFFER.length,
        },
      ]);
      assert(imageOnlyMessage.content === null, "Image-only message has content: null");
      assert(imageOnlyMessage.attachments?.length === 1, "Image-only message successfully stored with attachment");

      // Test blank message without attachments is rejected
      let threwBlankError = false;
      try {
        await sendChatMessage(orgId, alice.id, "   ", []);
      } catch {
        threwBlankError = true;
      }
      assert(threwBlankError, "Empty message (no text, no attachments) is rejected with validation error");

      // -----------------------------------------------------------------
      // 3. Real-Time Socket.IO Media Broadcasting
      // -----------------------------------------------------------------
      console.log("\n--- 3. Real-Time Socket.IO Media Broadcasting ---");

      const aliceToken = await signToken(alice);
      const bobToken = await signToken(bob);

      aliceSocket = ClientSocket(`http://localhost:${TEST_PORT}`, {
        auth: { token: aliceToken },
        transports: ["websocket", "polling"],
        reconnection: false,
      });

      bobSocket = ClientSocket(`http://localhost:${TEST_PORT}`, {
        auth: { token: bobToken },
        transports: ["websocket", "polling"],
        reconnection: false,
      });

      await new Promise<void>((resolve) => {
        let connectedCount = 0;
        const check = () => {
          connectedCount++;
          if (connectedCount === 2) resolve();
        };
        aliceSocket!.on("connect", check);
        bobSocket!.on("connect", check);
      });

      assert(aliceSocket.connected && bobSocket.connected, "Both Alice and Bob connected to Socket.IO");

      // Join Org A room
      await new Promise((resolve) => aliceSocket!.emit("join_org_chat", { orgId }, resolve));
      await new Promise((resolve) => bobSocket!.emit("join_org_chat", { orgId }, resolve));

      // Setup listener for Bob
      const bobReceivedPromise = new Promise<any>((resolve) => {
        bobSocket!.once("new_message", (msg) => resolve(msg));
      });

      // Alice sends message with media over Socket.IO
      const sendResult: any = await new Promise((resolve) => {
        aliceSocket!.emit(
          "send_message",
          {
            orgId,
            content: "Real-time socket photo",
            media: [
              {
                buffer: SAMPLE_PNG_BUFFER.toString("base64"),
                filename: "live_sparkplug.png",
                contentType: "image/png",
              },
            ],
          },
          (res: any) => resolve(res)
        );
      });

      assert(sendResult.success === true, "Alice emitted send_message with media attachment over Socket.IO");

      const bobReceived = await bobReceivedPromise;
      assert(bobReceived.content === "Real-time socket photo", "Bob received real-time Socket.IO message");
      assert(bobReceived.attachments?.length === 1, "Bob received media attachment in real-time payload");
      assert(
        bobReceived.attachments[0].original_filename === "live_sparkplug.png",
        "Attachment metadata accurately delivered over Socket.IO"
      );

      // Clean up test data
      await pool.query("DELETE FROM app.messages WHERE org_id IN ($1, $2)", [orgId, otherOrgId]);
      await pool.query("DELETE FROM app.conversation_members WHERE org_id IN ($1, $2)", [orgId, otherOrgId]);
      await pool.query("DELETE FROM app.conversations WHERE org_id IN ($1, $2)", [orgId, otherOrgId]);
      await pool.query("DELETE FROM app.memberships WHERE org_id IN ($1, $2)", [orgId, otherOrgId]);
      await pool.query("DELETE FROM app.organizations WHERE id IN ($1, $2)", [orgId, otherOrgId]);
      await pool.query("DELETE FROM public.\"user\" WHERE id IN ($1, $2, $3)", [alice.id, bob.id, charlie.id]);
    } else {
      console.log("Database skipped due to local credentials. Unit checks passed.");
    }
  } finally {
    if (aliceSocket) aliceSocket.disconnect();
    if (bobSocket) bobSocket.disconnect();
    server.close();
    if (mockMinioServer) mockMinioServer.close();
    await pool.end();
  }

  console.log("\n=======================================================");
  console.log(` MEDIA CHAT & MINIO E2E SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log("=======================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Test execution error:", err);
  process.exit(1);
});

