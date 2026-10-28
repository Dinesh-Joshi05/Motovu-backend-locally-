import fs from "fs";
import path from "path";
import { pool } from "../src/config/db.js";

async function runMigration() {
  const sqlPath = path.resolve("src/config/002_chat_multitenancy_rls.sql");
  const sql = fs.readFileSync(sqlPath, "utf-8");
  console.log("Applying 002_chat_multitenancy_rls.sql...");
  await pool.query(sql);
  console.log("Successfully applied 002_chat_multitenancy_rls.sql!");
  await pool.end();
}

runMigration().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});

