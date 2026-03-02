const fs = require("fs");
const path = require("path");

const TOKEN_PATH = "/Users/icl-agent/secrets/jobber.token.json";
const ENV_PATH = "/Users/icl-agent/secrets/jobber.env";
const JOBBER_API_URL = "https://api.getjobber.com/api/graphql";

function readEnvFile(fp) {
  const out = {};
  const txt = fs.readFileSync(fp, "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith("\"") && v.endsWith("\"")) || (v.startsWith(") && v.endsWith("))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function readToken() {
  return JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
}

function writeTokenAtomic(tok) {
  const tmp = TOKEN_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(tok, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, TOKEN_PATH);
}

async function refreshTokenIfNeeded() {
  const tok = readToken();
  const env = readEnvFile(ENV_PATH);

  // If obtained_at is missing, assume token might be stale and attempt refresh.
  const obtainedAt = tok.obtained_at ? Number(tok.obtained_at) : 0;
  const now = Date.now();
  const ageMs = obtainedAt ? (now - obtainedAt) : Number.POSITIVE_INFINITY;

  // Refresh if older than 45 minutes OR missing obtained_at.
  const needsRefresh = !obtainedAt || ageMs > 45 * 60 * 1000;

  if (!needsRefresh) return tok;

  if (!tok.refresh_token) throw new Error("Jobber token missing refresh_token");
  if (!env.JOBBER_CLIENT_ID || !env.JOBBER_CLIENT_SECRET) throw new Error("Missing JOBBER_CLIENT_ID/SECRET in jobber.env");

  const params = new URLSearchParams();
  params.set("grant_type", "refresh_token");
  params.set("refresh_token", tok.refresh_token);
  params.set("client_id", env.JOBBER_CLIENT_ID);
  params.set("client_secret", env.JOBBER_CLIENT_SECRET);

  const resp = await fetch("https://api.getjobber.com/api/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`Jobber refresh failed: ${resp.status} ${JSON.stringify(data)}`);
  }

  const next = {
    ...tok,
    access_token: data.access_token,
    refresh_token: data.refresh_token || tok.refresh_token,
    obtained_at: Date.now(),
  };

  writeTokenAtomic(next);
  return next;
}

async function jobberGraphQL({ query, variables }) {
  const tok = await refreshTokenIfNeeded();
  const env = readEnvFile(ENV_PATH);

  const resp = await fetch(JOBBER_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${tok.access_token}`,
      // Jobber requires X-JOBBER-GRAPHQL-VERSION; if it exists in env, use it, otherwise default.
      "X-JOBBER-GRAPHQL-VERSION": env.JOBBER_GRAPHQL_VERSION || "2023-11-15",
    },
    body: JSON.stringify({ query, variables: variables || {} }),
  });

  const json = await resp.json();
  if (!resp.ok) throw new Error(`Jobber GraphQL HTTP ${resp.status}: ${JSON.stringify(json)}`);
  if (json.errors && json.errors.length) throw new Error(`Jobber GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

module.exports = { jobberGraphQL };
