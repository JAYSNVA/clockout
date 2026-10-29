const JIRA_KEY = /\b([A-Z][A-Z0-9]+)-(\d+)\b/g;

// Common uppercase-dash-number tokens that are not Jira keys.
const NOT_JIRA = new Set([
  "UTF", "ISO", "SHA", "RFC", "GPT", "MD", "AES", "RSA", "HTTP", "TLS", "SSL", "CVE",
  "ES", "COVID", "IPV", "PEP", "JSR", "JEP", "WCAG", "ECMA", "OAUTH", "H", "X", "P",
]);

export function jiraKeys(text: string | null | undefined): string[] {
  if (!text) return [];
  const keys: string[] = [];
  for (const m of text.matchAll(JIRA_KEY)) {
    if (!NOT_JIRA.has(m[1])) keys.push(`${m[1]}-${m[2]}`);
  }
  return keys;
}

export function firstJiraKey(text: string | null | undefined): string | null {
  return jiraKeys(text)[0] ?? null;
}
