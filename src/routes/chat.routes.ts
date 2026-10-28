import { Router } from "express";
import multer from "multer";
import { authenticate } from "../middlewares/auth.middleware.js";
import { requireMembership } from "../middlewares/tenant.middleware.js";
import * as chatController from "../controllers/chat.controller.js";

const router = Router({ mergeParams: true });

// Configure Multer for in-memory file uploads with limits and image type validation
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB per file limit
    files: 5,                   // Maximum 5 files per message
  },
  fileFilter: (_req, file, cb) => {
    // Only accept images (JPEG, PNG, GIF, WebP, SVG, etc.)
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  },
});

// All chat routes require authentication and active organization membership
router.use(authenticate);
router.use(requireMembership);

// GET /api/organizations/:orgId/chat
router.get("/", chatController.getChat);

// GET /api/organizations/:orgId/chat/messages
router.get("/messages", chatController.getMessages);

// POST /api/organizations/:orgId/chat/messages (Supports text and/or images)
router.post("/messages", upload.array("files", 5), chatController.sendMessage);

// GET /api/organizations/:orgId/chat/attachments/:attachmentId
router.get("/attachments/:attachmentId", chatController.getAttachment);

export default router;
