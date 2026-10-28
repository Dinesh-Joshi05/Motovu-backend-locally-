import http from "http";

const req = http.request({ host: "localhost", port: 9000, path: "/minio/health/live", method: "GET" }, (res) => {
  console.log("MinIO health status:", res.statusCode);
});
req.on("error", (e) => {
  console.log("MinIO connection error:", e.message);
});
req.end();

