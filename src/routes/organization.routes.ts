import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware.js";
import { requireMembership } from "../middlewares/tenant.middleware.js";
import { requireOrgAdmin } from "../middlewares/rbac.middleware.js";
import * as org from "../controllers/organization.controller.js";

const router = Router();

router.use(authenticate);

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

export default router;
