import { pool, withTenantContext } from "../config/db.js";
import type { OrganizationRole, MembershipStatus, OrganizationStatus } from "../types/rbac.js";

// Get single organization by ID
export async function getOrganizationById(orgId: string) {
  const result = await pool.query(
    "SELECT id, name, status, created_at FROM app.organizations WHERE id = $1",
    [orgId]
  );
  return result.rows[0] ?? null;
}

// Get all active organizations (for dropdown list in onboarding Option B)
export async function getAllOrganizations() {
  const result = await pool.query(
    "SELECT id, name, status, created_at FROM app.organizations WHERE status = 'active' ORDER BY name ASC"
  );
  return result.rows;
}

// Get all organizations along with their members (for Platform Admin workspace)
export async function getAllOrganizationsWithMembers() {
  const orgsResult = await pool.query(
    "SELECT id, name, status, created_at FROM app.organizations ORDER BY created_at DESC"
  );

  const membersResult = await pool.query(
    `SELECT
       m.id,
       m.org_id,
       m.user_id,
       m.role,
       m.status,
       m.created_at,
       u.name,
       u.email
     FROM app.memberships m
     JOIN public."user" u ON u.id = m.user_id
     ORDER BY m.created_at ASC`
  );

  const membersByOrgId: Record<string, any[]> = {};
  for (const m of membersResult.rows) {
    if (!membersByOrgId[m.org_id]) {
      membersByOrgId[m.org_id] = [];
    }
    membersByOrgId[m.org_id].push(m);
  }

  return orgsResult.rows.map((org) => ({
    ...org,
    members: membersByOrgId[org.id] || [],
    members_count: (membersByOrgId[org.id] || []).length,
  }));
}

// Create new organization and submit a pending org_admin role request
export async function createOrganization(name: string, ownerUserId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Create organization
    const orgResult = await client.query(
      `INSERT INTO app.organizations (id, name, status)
       VALUES (gen_random_uuid(), $1, 'active')
       RETURNING id, name, status, created_at`,
      [name]
    );
    const org = orgResult.rows[0];

    // 2. Submit a pending role request for the user to become org_admin (requires platform admin approval)
    const reqResult = await client.query(
      `INSERT INTO app.role_requests (id, user_id, org_id, requested_role, status)
       VALUES (gen_random_uuid(), $1, $2, 'org_admin', 'pending')
       RETURNING id, user_id, org_id, requested_role, status, created_at`,
      [ownerUserId, org.id]
    );

    await client.query("COMMIT");
    return { organization: org, request: reqResult.rows[0] };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Update organization name or status
export async function updateOrganization(
  orgId: string,
  updates: { name?: string; status?: OrganizationStatus }
) {
  const result = await pool.query(
    `UPDATE app.organizations
     SET name = COALESCE($1, name),
         status = COALESCE($2, status)
     WHERE id = $3
     RETURNING id, name, status, created_at`,
    [updates.name || null, updates.status || null, orgId]
  );
  return result.rows[0] ?? null;
}

// Get all members of an organization (runs with org RLS context)
export async function getOrganizationMembers(orgId: string) {
  return withTenantContext({ orgId }, async (client) => {
    const result = await client.query(
      `SELECT
        m.id,
        m.org_id,
        m.user_id,
        m.role,
        m.status,
        m.created_at,
        u.name,
        u.email
       FROM app.memberships m
       JOIN public."user" u ON u.id = m.user_id
       WHERE m.org_id = $1
       ORDER BY m.created_at ASC`,
      [orgId]
    );
    return result.rows;
  });
}

// Add a member to an organization
export async function addOrganizationMember(
  orgId: string,
  data: { userId: string; role: OrganizationRole; status?: MembershipStatus }
) {
  const result = await pool.query(
    `INSERT INTO app.memberships (id, org_id, user_id, role, status)
     VALUES (gen_random_uuid(), $1, $2, $3, $4)
     ON CONFLICT (org_id, user_id) 
     DO UPDATE SET role = EXCLUDED.role, status = EXCLUDED.status
     RETURNING id, org_id, user_id, role, status, created_at`,
    [orgId, data.userId, data.role, data.status || "active"]
  );
  return result.rows[0];
}

// Update a member's role
export async function updateMemberRole(
  orgId: string,
  memberId: string,
  role: OrganizationRole
) {
  const result = await pool.query(
    `UPDATE app.memberships
     SET role = $1
     WHERE id = $2 AND org_id = $3
     RETURNING id, org_id, user_id, role, status, created_at`,
    [role, memberId, orgId]
  );
  return result.rows[0] ?? null;
}

// Soft-remove a member by setting status to 'removed'
export async function removeOrganizationMember(orgId: string, memberId: string) {
  const result = await pool.query(
    `UPDATE app.memberships
     SET status = 'removed'
     WHERE id = $1 AND org_id = $2
     RETURNING id, org_id, user_id, role, status`,
    [memberId, orgId]
  );
  return result.rows[0] ?? null;
}
