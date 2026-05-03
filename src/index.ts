import "dotenv/config";
import path from "path";
import express from "express";
import { dashboardRouter } from "./routes/dashboard";
import { testRouter } from "./routes/test";
import { monitorRunner } from "./services/monitorRunner";
import { closeBrowser } from "./services/browser";

const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/test", testRouter);
app.use("/", dashboardRouter);

const port = Number(process.env.PORT) || 3000;
app.listen(port, async () => {
  console.log(`listening on :${port}`);
  await monitorRunner.start();
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, async () => {
    console.log(`[index] ${sig} received — shutting down`);
    await closeBrowser();
    process.exit(0);
  });
}
