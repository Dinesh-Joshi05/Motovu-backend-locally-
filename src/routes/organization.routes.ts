import { Router } from "express";
import { getOrganization } from "../controllers/organization.controller.js";

const router = Router();

router.get("/:orgId", getOrganization);

export default router;