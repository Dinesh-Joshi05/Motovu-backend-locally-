import { pool, withTenantContext } from "../config/db.js";
import type { OrganizationRole, RoleRequestStatus } from "../types/rbac.js";

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

    if (roleReq.requested_role === "org_admin" && !isPlatformAdmin) {
      throw new Error("Only platform administrators can approve organization admin requests");
    }

    const updateReq = await client.query(
      `UPDATE app.role_requests
       SET status = $1, reviewed_by = $2, reviewed_at = NOW()
       WHERE id = $3 AND org_id = $4
       RETURNING id, user_id, org_id, requested_role, status, reviewed_by, reviewed_at`,
      [action, reviewerId, requestId, orgId]
    );

    let membership = null;
    if (action === "approved") {
      // Automatically create company chat conversation for the organization if not already created (e.g. Option A)
      const convResult = await client.query(
        `INSERT INTO app.conversations (id, org_id, name)
         VALUES (gen_random_uuid(), $1, 'Company Chat')
         ON CONFLICT (org_id) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [orgId]
      );
      const conversationId = convResult.rows[0]?.id;

      // Activate user membership in the organization
      const memResult = await client.query(
        `INSERT INTO app.memberships (id, org_id, user_id, role, status)
         VALUES (gen_random_uuid(), $1, $2, $3, 'active')
         ON CONFLICT (org_id, user_id)
         DO UPDATE SET role = EXCLUDED.role, status = 'active'
         RETURNING id, org_id, user_id, role, status, created_at`,
        [orgId, roleReq.user_id, roleReq.requested_role]
      );
      membership = memResult.rows[0];

      // Automatically add user to organization chat room
      if (conversationId && membership?.id) {
        await client.query(
          `INSERT INTO app.conversation_members (org_id, conversation_id, membership_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (conversation_id, membership_id)
           DO UPDATE SET joined_at = NOW()`,
          [orgId, conversationId, membership.id]
        );
      }
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
