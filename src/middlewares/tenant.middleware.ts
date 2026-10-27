import type { Request, Response, NextFunction } from "express";
import { pool, withTenantContext } from "../config/db.js";

// Ensures the user belongs to the organization and organization is active
export async function requireMembership(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const userId = res.locals.user?.id;
  const orgId = String(req.params.orgId);

  if (!orgId) {
    return res.status(400).json({
      success: false,
      message: "Organization ID is required",
    });
  }

  try {
    // 1. Check if organization exists and is active
    const orgResult = await pool.query(
      "SELECT id, name, status FROM app.organizations WHERE id = $1",
      [orgId]
    );

    if (orgResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Organization not found",
      });
    }

    const org = orgResult.rows[0];

    if (org.status === "suspended") {
      return res.status(403).json({
        success: false,
        message: "Forbidden: Organization is suspended",
      });
    }

    // Platform admins have full access across all organizations
    if (res.locals.user?.isPlatformAdmin) {
      res.locals.orgId = orgId;
      res.locals.orgRole = "org_admin";
      res.locals.organization = org;
      return next();
    }

    // 2. Check if user is an active member using RLS tenant context
    const memberResult = await withTenantContext(
      { userId, orgId },
      async (client) =>
        client.query<{ role: any; status: string }>(
          "SELECT role, status FROM app.memberships WHERE org_id = $1 AND user_id = $2",
          [orgId, userId]
        )
    );

    if (memberResult.rowCount === 0) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: You are not a member of this organization",
      });
    }

    const membership = memberResult.rows[0];

    if (membership.status !== "active") {
      return res.status(403).json({
        success: false,
        message: `Forbidden: Membership is ${membership.status} (must be active)`,
      });
    }

    // 3. Save organization and role for subsequent middleware & route handlers
    res.locals.orgId = orgId;
    res.locals.orgRole = membership.role;
    res.locals.organization = org;

    next();
  } catch (error: any) {
    // Handle invalid UUID string format passed to Postgres
    if (error.code === "22P02") {
      return res.status(400).json({
        success: false,
        message: "Invalid organization ID format (must be a valid UUID)",
      });
    }

    console.error("Membership check error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error verifying organization membership",
    });
  }
}
