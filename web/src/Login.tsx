import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api";
import { DemoBanner } from "./App";

type Role = "developer" | "manager";

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [users, setUsers] = useState<{ name: string; role: Role }[]>([]);
  const [demo, setDemo] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("developer");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ users: { name: string; role: Role }[]; hasManager: boolean; demo: boolean }>("GET", "/api/users").then((r) => {
      setUsers(r.users);
      setDemo(r.demo);

    });
  }, []);

  const signIn = async (n: string, r: Role) => {
    setBusy(true);
    setError("");
    try {
      await api("POST", "/api/login", { name: n, role: r });
      onSignedIn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void signIn(name, role);
  };

  const manager = users.find((u) => u.role === "manager");
  const developers = users.filter((u) => u.role === "developer");

  return (
    <>
    {demo && <DemoBanner />}
    <main className="login">
      <div>
        <div className="eyebrow">Clockout</div>
        <h1>Take the load off.</h1>
        <p className="secondary">
          See how much you're juggling, then end the day properly: save open work, write tomorrow's list and pause your
          Claude Code agents until morning.
        </p>
      </div>

      <form className="card" onSubmit={submit}>
        <h3>Sign in</h3>
        <label className="small secondary">
          Your name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Aoife" style={{ width: "100%", marginTop: 4 }} autoFocus />
        </label>
        <div className="seg" role="radiogroup" aria-label="Role">
          <button type="button" className={role === "developer" ? "on" : ""} onClick={() => setRole("developer")}>
            Developer
          </button>
          <button type="button" className={role === "manager" ? "on" : ""} onClick={() => setRole("manager")}>
            Manager
          </button>
        </div>
        {role === "manager" && manager && <div className="notice">There is one manager: {manager.name}. Sign in with that name.</div>}
        {error && <div className="error-text">{error}</div>}
        <button className="primary" type="submit" disabled={busy || !name.trim()}>
          Sign in
        </button>
        <div className="muted small">No password: this is a local app for people you trust.</div>
      </form>

      {users.length > 0 && (
        <div className="card">
          <h3>Continue as</h3>
          {demo && <div className="small secondary">Try Aoife (the developer on this machine) or Maya (the manager).</div>}
          <div className="chips">
            {manager && (
              <button className="chip" onClick={() => signIn(manager.name, "manager")} disabled={busy}>
                {manager.name} · Manager
              </button>
            )}
            {developers.map((u) => (
              <button key={u.name} className="chip" onClick={() => signIn(u.name, "developer")} disabled={busy}>
                {u.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </main>
    </>
  );
}
