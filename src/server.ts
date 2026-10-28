import "dotenv/config";
import http from "http";
import app from "./app.js";
import { initSocketServer } from "./socket.js";

const PORT = process.env.PORT || 5000;

const httpServer = http.createServer(app);
initSocketServer(httpServer);

httpServer.listen(PORT, () => {
  console.log(`Motovu backend running on port ${PORT} with Socket.IO enabled`);
});
