
import { pool } from "../config/db.js";

export async function getUserMemberships(userId: string) {
    const result = await pool.query(
        `SELECT
        m.org_id,
        o.name AS organization_name,
        m.role,
        m.status
        FROM app.memberships m
        JOIN app.organizations o ON o.id = m.org_id
        WHERE m.user_id = $1
        AND m.status = 'active'`,
        [userId]
    );

    return result.rows;
}
