import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware.js";
import { getMyMemberships } from "../controllers/membership.controller.js";

const router = Router();

router.use(authenticate);

// Get all organization memberships for the current user
router.get("/me", getMyMemberships);

export default router;
