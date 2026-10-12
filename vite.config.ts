import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig(({ mode }) => {
  // Read the API port on the server only; never expose copied provider secrets to the client.
  const env = loadEnv(mode, process.cwd(), "");
  const port = Number(process.env.PORT || env.PORT || 3002);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be a valid API port.");
  return {
    plugins: [
      react(),
      {
        name: "private-public-report-capabilities",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url?.startsWith("/reports/shared/")) {
              res.setHeader("Referrer-Policy", "no-referrer");
              res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
              res.setHeader("Cache-Control", "no-store");
            }
            next();
          });
        },
      },
    ],
    server: {
      port: 5174,
      strictPort: true,
      proxy: { "/api": `http://127.0.0.1:${port}` },
    },
    build: { outDir: "dist", sourcemap: false },
  };
});
