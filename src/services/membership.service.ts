import { withTenantContext } from "../config/db.js";

// Returns all active organization memberships for a user (runs with user RLS context)
export async function getUserMemberships(userId: string) {
  return withTenantContext({ userId }, async (client) => {
    const result = await client.query(
      `SELECT
        m.id AS membership_id,
        m.org_id,
        o.name AS organization_name,
        o.status AS organization_status,
        m.role,
        m.status AS membership_status,
        m.created_at
       FROM app.memberships m
       JOIN app.organizations o ON o.id = m.org_id
       WHERE m.user_id = $1
       ORDER BY m.created_at DESC`,
      [userId]
    );

    return result.rows;
  });
}

// Returns all role requests filed by a user (runs with user RLS context)
export async function getUserRoleRequests(userId: string) {
  return withTenantContext({ userId }, async (client) => {
    const result = await client.query(
      `SELECT
        rr.id,
        rr.org_id,
        o.name AS organization_name,
        rr.requested_role,
        rr.status,
        rr.created_at
       FROM app.role_requests rr
       JOIN app.organizations o ON o.id = rr.org_id
       WHERE rr.user_id = $1
       ORDER BY rr.created_at DESC`,
      [userId]
    );

    return result.rows;
  });
}
