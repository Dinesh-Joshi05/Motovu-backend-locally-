import express from "express";
import cors from "cors";
import testRoutes from "./routes/test.routes.js";
import organizationRoutes from "./routes/organization.routes.js";
import membershipRoutes from "./routes/membership.routes.js";

const app = express();

const allowedOrigins = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  process.env.BETTER_AUTH_URL,
  process.env.CLIENT_URL,
].filter(Boolean) as string[];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, postman, tests)
      if (!origin) return callback(null, true);
      if (
        allowedOrigins.includes(origin) ||
        origin.startsWith("http://localhost:") ||
        origin.startsWith("http://127.0.0.1:")
      ) {
        return callback(null, true);
      }
      return callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept"],
    optionsSuccessStatus: 200,
  })
);

app.use(express.json());

// Routes
app.use("/api/test", testRoutes);
app.use("/api/memberships", membershipRoutes);
app.use("/api/organizations", organizationRoutes);

app.get("/health", (_req, res) => {
  res.status(200).json({
    success: true,
    message: "Motovu backend is running",
  });
});

// Global 404 handler for API routes
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    message: "API endpoint not found",
  });
});

export default app;