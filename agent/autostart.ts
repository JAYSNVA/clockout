// npm run autostart: start the Clockout dashboard at login, so it's always at http://localhost:4321.
// npm run autostart -- --remove: stop it and remove the login item.
// macOS uses a launchd LaunchAgent, Linux a systemd user service. Logs go to ~/.clockout/server.log.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "../shared/paths.js";

export const LABEL = process.env.CLOCKOUT_SERVICE_LABEL ?? "dev.clockout.server";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface ServiceSpec {
  node: string;
  root: string;
  log: string;
  env: Record<string, string>;
}

export function serviceSpec(): ServiceSpec {
  const home = os.homedir();
  const pathDirs = [path.dirname(process.execPath), path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  return {
    node: process.execPath,
    root,
    log: path.join(paths().clockoutHome, "server.log"),
    env: {
      // Your port and Clockout folder settings carry over. API keys are not written to disk.
      ...Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v && (k === "PORT" || k === "CLAUDE_DIR" || k.startsWith("CLOCKOUT_")) && k !== "CLOCKOUT_SERVICE_LABEL")) as Record<string, string>,
      CLOCKOUT_NO_OPEN: "1",
      PATH: [...new Set(pathDirs)].join(":"),
      HOME: home,
    },
  };
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function launchdPlist(spec: ServiceSpec): string {
  const env = Object.entries(spec.env)
    .map(([k, v]) => `      <key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(spec.node)}</string>
      <string>--import</string>
      <string>tsx</string>
      <string>${xml(path.join(spec.root, "server", "index.ts"))}</string>
    </array>
    <key>WorkingDirectory</key><string>${xml(spec.root)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
    <key>StandardOutPath</key><string>${xml(spec.log)}</string>
    <key>StandardErrorPath</key><string>${xml(spec.log)}</string>
  </dict>
</plist>
`;
}

export function systemdUnit(spec: ServiceSpec): string {
  const env = Object.entries(spec.env)
    .map(([k, v]) => `Environment="${k}=${v}"`)
    .join("\n");
  return `[Unit]
Description=Clockout dashboard

[Service]
WorkingDirectory=${spec.root}
ExecStart=${spec.node} --import tsx ${path.join(spec.root, "server", "index.ts")}
${env}
Restart=on-failure
StandardOutput=append:${spec.log}
StandardError=append:${spec.log}

[Install]
WantedBy=default.target
`;
}

const plistPath = () => path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const unitPath = () => path.join(os.homedir(), ".config", "systemd", "user", "clockout.service");
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
const tryRun = (cmd: string, args: string[]) => {
  try {
    run(cmd, args);
  } catch {
    // already stopped or not loaded
  }
};

function install() {
  run("npm", ["run", "--silent", "build:web"]); // the service serves the built frontend
  const spec = serviceSpec();
  fs.mkdirSync(path.dirname(spec.log), { recursive: true });
  if (process.platform === "darwin") {
    const domain = `gui/${process.getuid!()}`;
    tryRun("launchctl", ["bootout", `${domain}/${LABEL}`]);
    fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
    fs.writeFileSync(plistPath(), launchdPlist(spec));
    run("launchctl", ["bootstrap", domain, plistPath()]);
    return plistPath();
  }
  if (process.platform === "linux") {
    fs.mkdirSync(path.dirname(unitPath()), { recursive: true });
    fs.writeFileSync(unitPath(), systemdUnit(spec));
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", "clockout.service"]);
    return unitPath();
  }
  throw new Error("Autostart supports macOS and Linux. On other systems, run npm start.");
}

function remove(): boolean {
  if (process.platform === "darwin") {
    tryRun("launchctl", ["bootout", `gui/${process.getuid!()}/${LABEL}`]);
    if (!fs.existsSync(plistPath())) return false;
    fs.rmSync(plistPath());
    return true;
  }
  if (process.platform === "linux") {
    tryRun("systemctl", ["--user", "disable", "--now", "clockout.service"]);
    if (!fs.existsSync(unitPath())) return false;
    fs.rmSync(unitPath());
    tryRun("systemctl", ["--user", "daemon-reload"]);
    return true;
  }
  return false;
}

if (process.argv[1]?.endsWith("autostart.ts")) {
  try {
    if (process.argv.includes("--remove")) {
      console.log(remove() ? "Autostart removed. Clockout no longer starts at login." : "Autostart was not set up.");
    } else {
      const file = install();
      console.log(`Clockout now starts at login and is running at http://localhost:${process.env.PORT || 4321}`);
      console.log(`  Service: ${file}\n  Logs:    ${serviceSpec().log}\n  Undo:    npm run autostart -- --remove`);
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
