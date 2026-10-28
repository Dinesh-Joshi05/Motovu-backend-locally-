import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware.js";
import { getMyMemberships } from "../controllers/membership.controller.js";

const router = Router();

router.use(authenticate);

router.get("/me", getMyMemberships);

export default router;
