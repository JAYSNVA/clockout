import os from "node:os";
import path from "node:path";

// Every location is overridable by environment so tests never touch the real home folder.
export function paths() {
  const home = os.homedir();
  const clockoutHome = process.env.CLOCKOUT_HOME ?? path.join(home, ".clockout");
  return {
    home,
    clockoutHome,
    db: process.env.CLOCKOUT_DB ?? path.join(clockoutHome, "clockout.db"),
    claudeDir: process.env.CLAUDE_DIR ?? path.join(home, ".claude"),
    tomorrowDir: process.env.CLOCKOUT_TOMORROW_DIR ?? path.join(home, "clockout"),
    scanRoots: (process.env.CLOCKOUT_SCAN_ROOTS ?? home).split(":").filter(Boolean),
    pauseState: path.join(clockoutHome, "pause.json"),
    pauseHook: path.join(clockoutHome, "pause-hook.mjs"),
    blockedLog: path.join(clockoutHome, "blocked.log"),
    pickupState: path.join(clockoutHome, "pickup.json"),
    pickupHook: path.join(clockoutHome, "pickup-hook.mjs"),
    summaryDir: path.join(clockoutHome, "summary"),
    backups: path.join(clockoutHome, "backups"),
    agentConfig: path.join(clockoutHome, "config.json"),
    localDevice: path.join(clockoutHome, "local-device.json"),
  };
}
