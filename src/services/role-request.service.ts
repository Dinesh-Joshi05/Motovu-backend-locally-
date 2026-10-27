import { pool, withTenantContext } from "../config/db.js";
import type { OrganizationRole, RoleRequestStatus } from "../types/rbac.js";

// 1. Create a new role request (Used by Option A and Option B, runs with RLS context)
export async function createRoleRequest(
  orgId: string,
  userId: string,
  requestedRole: OrganizationRole
) {
  return withTenantContext({ userId, orgId }, async (client) => {
    const result = await client.query(
      `INSERT INTO app.role_requests (id, user_id, org_id, requested_role, status)
       VALUES (gen_random_uuid(), $1, $2, $3, 'pending')
       RETURNING id, user_id, org_id, requested_role, status, created_at`,
      [userId, orgId, requestedRole]
    );

    return result.rows[0];
  });
}

// 2. Option B: List staff role requests for a specific organization (For Org Admin)
// Staff roles: advisor, guard, worker, store_keeper (Excludes org_admin, runs with org RLS context)
export async function listOrganizationRoleRequests(
  orgId: string,
  status?: RoleRequestStatus
) {
  return withTenantContext({ orgId }, async (client) => {
    let query = `
      SELECT
        rr.id,
        rr.user_id,
        rr.org_id,
        rr.requested_role,
        rr.status,
        rr.reviewed_by,
        rr.reviewed_at,
        rr.created_at,
        u.name AS user_name,
        u.email AS user_email,
        rev.name AS reviewer_name
      FROM app.role_requests rr
      JOIN public."user" u ON u.id = rr.user_id
      LEFT JOIN public."user" rev ON rev.id = rr.reviewed_by
      WHERE rr.org_id = $1 AND rr.requested_role != 'org_admin'
    `;
    const params: any[] = [orgId];

    if (status) {
      query += ` AND rr.status = $2`;
      params.push(status);
    }

    query += ` ORDER BY rr.created_at DESC`;

    const result = await client.query(query, params);
    return result.rows;
  });
}

// 3. Option A: List new organization requests (For Platform Admin only)
// Only queries requested_role = 'org_admin' (runs with admin RLS context)
export async function listAllRoleRequests(
  status?: RoleRequestStatus,
  adminUserId?: string
) {
  return withTenantContext({ userId: adminUserId }, async (client) => {
    let query = `
      SELECT
        rr.id,
        rr.user_id,
        rr.org_id,
        o.name AS organization_name,
        rr.requested_role,
        rr.status,
        rr.reviewed_by,
        rr.reviewed_at,
        rr.created_at,
        u.name AS user_name,
        u.email AS user_email,
        rev.name AS reviewer_name
      FROM app.role_requests rr
      JOIN app.organizations o ON o.id = rr.org_id
      JOIN public."user" u ON u.id = rr.user_id
      LEFT JOIN public."user" rev ON rev.id = rr.reviewed_by
      WHERE rr.requested_role = 'org_admin'
    `;
    const params: any[] = [];

    if (status) {
      query += ` AND rr.status = $1`;
      params.push(status);
    }

    query += ` ORDER BY rr.created_at DESC`;

    const result = await client.query(query, params);
    return result.rows;
  });
}

// 4. Review a role request (Approve or Reject)
export async function reviewRoleRequest(
  orgId: string,
  requestId: string,
  reviewerId: string,
  action: "approved" | "rejected",
  isPlatformAdmin: boolean = false
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Step A: Find the request
    const reqResult = await client.query(
      `SELECT id, user_id, org_id, requested_role, status
       FROM app.role_requests
       WHERE id = $1 AND org_id = $2
       FOR UPDATE`,
      [requestId, orgId]
    );

    if (reqResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const roleReq = reqResult.rows[0];
    if (roleReq.status !== "pending") {
      throw new Error(`Role request has already been ${roleReq.status}`);
    }

    // Security check: Option A (org_admin) requires platform admin
    if (roleReq.requested_role === "org_admin" && !isPlatformAdmin) {
      throw new Error("Only platform administrators can approve organization admin requests");
    }

    // Step B: Update request status
    const updateReq = await client.query(
      `UPDATE app.role_requests
       SET status = $1, reviewed_by = $2, reviewed_at = NOW()
       WHERE id = $3 AND org_id = $4
       RETURNING id, user_id, org_id, requested_role, status, reviewed_by, reviewed_at`,
      [action, reviewerId, requestId, orgId]
    );

    // Step C: If approved, activate membership in app.memberships
    let membership = null;
    if (action === "approved") {
      const memResult = await client.query(
        `INSERT INTO app.memberships (id, org_id, user_id, role, status)
         VALUES (gen_random_uuid(), $1, $2, $3, 'active')
         ON CONFLICT (org_id, user_id)
         DO UPDATE SET role = EXCLUDED.role, status = 'active'
         RETURNING id, org_id, user_id, role, status, created_at`,
        [orgId, roleReq.user_id, roleReq.requested_role]
      );
      membership = memResult.rows[0];
    }

    await client.query("COMMIT");
    return {
      request: updateReq.rows[0],
      membership,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
