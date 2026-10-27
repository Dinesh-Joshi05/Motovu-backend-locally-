import type { Request, Response } from "express";
import { getUserMemberships, getUserRoleRequests } from "../services/membership.service.js";
import { listAllRoleRequests } from "../services/role-request.service.js";

// Returns active memberships, filed role requests, and platform pending requests
export async function getMyMemberships(
  _req: Request,
  res: Response
) {
  try {
    const userId = res.locals.user.id as string;
    const isPlatformAdmin = Boolean(res.locals.user?.isPlatformAdmin);

    const memberships = await getUserMemberships(userId);
    const roleRequests = await getUserRoleRequests(userId);

    let platformPendingRequests: any[] = [];
    if (isPlatformAdmin) {
      platformPendingRequests = await listAllRoleRequests("pending", userId);
    }

    return res.status(200).json({
      success: true,
      isPlatformAdmin,
      data: memberships,
      roleRequests,
      platformPendingRequests,
    });
  } catch (error) {
    console.error("Get memberships error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}