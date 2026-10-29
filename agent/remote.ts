// Remote agent: runs on a teammate's machine and sends their data to a shared Clockout server.
// Usage: npm run agent -- --server http://<host>:4321 --user <name>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JobResult, Settings } from "../shared/types.js";
import { paths } from "../shared/paths.js";
import { runJob } from "./runner.js";

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface AgentConfig {
  server: string;
  user: string;
  token: string;
}

async function api<T>(cfg: { server: string; token?: string }, method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`${cfg.server}${url}`, {
    method,
    headers: { "content-type": "application/json", ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

async function main() {
  const p = paths();
  const server = arg("server")?.replace(/\/+$/, "");
  const user = arg("user");
  let cfg: AgentConfig | undefined;
  if (fs.existsSync(p.agentConfig)) cfg = JSON.parse(fs.readFileSync(p.agentConfig, "utf8"));
  if (server && user && (!cfg || cfg.server !== server || cfg.user !== user)) {
    const reg = await api<{ token: string }>({ server }, "POST", "/api/agent/register", { user, deviceName: os.hostname() });
    cfg = { server, user, token: reg.token };
    fs.mkdirSync(path.dirname(p.agentConfig), { recursive: true });
    fs.writeFileSync(p.agentConfig, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    console.log(`Registered as ${user} with ${server}.`);
  }
  if (!cfg) {
    console.error("Usage: npm run agent -- --server http://<host>:4321 --user <your name>");
    process.exit(1);
  }

  console.log(`Clockout agent for ${cfg.user} -> ${cfg.server}. Press Ctrl+C to stop.`);
  await api(cfg, "POST", "/api/agent/jobs", { type: "collect" });

  for (;;) {
    try {
      const { job, settings } = await api<{ job: { id: number; type: "collect" | "clockout" | "resume" } | null; settings: Settings }>(cfg, "GET", "/api/agent/jobs/next");
      if (job) {
        console.log(`Running ${job.type}...`);
        let result: JobResult | null = null;
        let error: string | undefined;
        try {
          result = await runJob(job.type, settings);
        } catch (err) {
          error = (err as Error).message;
        }
        await api(cfg, "POST", `/api/agent/jobs/${job.id}/result`, { result, error });
        console.log(error ? `  failed: ${error}` : "  done.");
        continue;
      }
    } catch (err) {
      console.error(`Cannot reach ${cfg.server}: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

await main();
