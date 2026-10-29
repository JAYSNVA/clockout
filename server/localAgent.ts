import { runJob } from "../agent/runner.js";
import type { DB } from "./db.js";
import { claimNextJob, completeJob, getSettings, localDevice } from "./store.js";

// The in-process collector for the machine running the server.
// Picks up jobs for the local device and runs them one at a time.
export function startLocalAgent(db: DB, intervalMs = 5000) {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const device = localDevice(db);
      if (!device?.user_id) return;
      let job = claimNextJob(db, device.id);
      while (job) {
        try {
          const result = await runJob(job.type, getSettings(db));
          completeJob(db, job.id, result);
        } catch (err) {
          completeJob(db, job.id, null, (err as Error).message);
        }
        job = claimNextJob(db, device.id);
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  return { tick, stop: () => clearInterval(timer) };
}
