import express from "express";
import cors from "cors";
import testRoutes from "./routes/test.routes.js";

const app = express();

app.use(cors({
    origin: "http://localhost:3000",
    credentials: true,
}));

app.use(express.json());


import organizationRoutes from "./routes/organization.routes.js";

app.use("/api/organizations", organizationRoutes);
app.use("/api/test", testRoutes);


app.get("/health", (_req, res) => {
    res.status(200).json({
        success: true,
        message: "Motovu backend is running",
    });
});

export default app;