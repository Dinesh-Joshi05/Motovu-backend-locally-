import { Server as SocketIOServer, Socket } from "socket.io";
import type { Server as HTTPServer } from "http";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { pool } from "./config/db.js";
import { sendChatMessage, type OutgoingAttachment } from "./services/chat.service.js";

const BETTER_AUTH_URL = process.env.BETTER_AUTH_URL || "http://localhost:3000";

const JWKS = createRemoteJWKSet(
  new URL("/api/auth/jwks", BETTER_AUTH_URL)
);

let ioInstance: SocketIOServer | null = null;

export function getIO(): SocketIOServer | null {
  return ioInstance;
}

export function initSocketServer(httpServer: HTTPServer) {
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  ioInstance = io;

  // Socket.IO Authentication Middleware
  io.use(async (socket: Socket, next) => {
    try {
      const rawToken =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization;

      if (!rawToken) {
        return next(new Error("Authentication token required"));
      }

      const token = rawToken.startsWith("Bearer ")
        ? rawToken.slice(7).trim()
        : rawToken.trim();

      const { payload } = await jwtVerify(token, JWKS, {
        issuer: BETTER_AUTH_URL,
        audience: BETTER_AUTH_URL,
      });

      const userId = payload.sub;
      if (!userId) {
        return next(new Error("Invalid token: missing subject"));
      }

      // Check if user is platform admin
      const adminCheck = await pool.query(
        "SELECT 1 FROM app.platform_admins WHERE user_id = $1",
        [userId]
      );

      socket.data.user = {
        id: userId,
        email: payload.email as string,
        name: payload.name as string,
        isPlatformAdmin: (adminCheck.rowCount ?? 0) > 0,
      };

      next();
    } catch (err: any) {
      console.error("Socket authentication error:", err.message);
      next(new Error("Authentication failed"));
    }
  });

  io.on("connection", (socket: Socket) => {
    const user = socket.data.user;
    console.log(`[Socket.io] User connected: ${user.name} (${user.id})`);

    // 1. Join Organization Chat Room
    socket.on("join_org_chat", async ({ orgId }, callback) => {
      try {
        if (!orgId) {
          if (callback) callback({ success: false, message: "orgId is required" });
          return;
        }

        // Verify active membership or platform admin
        if (!user.isPlatformAdmin) {
          const memberCheck = await pool.query(
            "SELECT id, role, status FROM app.memberships WHERE org_id = $1 AND user_id = $2 AND status = 'active'",
            [orgId, user.id]
          );

          if (memberCheck.rowCount === 0) {
            if (callback) {
              callback({
                success: false,
                message: "Forbidden: You are not an active member of this organization",
              });
            }
            return;
          }
        }

        const roomName = `org:${orgId}`;
        socket.join(roomName);
        console.log(`[Socket.io] ${user.name} joined room ${roomName}`);

        if (callback) {
          callback({ success: true, room: roomName });
        }
      } catch (error: any) {
        console.error("join_org_chat error:", error);
        if (callback) callback({ success: false, message: error.message });
      }
    });

    // 2. Leave Organization Chat Room
    socket.on("leave_org_chat", ({ orgId }) => {
      if (orgId) {
        const roomName = `org:${orgId}`;
        socket.leave(roomName);
        console.log(`[Socket.io] ${user.name} left room ${roomName}`);
      }
    });

    // 3. Send Message over Socket.io (Supports text and/or media attachments)
    socket.on("send_message", async ({ orgId, content, media }, callback) => {
      try {
        const rawContent = typeof content === "string" ? content.trim() : null;
        let attachments: OutgoingAttachment[] | undefined;

        if (Array.isArray(media) && media.length > 0) {
          attachments = media.map((m: any) => {
            const buf = Buffer.isBuffer(m.buffer)
              ? m.buffer
              : typeof m.buffer === "string"
              ? Buffer.from(m.buffer, "base64")
              : typeof m.base64 === "string"
              ? Buffer.from(m.base64, "base64")
              : Buffer.from(m.data || "");

            return {
              buffer: buf,
              originalFilename: m.filename || m.originalFilename || "image.png",
              contentType: m.contentType || "image/png",
              sizeBytes: m.sizeBytes || buf.length,
            };
          });
        }

        const hasAttachments = Boolean(attachments && attachments.length > 0);

        if (!orgId || (!rawContent && !hasAttachments)) {
          if (callback) {
            callback({
              success: false,
              message: "Missing orgId or message content/media",
            });
          }
          return;
        }

        // Save message using tenant context (respects RLS and membership verification)
        const message = await sendChatMessage(orgId, user.id, rawContent, attachments);

        const roomName = `org:${orgId}`;
        // Broadcast message to everyone in the organization room (including sender)
        io.to(roomName).emit("new_message", message);

        if (callback) {
          callback({ success: true, data: message });
        }
      } catch (error: any) {
        console.error("send_message error:", error);
        if (callback) callback({ success: false, message: error.message });
      }
    });

    socket.on("disconnect", () => {
      console.log(`[Socket.io] User disconnected: ${user.name}`);
    });
  });

  return io;
}
