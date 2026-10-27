import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware.js";
import { requireMembership } from "../middlewares/tenant.middleware.js";
import {requireOrgAdmin,requireAdvisor,requireGuard,requireWorker,requireStoreKeeper} from "../middlewares/rbac.middleware.js";
import {handleCreateOrganization, handleListAllOrganizations,handleGetOrganization,handleUpdateOrganization,handleGetOrganizationMembers,handleAddMember,handleUpdateMemberRole,handleRemoveMember, handleCreateRoleRequest,handleListRoleRequests, handleReviewRoleRequest,handleGuardVehicleEntry,handleAdvisorJobCard,handleWorkerTaskUpdate,handleStoreKeeperDispatch,handleAdminAuditLog} from "../controllers/organization.controller.js";

const router = Router();

// All organization routes require authentication
router.use(authenticate);

// Organization Management
router.get("/", handleListAllOrganizations);
router.post("/", handleCreateOrganization);
router.get("/:orgId", requireMembership, handleGetOrganization);
router.patch("/:orgId",requireMembership,requireOrgAdmin,handleUpdateOrganization,);

// Membership Management (Admin only for modifications)
router.get("/:orgId/members", requireMembership, handleGetOrganizationMembers);
router.post("/:orgId/members",requireMembership,requireOrgAdmin,handleAddMember,);
router.patch("/:orgId/members/:memberId",requireMembership,requireOrgAdmin,handleUpdateMemberRole,);
router.delete("/:orgId/members/:memberId",requireMembership,requireOrgAdmin,handleRemoveMember,);

// Role Requests
router.post("/:orgId/role-requests", handleCreateRoleRequest);
router.get("/:orgId/role-requests",requireMembership,requireOrgAdmin,handleListRoleRequests,);
router.patch("/:orgId/role-requests/:requestId",requireMembership,requireOrgAdmin,handleReviewRoleRequest,);

// -------------------------------------------------------------
// Role-Specific Action Endpoints (Multi-Tenant RBAC)
// -------------------------------------------------------------

// Guard endpoint: vehicle entry logging
router.post("/:orgId/guard/entry",requireMembership,requireGuard,handleGuardVehicleEntry);

// Advisor endpoint: job card creation
router.post( "/:orgId/advisor/job-cards", requireMembership,requireAdvisor, handleAdvisorJobCard);

// Worker endpoint: service tasks execution
router.post( "/:orgId/worker/tasks", requireMembership, requireWorker, handleWorkerTaskUpdate);

// Store Keeper endpoint: inventory dispatch
router.post("/:orgId/store-keeper/inventory", requireMembership,requireStoreKeeper,handleStoreKeeperDispatch);

// Org Admin endpoint: administrative audit trail
router.get( "/:orgId/admin/audit-log", requireMembership, requireOrgAdmin, handleAdminAuditLog);

export default router;
