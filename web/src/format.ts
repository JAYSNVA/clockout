export function hm(minutes: number) {
  const m = Math.round(minutes);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function clock(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function shortDate(key: string) {
  return new Date(`${key}T12:00:00`).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}

export function weekLabel(key: string) {
  return new Date(`${key}T12:00:00`).toLocaleDateString([], { day: "numeric", month: "short" });
}

export function ago(iso: string | null) {
  if (!iso) return "never";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const days = Math.round(s / 86400);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

export function dateTime(iso: string) {
  return new Date(iso).toLocaleString([], { weekday: "long", hour: "2-digit", minute: "2-digit" });
}

// Minutes after midnight (may exceed 24h for after-midnight finishes) as HH:MM.
export function hhmm(minutes: number) {
  const m = Math.round(minutes) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
