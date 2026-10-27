import type { Request, Response } from "express";
import { getOrganizationById } from "../services/organization.service.js";

export async function getOrganization(
    req: Request,
    res: Response
) {
    try {
        const orgId = req.params.orgId;

        if (typeof orgId !== "string") {
            return res.status(400).json({
                success: false,
                message: "Invalid organization ID",
            });
        }

        const organization = await getOrganizationById(orgId);

        if (!organization) {
            return res.status(404).json({
                success: false,
                message: "Organization not found",
            });
        }

        return res.status(200).json({
            success: true,
            data: organization,
        });
    } catch (error) {
        console.error("Get organization error:", error);

        return res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
}