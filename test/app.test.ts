import { describe, expect, it } from "vitest";
import { buildApp } from "../server/app";
import { openDb } from "../server/db";
import { sandbox } from "./helpers";

const login = { method: "POST" as const, url: "/api/login", payload: { name: "Ana", role: "developer" } };

describe("localhost protection", () => {
  it("rejects requests for other hosts or from other sites unless started with --lan", async () => {
    sandbox();
    const app = buildApp({ db: openDb(":memory:") });
    expect((await app.inject({ ...login, headers: { host: "localhost:4321" } })).statusCode).toBe(200);
    expect((await app.inject({ ...login, headers: { host: "127.0.0.1:4321", origin: "http://localhost:4321" } })).statusCode).toBe(200);
    // DNS rebinding: evil.example resolves to 127.0.0.1
    expect((await app.inject({ ...login, headers: { host: "evil.example:4321" } })).statusCode).toBe(403);
    // A page on another site posting to localhost
    expect((await app.inject({ ...login, headers: { host: "localhost:4321", origin: "https://evil.example" } })).statusCode).toBe(403);
    await app.close();

    const lanApp = buildApp({ db: openDb(":memory:"), lan: true });
    expect((await lanApp.inject({ ...login, headers: { host: "192.168.1.20:4321" } })).statusCode).toBe(200);
    await lanApp.close();
  });
});
