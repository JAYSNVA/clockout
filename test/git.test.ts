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
