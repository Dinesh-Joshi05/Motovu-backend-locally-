
import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware.js";

const router = Router();

router.get("/me", authenticate, (req, res) => {
    res.json({
        success: true,
        message: "JWT verified successfully!",
        user: res.locals.user,
    });
});

export default router;
