import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware.js";
import { requireMembership } from "../middlewares/tenant.middleware.js";
import * as chatController from "../controllers/chat.controller.js";

const router = Router({ mergeParams: true });

// All chat routes require authentication and active organization membership
router.use(authenticate);
router.use(requireMembership);

// GET /api/organizations/:orgId/chat
router.get("/", chatController.getChat);

// GET /api/organizations/:orgId/chat/messages
router.get("/messages", chatController.getMessages);

// POST /api/organizations/:orgId/chat/messages
router.post("/messages", chatController.sendMessage);

export default router;

