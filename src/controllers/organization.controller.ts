import type { Request, Response } from "express";
import {
  createOrganization as createOrgService,
  getAllOrganizations,
  getAllOrganizationsWithMembers,
  getOrganizationById,
  updateOrganization as updateOrgService,
  getOrganizationMembers,
  addOrganizationMember,
  updateMemberRole as updateMemberRoleService,
  removeOrganizationMember,
} from "../services/organization.service.js";
import {
  createRoleRequest as createRoleRequestService,
  listOrganizationRoleRequests,
  reviewRoleRequest as reviewRoleRequestService,
} from "../services/role-request.service.js";
import type { OrganizationRole } from "../types/rbac.js";

const VALID_ROLES: OrganizationRole[] = [
  "org_admin",
  "advisor",
  "guard",
  "worker",
  "store_keeper",
];

export async function listOrganizations(_req: Request, res: Response) {
  try {
    const orgs = await getAllOrganizations();
    return res.status(200).json({ success: true, data: orgs });
  } catch (error) {
    console.error("listOrganizations error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

/**
 * GET /api/organizations/all-with-members
 * Platform Admin view: lists all organizations along with their members
 */
export async function listAllOrganizationsWithMembers(_req: Request, res: Response) {
  try {
    const isPlatformAdmin = Boolean(res.locals.user?.isPlatformAdmin);
    if (!isPlatformAdmin) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: Platform administrator privileges required",
      });
    }

    const data = await getAllOrganizationsWithMembers();
    return res.status(200).json({ success: true, data });
  } catch (error: any) {
    console.error("listAllOrganizationsWithMembers error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
}

export async function createOrganization(req: Request, res: Response) {
  try {
    const userId = res.locals.user?.id;
    const { name } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ success: false, message: "Organization name is required" });
    }

    const result = await createOrgService(name.trim(), userId);
    return res.status(201).json({
      success: true,
      message: "Organization created successfully",
      data: result,
    });
  } catch (error: any) {
    console.error("createOrganization error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
}

export async function getOrganization(_req: Request, res: Response) {
  try {
    const orgId = res.locals.orgId;
    const organization = await getOrganizationById(orgId);

    return res.status(200).json({
      success: true,
      data: {
        organization,
        currentUserRole: res.locals.orgRole,
      },
    });
  } catch (error) {
    console.error("getOrganization error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function updateOrganization(req: Request, res: Response) {
  try {
    const orgId = res.locals.orgId;
    const { name, status } = req.body;

    if (status && !["active", "suspended"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status. Allowed: 'active', 'suspended'",
      });
    }

    const updated = await updateOrgService(orgId, { name, status });
    return res.status(200).json({
      success: true,
      message: "Organization updated successfully",
      data: updated,
    });
  } catch (error) {
    console.error("updateOrganization error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function getMembers(_req: Request, res: Response) {
  try {
    const members = await getOrganizationMembers(res.locals.orgId);
    return res.status(200).json({ success: true, data: members });
  } catch (error) {
    console.error("getMembers error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function addMember(req: Request, res: Response) {
  try {
    const orgId = res.locals.orgId;
    const { userId, role, status } = req.body;

    if (!userId || !role || !VALID_ROLES.includes(role)) {
      return res.status(400).json({
        success: false,
        message: `userId and a valid role (${VALID_ROLES.join(", ")}) are required`,
      });
    }

    const member = await addOrganizationMember(orgId, { userId, role, status });
    return res.status(201).json({
      success: true,
      message: "Member added successfully",
      data: member,
    });
  } catch (error: any) {
    console.error("addMember error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
}

export async function updateMemberRole(req: Request, res: Response) {
  try {
    const orgId = res.locals.orgId;
    const memberId = String(req.params.memberId);
    const { role } = req.body;

    if (!role || !VALID_ROLES.includes(role)) {
      return res.status(400).json({
        success: false,
        message: `Valid role (${VALID_ROLES.join(", ")}) is required`,
      });
    }

    const updated = await updateMemberRoleService(orgId, memberId, role);
    if (!updated) {
      return res.status(404).json({
        success: false,
        message: "Membership not found in this organization",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Member role updated successfully",
      data: updated,
    });
  } catch (error) {
    console.error("updateMemberRole error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function removeMember(req: Request, res: Response) {
  try {
    const orgId = res.locals.orgId;
    const memberId = String(req.params.memberId);

    const removed = await removeOrganizationMember(orgId, memberId);
    if (!removed) {
      return res.status(404).json({
        success: false,
        message: "Membership not found in this organization",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Member removed from organization",
      data: removed,
    });
  } catch (error) {
    console.error("removeMember error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function createRoleRequest(req: Request, res: Response) {
  try {
    const userId = res.locals.user.id;
    const orgId = String(req.params.orgId);
    const { requestedRole } = req.body;

    if (!requestedRole || !VALID_ROLES.includes(requestedRole)) {
      return res.status(400).json({
        success: false,
        message: `Valid requestedRole (${VALID_ROLES.join(", ")}) is required`,
      });
    }

    const request = await createRoleRequestService(orgId, userId, requestedRole);
    return res.status(201).json({
      success: true,
      message: "Role request submitted successfully",
      data: request,
    });
  } catch (error: any) {
    console.error("createRoleRequest error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
}

export async function listRoleRequests(req: Request, res: Response) {
  try {
    const orgId = res.locals.orgId;
    const status = req.query.status as any;

    const requests = await listOrganizationRoleRequests(orgId, status);
    return res.status(200).json({ success: true, data: requests });
  } catch (error) {
    console.error("listRoleRequests error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export async function reviewRoleRequest(req: Request, res: Response) {
  try {
    const orgId = res.locals.orgId;
    const requestId = String(req.params.requestId);
    const { action } = req.body;
    const reviewerId = res.locals.user.id;
    const isPlatformAdmin = Boolean(res.locals.user?.isPlatformAdmin);

    if (!action || !["approved", "rejected"].includes(action)) {
      return res.status(400).json({
        success: false,
        message: "Action must be 'approved' or 'rejected'",
      });
    }

    const result = await reviewRoleRequestService(
      orgId,
      requestId,
      reviewerId,
      action,
      isPlatformAdmin
    );
    if (!result) {
      return res.status(404).json({
        success: false,
        message: "Role request not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: `Role request ${action} successfully`,
      data: result,
    });
  } catch (error: any) {
    console.error("reviewRoleRequest error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
}

// Backwards compatibility aliases
export const handleListAllOrganizations = listOrganizations;
export const handleCreateOrganization = createOrganization;
export const handleGetOrganization = getOrganization;
export const handleUpdateOrganization = updateOrganization;
export const handleGetOrganizationMembers = getMembers;
export const handleAddMember = addMember;
export const handleUpdateMemberRole = updateMemberRole;
export const handleRemoveMember = removeMember;
export const handleCreateRoleRequest = createRoleRequest;
export const handleListRoleRequests = listRoleRequests;
export const handleReviewRoleRequest = reviewRoleRequest;
