import type { Request, Response } from "express";
import {
  getOrganizationChat,
  getConversationMessages,
  sendChatMessage,
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
 * Returns the messages in this organization's company chat
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
 * Sends a message in this organization's company chat
 */
export async function sendMessage(req: Request, res: Response) {
  try {
    const orgId = res.locals.orgId;
    const userId = res.locals.user.id;
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({
        success: false,
        message: "Message content cannot be blank",
      });
    }

    const message = await sendChatMessage(orgId, userId, content);

    // Broadcast to Socket.IO organization room if initialized
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

