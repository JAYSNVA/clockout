import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import type { JobResult, JobType } from "../shared/types.js";
import { pauseStatus } from "../agent/pause.js";
import { pickupStatus } from "../agent/pickup.js";
import type { DB } from "./db.js";
import { developerDetail, developerOverview, managerOverview } from "./queries.js";
import {
  HttpError,
  claimNextJob,
  completeJob,
  createDeveloper,
  createJob,
  deleteDeveloper,
  deviceForToken,
  emailsFor,
  getSettings,
  jobById,
  linkLocalDevice,
  listUsers,
  localDevice,
  registerRemoteDevice,
  renameUser,
  setEmails,
  signIn,
  signOut,
  unmatchedAuthors,
  updateSettings,
  userById,
  userForSession,
  type User,
} from "./store.js";

const COOKIE = "clockout_session";
const JOB_TYPES: JobType[] = ["collect", "clockout", "resume"];

export interface AppOptions {
  db: DB;
  webDir?: string;
  onJobCreated?: () => void;
}

function isLoopback(req: FastifyRequest) {
  const ip = req.ip;
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

export function buildApp({ db, webDir, onJobCreated }: AppOptions) {
  const app = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024 });
  app.register(cookie);

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) console.error(err);
    return reply.status(status).send({ error: status === 500 ? "Something went wrong on the server." : err.message });
  });

  const currentUser = (req: FastifyRequest): User => {
    const user = userForSession(db, req.cookies[COOKIE]);
    if (!user) throw new HttpError(401, "Please sign in.");
    return user;
  };
  const requireManager = (req: FastifyRequest) => {
    const user = currentUser(req);
    if (user.role !== "manager") throw new HttpError(403, "Only the manager can see this.");
    return user;
  };
  const requireDeveloper = (req: FastifyRequest) => {
    const user = currentUser(req);
    if (user.role !== "developer") throw new HttpError(403, "Only developers can do this.");
    return user;
  };
  const deviceAuth = (req: FastifyRequest) => {
    const header = req.headers.authorization ?? "";
    const device = deviceForToken(db, header.startsWith("Bearer ") ? header.slice(7) : undefined);
    if (!device) throw new HttpError(401, "Unknown agent token. Register the agent again.");
    return device;
  };
  const rangeDays = (raw: unknown) => ([7, 14, 30].includes(Number(raw)) ? Number(raw) : 14);

  // ----- login -----
  app.get("/api/users", async () => ({
    users: listUsers(db).map((u) => ({ name: u.name, role: u.role })),
    hasManager: listUsers(db).some((u) => u.role === "manager"),
    demo: process.env.CLOCKOUT_DEMO === "1",
  }));

  app.post<{ Body: { name?: string; role?: User["role"] } }>("/api/login", async (req, reply) => {
    const { user, token } = signIn(db, req.body?.name ?? "", req.body?.role as User["role"]);
    // The first developer to sign in on the machine running Clockout gets the local agent.
    const local = localDevice(db);
    if (user.role === "developer" && local && !local.user_id && isLoopback(req)) {
      linkLocalDevice(db, user.id);
      createJob(db, user.id, "collect");
      onJobCreated?.();
    }
    reply.setCookie(COOKIE, token, { path: "/", httpOnly: true, sameSite: "lax" });
    return { user };
  });

  app.post("/api/logout", async (req, reply) => {
    signOut(db, req.cookies[COOKIE]);
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/me", async (req) => {
    const user = currentUser(req);
    const local = localDevice(db);
    return {
      user,
      emails: user.role === "developer" ? emailsFor(db, user.id) : [],
      localAgent: local ? { linkedTo: local.user_id ? userById(db, local.user_id)?.name ?? null : null, isMine: local.user_id === user.id } : null,
      canLinkLocal: isLoopback(req),
      settings: getSettings(db),
      demo: process.env.CLOCKOUT_DEMO === "1",
    };
  });

  app.put<{ Body: { emails?: string[] } }>("/api/me/emails", async (req) => {
    const user = requireDeveloper(req);
    setEmails(db, user.id, Array.isArray(req.body?.emails) ? req.body.emails : []);
    return { emails: emailsFor(db, user.id) };
  });

  app.post("/api/me/link-local-agent", async (req) => {
    const user = requireDeveloper(req);
    if (!isLoopback(req)) throw new HttpError(403, "Link the local agent from the machine running Clockout.");
    linkLocalDevice(db, user.id);
    createJob(db, user.id, "collect");
    onJobCreated?.();
    return { ok: true };
  });

  // ----- developer -----
  app.get("/api/me/overview", async (req) => {
    const user = requireDeveloper(req);
    const overview = developerOverview(db, user.id);
    const local = localDevice(db);
    // The pause and pickup files are the source of truth on this machine.
    if (local?.user_id === user.id) {
      overview.paused = pauseStatus().paused;
      overview.pickup = pickupStatus();
    }
    return overview;
  });

  app.get<{ Querystring: { days?: string } }>("/api/me/manager-view", async (req) => {
    const user = requireDeveloper(req);
    return { overview: managerOverview(db, rangeDays(req.query.days), user.id), detail: developerDetail(db, user.id) };
  });

  app.post<{ Body: { type?: JobType } }>("/api/jobs", async (req) => {
    const user = requireDeveloper(req);
    const type = req.body?.type;
    if (!type || !JOB_TYPES.includes(type)) throw new HttpError(400, "Unknown job type.");
    const job = createJob(db, user.id, type);
    onJobCreated?.();
    return { job };
  });

  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (req) => {
    const user = currentUser(req);
    const job = jobById(db, Number(req.params.id));
    if (!job || job.user_id !== user.id) throw new HttpError(404, "Job not found.");
    return { job };
  });

  // ----- manager -----
  app.get<{ Querystring: { days?: string; userId?: string } }>("/api/manager/overview", async (req) => {
    requireManager(req);
    return managerOverview(db, rangeDays(req.query.days), req.query.userId ? Number(req.query.userId) : undefined);
  });

  app.get<{ Params: { id: string } }>("/api/manager/developers/:id", async (req) => {
    requireManager(req);
    const dev = userById(db, Number(req.params.id));
    if (!dev || dev.role !== "developer") throw new HttpError(404, "Developer not found.");
    return { developer: { ...dev, emails: emailsFor(db, dev.id) }, ...developerDetail(db, dev.id) };
  });

  app.get("/api/manager/people", async (req) => {
    requireManager(req);
    return {
      developers: listUsers(db)
        .filter((u) => u.role === "developer")
        .map((u) => ({ ...u, emails: emailsFor(db, u.id) })),
      unmatched: unmatchedAuthors(db),
    };
  });

  app.post<{ Body: { name?: string; emails?: string[] } }>("/api/manager/developers", async (req) => {
    requireManager(req);
    return { developer: createDeveloper(db, req.body?.name ?? "", req.body?.emails ?? []) };
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; emails?: string[] } }>("/api/manager/developers/:id", async (req) => {
    requireManager(req);
    const id = Number(req.params.id);
    const dev = userById(db, id);
    if (!dev || dev.role !== "developer") throw new HttpError(404, "Developer not found.");
    if (req.body?.name !== undefined) renameUser(db, id, req.body.name);
    if (req.body?.emails !== undefined) setEmails(db, id, req.body.emails);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/manager/developers/:id", async (req) => {
    requireManager(req);
    deleteDeveloper(db, Number(req.params.id));
    return { ok: true };
  });

  app.put<{ Body: Record<string, unknown> }>("/api/manager/settings", async (req) => {
    requireManager(req);
    updateSettings(db, req.body ?? {});
    return { settings: getSettings(db) };
  });

  // ----- agents (remote and CLI) -----
  app.post<{ Body: { user?: string; deviceName?: string } }>("/api/agent/register", async (req) => {
    const { user, token } = registerRemoteDevice(db, req.body?.user ?? "", req.body?.deviceName ?? "remote agent");
    return { user, token, settings: getSettings(db) };
  });

  app.get("/api/agent/jobs/next", async (req) => {
    const device = deviceAuth(req);
    return { job: claimNextJob(db, device.id) ?? null, settings: getSettings(db) };
  });

  app.post<{ Body: { type?: JobType } }>("/api/agent/jobs", async (req) => {
    const device = deviceAuth(req);
    if (!device.user_id) throw new HttpError(409, "This agent is not linked to a developer yet. Sign in as a developer first.");
    const type = req.body?.type;
    if (!type || !JOB_TYPES.includes(type)) throw new HttpError(400, "Unknown job type.");
    const job = createJob(db, device.user_id, type);
    onJobCreated?.();
    return { job };
  });

  app.get<{ Params: { id: string } }>("/api/agent/jobs/:id", async (req) => {
    const device = deviceAuth(req);
    const job = jobById(db, Number(req.params.id));
    if (!job || job.device_id !== device.id) throw new HttpError(404, "Job not found.");
    return { job };
  });

  app.post<{ Params: { id: string }; Body: { result?: JobResult; error?: string } }>("/api/agent/jobs/:id/result", async (req) => {
    const device = deviceAuth(req);
    const job = jobById(db, Number(req.params.id));
    if (!job || job.device_id !== device.id) throw new HttpError(404, "Job not found.");
    completeJob(db, job.id, req.body?.result ?? null, req.body?.error);
    return { ok: true };
  });

  // ----- frontend -----
  if (webDir && fs.existsSync(webDir)) {
    app.register(fastifyStatic, { root: path.resolve(webDir) });
    app.setNotFoundHandler((req, reply: FastifyReply) => {
      if (req.url.startsWith("/api/")) return reply.status(404).send({ error: "Not found." });
      return reply.sendFile("index.html");
    });
  }

  return app;
}
