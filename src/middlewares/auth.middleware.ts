import type { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { pool } from "../config/db.js";

const BETTER_AUTH_URL = process.env.BETTER_AUTH_URL || "http://localhost:3000";

const JWKS = createRemoteJWKSet(
  new URL("/api/auth/jwks", BETTER_AUTH_URL)
);

// Authenticates the request using Better Auth JWT
export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      message: "Missing Bearer token",
    });
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Missing Bearer token",
    });
  }

  try {
    // Verify JWT against Better Auth JWKS keys
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: BETTER_AUTH_URL,
      audience: BETTER_AUTH_URL,
    });

    const userId = payload.sub;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Invalid token: missing subject",
      });
    }

    // Check if user is a platform admin
    const adminCheck = await pool.query(
      "SELECT 1 FROM app.platform_admins WHERE user_id = $1",
      [userId]
    );

    res.locals.user = {
      id: userId,
      email: payload.email as string,
      name: payload.name as string,
      isPlatformAdmin: adminCheck.rowCount ? adminCheck.rowCount > 0 : false,
    };

    next();
  } catch {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
    });
  }
}
