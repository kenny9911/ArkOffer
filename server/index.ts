import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createApp } from "./app.js";

export { createApp } from "./app.js";
export { createDatabase, Store } from "./db.js";

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const app = createApp();
  const clientDist = resolve("dist");
  if (existsSync(resolve(clientDist, "index.html"))) {
    app.use(express.static(clientDist, { index: false }));
    app.get("/{*path}", (_req, res) =>
      res.sendFile(resolve(clientDist, "index.html")),
    );
  }
  const port = Number(process.env.PORT || 3002);
  const host = process.env.HOST || "127.0.0.1";
  const server = app.listen(port, host, () =>
    console.info(`ArkOffer is listening on http://${host}:${port}`),
  );
  app.locals.outreach.start();
  app.locals.slack.start();
  app.locals.reportViews.start();
  const shutdown = () =>
    server.close(async () => {
      await app.locals.reportViews.stop();
      await app.locals.slack.stop();
      await app.locals.outreach.stop();
      await app.locals.account.stop();
      app.locals.store.close();
      process.exit(0);
    });
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
