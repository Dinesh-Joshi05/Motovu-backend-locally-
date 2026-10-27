import express from "express";
import cors from "cors";
const app = express();

app.use(cors({
    origin: "http://localhost:3000",
    credentials: true,
}));

app.use(express.json());


import organizationRoutes from "./routes/organization.routes.js";

app.use("/api/organizations", organizationRoutes);

app.get("/health", (_req, res) => {
    res.status(200).json({
        success: true,
        message: "Motovu backend is running",
    });
});

export default app;