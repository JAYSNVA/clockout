import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claudeNotes, parseNotes, type RepoDay } from "../agent/tomorrow";
import { paths } from "../shared/paths";
import { sandbox } from "./helpers";

const days: RepoDay[] = [
  { repo: "api", tasks: ["PAY-3"], commits: ["PAY-3 retry client"], uncommitted: ["src/retry.ts"], lastPrompts: [{ task: "PAY-3", text: "add retry to webhooks" }] },
  { repo: "web", tasks: [], commits: [], uncommitted: [], lastPrompts: [{ task: null, text: "fix the navbar" }] },
];

describe("Claude notes for tomorrow's list", () => {
  it("parses a JSON object out of a reply and keeps only known repos", () => {
    expect(parseNotes('Here you go:\n```json\n{"api": "Retries half done.", "other": "x"}\n```', ["api", "web"])).toEqual({ api: "Retries half done." });
    expect(parseNotes("no json", ["api"])).toBeUndefined();
  });

  it("uses the Claude Code CLI when there is no API key: headless, no tools, no hooks, no saved session", async () => {
    const { root } = sandbox();
    delete process.env.CLOCKOUT_SUMMARY;
    const bin = path.join(root, "claude");
    const record = path.join(root, "call.json");
    fs.writeFileSync(
      bin,
      `#!/usr/bin/env node
require("fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), internal: process.env.CLOCKOUT_INTERNAL, nested: process.env.CLAUDECODE ?? null }));
process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: '{"api": "You were adding retries; next, run the tests.", "web": "Navbar fix in progress."}' }));
`,
      { mode: 0o755 },
    );
    process.env.CLOCKOUT_CLAUDE_BIN = bin;
    process.env.CLAUDECODE = "1";

    const notes = await claudeNotes(days);
    delete process.env.CLAUDECODE;

    expect(notes).toEqual({ source: "claude-code", notes: { api: "You were adding retries; next, run the tests.", web: "Navbar fix in progress." } });
    const call = JSON.parse(fs.readFileSync(record, "utf8"));
    expect(call.args).toEqual(expect.arrayContaining(["-p", "--output-format", "json", "--no-session-persistence", "--tools", "", "--disable-slash-commands"]));
    expect(call.args[call.args.indexOf("--settings") + 1]).toBe('{"disableAllHooks":true}');
    expect(call.args[1]).toContain("add retry to webhooks");
    expect(fs.realpathSync(call.cwd)).toBe(fs.realpathSync(paths().summaryDir));
    expect(call.internal).toBe("1");
    expect(call.nested).toBeNull();
  });

  it("falls back to no notes when the CLI fails", async () => {
    const { root } = sandbox();
    delete process.env.CLOCKOUT_SUMMARY;
    const bin = path.join(root, "claude");
    fs.writeFileSync(bin, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    process.env.CLOCKOUT_CLAUDE_BIN = bin;
    expect(await claudeNotes(days)).toBeUndefined();
  });
});
