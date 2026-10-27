
import type { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";

const JWKS = createRemoteJWKSet(
    new URL("/api/auth/jwks", process.env.BETTER_AUTH_URL!)
);

export async function authenticate(
    req: Request,
    res: Response,
    next: NextFunction
) {
    const authorization = req.headers.authorization;

    if (!authorization?.startsWith("Bearer ")) {
        return res.status(401).json({
            message: "Missing Bearer token",
        });
    }

    try {
        const token = authorization.slice(7);

        const { payload } = await jwtVerify(token, JWKS, {
            issuer: process.env.BETTER_AUTH_URL,
            audience: process.env.BETTER_AUTH_URL,
        });

        res.locals.user = {
            id: payload.sub,
        };

        next();
    } catch {
        return res.status(401).json({
            message: "Invalid or expired token",
        });
    }
}
