import { pool } from "../config/db.js";

export async function getOrganizationById(orgId: string) {
    const result = await pool.query(
        `SELECT id, name, status, created_at
        FROM app.organizations
        WHERE id = $1`,
        [orgId]
    );

    return result.rows[0] ?? null;
}