import type { Request, Response, NextFunction } from "express";
import type { OrganizationRole } from "../types/rbac.js";

// Checks if the logged-in user has an allowed role in the organization
export function requireRole(...allowedRoles: OrganizationRole[]) {
  return (_req: Request, res: Response, next: NextFunction) => {
    // Platform admins have access to all routes
    if (res.locals.user?.isPlatformAdmin) {
      return next();
    }

    const userRole = res.locals.orgRole as OrganizationRole;

    if (!userRole || !allowedRoles.includes(userRole)) {
      return res.status(403).json({
        success: false,
        message: `Forbidden: Requires one of [${allowedRoles.join(", ")}] role`,
      });
    }

    next();
  };
}

// Pre-defined role guards for common routes
export const requireOrgAdmin = requireRole("org_admin");
export const requireAdvisor = requireRole("advisor", "org_admin");
export const requireGuard = requireRole("guard", "org_admin");
export const requireWorker = requireRole("worker", "org_admin");
export const requireStoreKeeper = requireRole("store_keeper", "org_admin");
