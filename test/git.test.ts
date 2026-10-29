import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { readCommits, readTaskDone, saveOpenWork } from "../agent/git";
import { author, commit, makeRepo, sandbox, sh, todayAt } from "./helpers";

describe("saveOpenWork", () => {
  let repo: string;
  beforeEach(() => {
    const { code } = sandbox();
    repo = makeRepo(path.join(code, "api"));
    commit(repo, "a.txt", "one\n", "init", author("Dev", "dev@example.com", todayAt(9)));
  });

  it("saves tracked and untracked changes to a clockout branch without touching the working tree", () => {
    fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
    fs.writeFileSync(path.join(repo, "new.txt"), "untracked\n");
    sh(repo, ["add", "a.txt"]); // a staged change must stay staged
    const statusBefore = sh(repo, ["status", "--porcelain"]);
    const headBefore = sh(repo, ["rev-parse", "HEAD"]);

    const saved = saveOpenWork(repo, "2026-10-29");

    expect(saved).toMatchObject({ status: "saved", branch: "clockout/2026-10-29", files: 2 });
    expect(sh(repo, ["status", "--porcelain"])).toBe(statusBefore);
    expect(sh(repo, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(sh(repo, ["symbolic-ref", "--short", "HEAD"])).toBe("main");
    expect(sh(repo, ["show", "clockout/2026-10-29:a.txt"])).toBe("changed");
    expect(sh(repo, ["show", "clockout/2026-10-29:new.txt"])).toBe("untracked");

    // A second clock-out the same day gets its own branch.
    const again = saveOpenWork(repo, "2026-10-29", todayAt(18, 5));
    expect(again.branch).toBe("clockout/2026-10-29-1805");
  });

  it("skips clean repos and repos in the middle of a merge", () => {
    expect(saveOpenWork(repo, "2026-10-29")).toMatchObject({ status: "skipped", reason: "no uncommitted changes" });
    fs.writeFileSync(path.join(repo, ".git", "MERGE_HEAD"), sh(repo, ["rev-parse", "HEAD"]));
    fs.writeFileSync(path.join(repo, "a.txt"), "x\n");
    expect(saveOpenWork(repo, "2026-10-29")).toMatchObject({ status: "skipped", reason: "merge in progress" });
  });
});

describe("commits and task status", () => {
  it("reads all authors, Jira keys from messages and branches, and done dates from merges", () => {
    const { code } = sandbox();
    const repo = makeRepo(path.join(code, "web"));
    const a = author("Ana", "ana@example.com", todayAt(9));
    const b = author("Ben", "ben@example.com", todayAt(10));
    commit(repo, "a.txt", "1", "init", a);
    sh(repo, ["checkout", "-q", "-b", "feature/WEB-7-login"]);
    commit(repo, "b.txt", "2", "add login form", b);
    commit(repo, "b2.txt", "2", "WEB-7 validation", b);
    sh(repo, ["checkout", "-q", "main"]);
    sh(repo, ["merge", "-q", "--no-ff", "feature/WEB-7-login", "-m", "Merge branch 'feature/WEB-7-login'"], author("Ben", "ben@example.com", todayAt(11)));
    sh(repo, ["checkout", "-q", "-b", "WEB-8-open"]);
    commit(repo, "c.txt", "3", "WEB-8 start", a);
    sh(repo, ["branch", "-q", "clockout/2026-01-01"]); // WIP branches are ignored

    const commits = readCommits(repo, new Date(Date.now() - 86400000 * 2));
    const login = commits.find((c) => c.subject === "add login form")!;
    expect(login).toMatchObject({ email: "ben@example.com", task: "WEB-7", onDefault: true });
    expect(commits.find((c) => c.subject === "WEB-8 start")).toMatchObject({ task: "WEB-8", onDefault: false });

    const done = readTaskDone(repo, new Date(Date.now() - 86400000 * 2));
    expect(done.map((d) => d.key)).toEqual(["WEB-7"]);
    // Done when merged, not when the first branch commit mentioning the key was written.
    expect(new Date(done[0].doneAt!).getHours()).toBe(11);
  });
});

describe("pruneClockoutBranches", () => {
  it("deletes only Clockout's own WIP branches older than the limit, never the checked-out one", async () => {
    const { pruneClockoutBranches } = await import("../agent/git");
    const { code } = sandbox();
    const repo = makeRepo(path.join(code, "api"));
    commit(repo, "a.txt", "1", "init", author("Dev", "dev@example.com", todayAt(9)));
    const old = new Date(Date.now() - 20 * 86400000);
    fs.writeFileSync(path.join(repo, "a.txt"), "wip\n");
    expect(saveOpenWork(repo, "2026-10-01", old).branch).toBe("clockout/2026-10-01");
    // saveOpenWork stamps the commit with the real clock; age it like a branch from 20 days ago
    const sha = sh(repo, ["commit-tree", sh(repo, ["rev-parse", "clockout/2026-10-01^{tree}"]), "-p", "HEAD", "-m", "WIP: clockout 2026-10-01"], author("Dev", "dev@example.com", old));
    sh(repo, ["update-ref", "refs/heads/clockout/2026-10-01", sha]);
    sh(repo, ["branch", "clockout/my-own-notes"]); // a branch the developer made under clockout/
    expect(saveOpenWork(repo, "2026-10-29").branch).toBe("clockout/2026-10-29"); // recent

    expect(pruneClockoutBranches(repo, 14)).toEqual(["clockout/2026-10-01"]);
    expect(sh(repo, ["branch", "--list", "clockout/*"]).split("\n").map((b) => b.trim()).sort()).toEqual(["clockout/2026-10-29", "clockout/my-own-notes"]);
  });
});

describe("repos with the same folder name", () => {
  it("get distinct names instead of being merged", async () => {
    const { collect } = await import("../agent/collect");
    const { code, claudeDir } = sandbox();
    const work = makeRepo(path.join(code, "work", "backend"));
    const mine = makeRepo(path.join(code, "personal", "backend"));
    commit(work, "a.txt", "1", "API-1 work change", author("Dev", "dev@example.com", todayAt(9)));
    commit(mine, "a.txt", "1", "side project", author("Dev", "dev@example.com", todayAt(10)));
    const { writeClaudeSession } = await import("./helpers");
    writeClaudeSession(claudeDir, { sessionId: "s1", cwd: work, start: todayAt(9), end: todayAt(9, 20), promptEvery: 5 });

    const { payload, local } = await collect(todayAt(23));
    expect(payload.commits.map((c) => c.repo).sort()).toEqual(["backend (personal)", "backend (work)"]);
    expect(new Set(payload.claudeEvents.map((e) => e.repo))).toEqual(new Set(["backend (work)"]));
    expect(fs.realpathSync(local.repoPaths.get("backend (work)")!)).toBe(fs.realpathSync(work));
  });
});
