import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware.js";
import { requireMembership } from "../middlewares/tenant.middleware.js";
import { requireOrgAdmin } from "../middlewares/rbac.middleware.js";
import * as org from "../controllers/organization.controller.js";
import chatRoutes from "./chat.routes.js";

const router = Router();

router.use(authenticate);

// Platform Admin: list all organizations with their members
router.get("/all-with-members", org.listAllOrganizationsWithMembers);

// Organizations
router.get("/", org.listOrganizations);
router.post("/", org.createOrganization);
router.get("/:orgId", requireMembership, org.getOrganization);
router.patch("/:orgId", requireMembership, requireOrgAdmin, org.updateOrganization);

// Members
router.get("/:orgId/members", requireMembership, org.getMembers);
router.post("/:orgId/members", requireMembership, requireOrgAdmin, org.addMember);
router.patch("/:orgId/members/:memberId", requireMembership, requireOrgAdmin, org.updateMemberRole);
router.delete("/:orgId/members/:memberId", requireMembership, requireOrgAdmin, org.removeMember);

// Role requests
router.post("/:orgId/role-requests", org.createRoleRequest);
router.get("/:orgId/role-requests", requireMembership, requireOrgAdmin, org.listRoleRequests);
router.patch("/:orgId/role-requests/:requestId", requireMembership, requireOrgAdmin, org.reviewRoleRequest);

// Chat
router.use("/:orgId/chat", chatRoutes);

export default router;
