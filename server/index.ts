import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { paths } from "../shared/paths.js";
import { buildApp } from "./app.js";
import { openDb } from "./db.js";
import { startLocalAgent } from "./localAgent.js";
import { createJob, ensureLocalDevice, localDevice, recomputeAll } from "./store.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lan = process.argv.includes("--lan");
const port = Number(process.env.PORT || 4321);
const host = lan ? "0.0.0.0" : "127.0.0.1";

const p = paths();
const db = openDb(p.db);

// Local agent token, so `npm run clockout` / `npm run resume` can talk to this server.
const { token } = ensureLocalDevice(db, os.hostname());
fs.mkdirSync(p.clockoutHome, { recursive: true });
fs.writeFileSync(p.localDevice, JSON.stringify({ token, server: `http://127.0.0.1:${port}` }), { mode: 0o600 });

recomputeAll(db); // metrics definitions may have changed since the last run
const agent = startLocalAgent(db);
const app = buildApp({ db, webDir: path.join(root, "dist", "web"), onJobCreated: () => void agent.tick(), lan });

// Fresh data on every start for the linked developer.
const local = localDevice(db);
if (local?.user_id) {
  createJob(db, local.user_id, "collect");
  void agent.tick();
}

try {
  await app.listen({ port, host });
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
    console.error(`\n  Port ${port} is in use: Clockout may already be running (for example through npm run autostart).`);
    console.error(`  Open http://localhost:${port}, or start on another port: PORT=4330 npm start\n`);
    agent.stop();
    db.close();
    process.exit(1);
  }
  throw err;
}
const url = `http://localhost:${port}`;
console.log(`\n  Clockout${process.env.CLOCKOUT_DEMO === "1" ? " (demo data)" : ""} is running at ${url}`);
console.log(lan
  ? `  LAN mode: anyone on your network can open it and sign in as anyone. Teammates: npm run agent -- --server http://<your-ip>:${port} --user <name>`
  : "  Listening on this machine only. Start with `npm start -- --lan` to let teammates' agents connect.");
console.log(`  Data: ${p.db}\n  Stop with Ctrl+C.\n`);

if (!process.env.CLOCKOUT_NO_OPEN) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(opener, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

const shutdown = async () => {
  agent.stop();
  await app.close();
  db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
