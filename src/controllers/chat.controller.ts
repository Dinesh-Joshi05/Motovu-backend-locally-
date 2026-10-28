import type { Request, Response } from "express";
import {
  getOrganizationChat,
  getConversationMessages,
  sendChatMessage,
  getAttachmentStream,
  type OutgoingAttachment,
} from "../services/chat.service.js";
import { getIO } from "../socket.js";

/**
 * GET /api/organizations/:orgId/chat
 * Returns conversation details and members for this organization's company chat
 */
export async function getChat(req: Request, res: Response) {
  try {
    const orgId = res.locals.orgId;
    const userId = res.locals.user.id;

    const data = await getOrganizationChat(orgId, userId);
    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error: any) {
    console.error("getChat error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch company chat",
    });
  }
}

/**
 * GET /api/organizations/:orgId/chat/messages
 * Returns the messages (with media attachments) in this organization's company chat
 */
export async function getMessages(req: Request, res: Response) {
  try {
    const orgId = res.locals.orgId;
    const userId = res.locals.user.id;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 100;

    const messages = await getConversationMessages(orgId, userId, limit);
    return res.status(200).json({
      success: true,
      data: messages,
    });
  } catch (error: any) {
    console.error("getMessages error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to load chat messages",
    });
  }
}

/**
 * POST /api/organizations/:orgId/chat/messages
 * Sends a message in this organization's company chat.
 * Supports:
 * - Text messages
 * - Single or multiple image file attachments via multipart/form-data
 * - Text caption + image attachments
 */
export async function sendMessage(req: Request, res: Response) {
  try {
    const orgId = res.locals.orgId;
    const userId = res.locals.user.id;

    const content = req.body?.content;

    // Handle files parsed by multer (either array or single file)
    const rawFiles: Express.Multer.File[] = Array.isArray(req.files)
      ? (req.files as Express.Multer.File[])
      : req.file
      ? [req.file as Express.Multer.File]
      : [];

    const attachments: OutgoingAttachment[] = rawFiles.map((file) => ({
      buffer: file.buffer,
      originalFilename: file.originalname,
      contentType: file.mimetype,
      sizeBytes: file.size,
    }));

    const trimmedContent = typeof content === "string" ? content.trim() : "";

    if (!trimmedContent && attachments.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Message must contain text content or an attachment",
      });
    }

    const message = await sendChatMessage(orgId, userId, trimmedContent, attachments);

    // Real-time broadcast to all organization members in the Socket.IO room
    const io = getIO();
    if (io) {
      io.to(`org:${orgId}`).emit("new_message", message);
    }

    return res.status(201).json({
      success: true,
      message: "Message sent successfully",
      data: message,
    });
  } catch (error: any) {
    console.error("sendMessage error:", error);
    const status = error.message?.includes("Forbidden") ? 403 : 500;
    return res.status(status).json({
      success: false,
      message: error.message || "Failed to send message",
    });
  }
}

/**
 * GET /api/organizations/:orgId/chat/attachments/:attachmentId
 * Securely streams an attachment from MinIO.
 * Enforces tenant isolation via PostgreSQL RLS and organization membership.
 */
export async function getAttachment(req: Request, res: Response) {
  try {
    const orgId = res.locals.orgId;
    const userId = res.locals.user.id;
    const attachmentId = String(req.params.attachmentId);

    const { attachment, stream } = await getAttachmentStream(orgId, userId, attachmentId);

    res.setHeader("Content-Type", attachment.content_type);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(attachment.original_filename)}"`
    );
    res.setHeader("Cache-Control", "private, max-age=86400");

    stream.pipe(res);
  } catch (error: any) {
    console.error("getAttachment error:", error);
    const isNotFound = error.message?.includes("not found");
    return res.status(isNotFound ? 404 : 500).json({
      success: false,
      message: error.message || "Failed to load attachment",
    });
  }
}
