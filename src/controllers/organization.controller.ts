import type { Request, Response } from "express";
import {
  createOrganization,
  getAllOrganizations,
  getOrganizationById,
  updateOrganization,
  getOrganizationMembers,
  addOrganizationMember,
  updateMemberRole,
  removeOrganizationMember,
} from "../services/organization.service.js";
import {
  createRoleRequest,
  listOrganizationRoleRequests,
  reviewRoleRequest,
} from "../services/role-request.service.js";
import type { OrganizationRole } from "../types/rbac.js";

// List all active organizations (for onboarding dropdown)
export async function handleListAllOrganizations(_req: Request, res: Response) {
  try {
    const orgs = await getAllOrganizations();
    return res.status(200).json({
      success: true,
      data: orgs,
    });
  } catch (error) {
    console.error("List organizations error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}

export async function handleCreateOrganization(req: Request, res: Response) {
  try {
    const userId = res.locals.user?.id;
    const { name } = req.body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: "Organization name is required",
      });
    }

    const result = await createOrganization(name.trim(), userId);

    return res.status(201).json({
      success: true,
      message: "Organization created successfully",
      data: result,
    });
  } catch (error: any) {
    console.error("Create organization error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
}

export async function handleGetOrganization(_req: Request, res: Response) {
  try {
    // res.locals.orgId and res.locals.organization were populated by requireMembership
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
    console.error("Get organization error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}

export async function handleUpdateOrganization(req: Request, res: Response) {
  try {
    const orgId = res.locals.orgId;
    const { name, status } = req.body;

    if (status && !["active", "suspended"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid organization status. Allowed: 'active', 'suspended'",
      });
    }

    const updated = await updateOrganization(orgId, { name, status });

    return res.status(200).json({
      success: true,
      message: "Organization updated successfully",
      data: updated,
    });
  } catch (error) {
    console.error("Update organization error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}

export async function handleGetOrganizationMembers(_req: Request, res: Response) {
  try {
    const orgId = res.locals.orgId;
    const members = await getOrganizationMembers(orgId);

    return res.status(200).json({
      success: true,
      data: members,
    });
  } catch (error) {
    console.error("Get members error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}

export async function handleAddMember(req: Request, res: Response) {
  try {
    const orgId = res.locals.orgId;
    const { userId, role, status } = req.body;

    const validRoles: OrganizationRole[] = [
      "org_admin",
      "advisor",
      "guard",
      "worker",
      "store_keeper",
    ];

    if (!userId || !role || !validRoles.includes(role)) {
      return res.status(400).json({
        success: false,
        message: `userId and a valid role (${validRoles.join(", ")}) are required`,
      });
    }

    const member = await addOrganizationMember(orgId, { userId, role, status });

    return res.status(201).json({
      success: true,
      message: "Member added successfully",
      data: member,
    });
  } catch (error: any) {
    console.error("Add member error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
}

export async function handleUpdateMemberRole(req: Request, res: Response) {
  try {
    const orgId = res.locals.orgId;
    const memberId = String(req.params.memberId);
    const { role } = req.body;

    const validRoles: OrganizationRole[] = [
      "org_admin",
      "advisor",
      "guard",
      "worker",
      "store_keeper",
    ];

    if (!role || !validRoles.includes(role)) {
      return res.status(400).json({
        success: false,
        message: `Valid role (${validRoles.join(", ")}) is required`,
      });
    }

    const updated = await updateMemberRole(orgId, memberId, role);
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
    console.error("Update role error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}

export async function handleRemoveMember(req: Request, res: Response) {
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
    console.error("Remove member error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}

// Role Requests
export async function handleCreateRoleRequest(req: Request, res: Response) {
  try {
    const userId = res.locals.user.id;
    const orgId = String(req.params.orgId);
    const { requestedRole } = req.body;

    const validRoles: OrganizationRole[] = [
      "org_admin",
      "advisor",
      "guard",
      "worker",
      "store_keeper",
    ];

    if (!requestedRole || !validRoles.includes(requestedRole)) {
      return res.status(400).json({
        success: false,
        message: `Valid requestedRole (${validRoles.join(", ")}) is required`,
      });
    }

    const request = await createRoleRequest(orgId, userId, requestedRole);

    return res.status(201).json({
      success: true,
      message: "Role request submitted successfully",
      data: request,
    });
  } catch (error: any) {
    console.error("Create role request error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
}

export async function handleListRoleRequests(req: Request, res: Response) {
  try {
    const orgId = res.locals.orgId;
    const status = req.query.status as any;

    const requests = await listOrganizationRoleRequests(orgId, status);

    return res.status(200).json({
      success: true,
      data: requests,
    });
  } catch (error) {
    console.error("List role requests error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}

export async function handleReviewRoleRequest(req: Request, res: Response) {
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

    const result = await reviewRoleRequest(
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
    console.error("Review role request error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
}

// -------------------------------------------------------------
// Role-Specific Action Handlers (RBAC Demonstrations)
// -------------------------------------------------------------

// Guard: vehicle entry / gate pass
export async function handleGuardVehicleEntry(req: Request, res: Response) {
  const { vehicleNumber, driverName } = req.body;
  if (!vehicleNumber) {
    return res.status(400).json({
      success: false,
      message: "vehicleNumber is required for gate check-in",
    });
  }

  return res.status(200).json({
    success: true,
    message: `[Guard Action] Vehicle ${vehicleNumber} logged at gate for org ${res.locals.orgId}`,
    data: {
      action: "vehicle_check_in",
      orgId: res.locals.orgId,
      performedBy: res.locals.user.id,
      role: res.locals.orgRole,
      vehicleNumber,
      driverName: driverName || "Walk-in",
      timestamp: new Date().toISOString(),
    },
  });
}

// Advisor: job card creation / diagnostic review
export async function handleAdvisorJobCard(req: Request, res: Response) {
  const { vehicleNumber, serviceDetails } = req.body;
  if (!vehicleNumber || !serviceDetails) {
    return res.status(400).json({
      success: false,
      message: "vehicleNumber and serviceDetails are required to open a job card",
    });
  }

  return res.status(201).json({
    success: true,
    message: `[Advisor Action] Job card opened for ${vehicleNumber} in org ${res.locals.orgId}`,
    data: {
      action: "create_job_card",
      orgId: res.locals.orgId,
      advisorId: res.locals.user.id,
      role: res.locals.orgRole,
      vehicleNumber,
      serviceDetails,
      jobCardNumber: `JC-${Date.now().toString().slice(-6)}`,
      status: "assigned_to_workshop",
    },
  });
}

// Worker: service task execution & status updates
export async function handleWorkerTaskUpdate(req: Request, res: Response) {
  const { taskId, status, notes } = req.body;
  if (!taskId || !status) {
    return res.status(400).json({
      success: false,
      message: "taskId and status are required for worker task update",
    });
  }

  return res.status(200).json({
    success: true,
    message: `[Worker Action] Task ${taskId} updated to '${status}' in org ${res.locals.orgId}`,
    data: {
      action: "update_task",
      orgId: res.locals.orgId,
      workerId: res.locals.user.id,
      role: res.locals.orgRole,
      taskId,
      status,
      notes: notes || "No worker notes provided",
      updatedAt: new Date().toISOString(),
    },
  });
}

// Store Keeper: spare parts issuance & inventory dispatch
export async function handleStoreKeeperDispatch(req: Request, res: Response) {
  const { partNumber, quantity, jobCardId } = req.body;
  if (!partNumber || !quantity) {
    return res.status(400).json({
      success: false,
      message: "partNumber and quantity are required for parts dispatch",
    });
  }

  return res.status(200).json({
    success: true,
    message: `[Store Keeper Action] Dispatched ${quantity} unit(s) of part #${partNumber} in org ${res.locals.orgId}`,
    data: {
      action: "dispatch_inventory_part",
      orgId: res.locals.orgId,
      storeKeeperId: res.locals.user.id,
      role: res.locals.orgRole,
      partNumber,
      quantity,
      jobCardId: jobCardId || null,
      dispatchedAt: new Date().toISOString(),
    },
  });
}

// Org Admin: Organization audit log / sensitive administrative overview
export async function handleAdminAuditLog(_req: Request, res: Response) {
  return res.status(200).json({
    success: true,
    message: `[Org Admin Action] Accessing administrative audit trail for org ${res.locals.orgId}`,
    data: {
      action: "view_audit_trail",
      orgId: res.locals.orgId,
      adminId: res.locals.user.id,
      role: res.locals.orgRole,
      organizationName: res.locals.organization.name,
      status: res.locals.organization.status,
    },
  });
}