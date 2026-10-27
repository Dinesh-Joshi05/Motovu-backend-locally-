
import "dotenv/config";
import { Pool } from "pg";

if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is missing from .env");
}

export const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

pool.on("error", (err) => {
    console.error("Unexpected PostgreSQL error:", err);
});
