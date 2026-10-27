import type { Request, Response } from "express";
import { getUserMemberships } from "../services/membership.service.js";

export async function getMyMemberships(
    req: Request,
    res: Response
) {
    try {
        // We'll populate this from verified Better Auth identity
        const userId = req.user.id;

        const memberships = await getUserMemberships(userId);

        return res.status(200).json({
            success: true,
            data: memberships,
        });
    } catch (error) {
        console.error("Get memberships error:", error);

        return res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
}