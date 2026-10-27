import "dotenv/config";
import { betterAuth } from "better-auth";
import { pool } from "../src/config/db.js";

const auth = betterAuth({
  database: pool,
  emailAndPassword: {
    enabled: true,
  },
  secret: process.env.BETTER_AUTH_SECRET || "xvmJsKNbiDLyjt7EKTiDCg1G7y1HCwRx",
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
});

async function main() {
  const adminEmail = "admin@motovu.com";
  const adminPassword = "AdminPassword123!";
  const adminName = "Platform Administrator";

  console.log(`Setting up pure Platform Admin: ${adminEmail}...`);

  // 1. Check if user already exists
  const existingUser = await pool.query(
    'SELECT id, email FROM public."user" WHERE email = $1',
    [adminEmail]
  );

  let userId: string;

  if (existingUser.rowCount && existingUser.rowCount > 0) {
    userId = existingUser.rows[0].id;

    // Reset old records
    await pool.query('DELETE FROM public.account WHERE "userId" = $1', [userId]);
    await pool.query('DELETE FROM public.session WHERE "userId" = $1', [userId]);
    await pool.query('DELETE FROM app.role_requests WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM app.memberships WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM app.platform_admins WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM public."user" WHERE id = $1', [userId]);
    console.log("Reset existing user records.");
  }

  // 2. Create the user in Better Auth
  const res = await (auth.api as any).signUpEmail({
    body: {
      name: adminName,
      email: adminEmail,
      password: adminPassword,
    },
  });

  userId = res.user.id;
  console.log(`Created Better Auth user with ID: ${userId}`);

  // 3. Add to app.platform_admins ONLY (No personal memberships)
  await pool.query(
    `INSERT INTO app.platform_admins (user_id)
     VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
  console.log("Added to app.platform_admins!");

  console.log("\n=======================================================");
  console.log(" PLATFORM ADMIN READY FOR OPTION A TESTING");
  console.log("=======================================================");
  console.log(` Email:    ${adminEmail}`);
  console.log(` Password: ${adminPassword}`);
  console.log(` Role:     platform_admin (Global Approval Privilege)`);
  console.log("=======================================================\n");

  await pool.end();
}

main().catch((err) => {
  console.error("Error creating platform admin:", err);
  process.exit(1);
});
