import { createSign } from "node:crypto";

function encode(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function createGitHubAppJwt({ appId, privateKey, now = Math.floor(Date.now() / 1000) }) {
  const issuer = String(appId || "").trim();
  const key = String(privateKey || "").replaceAll("\\n", "\n").trim();
  if (!/^[0-9]+$/.test(issuer) || !key.includes("PRIVATE KEY")) throw new Error("GitHub App id and private key are required");
  const header = encode({ alg: "RS256", typ: "JWT" });
  const payload = encode({ iat: now - 30, exp: now + 540, iss: issuer });
  const unsigned = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(unsigned).end().sign(key, "base64url");
  return `${unsigned}.${signature}`;
}

export async function createGitHubInstallationToken({ appId, privateKey, installationId, repository, fetchImpl = fetch }) {
  const jwt = createGitHubAppJwt({ appId, privateKey });
  const response = await fetchImpl(`https://api.github.com/app/installations/${encodeURIComponent(String(installationId || ""))}/access_tokens`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ repositories: [String(repository || "")], permissions: { contents: "write" } }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.token) throw new Error(`GitHub App installation token request failed (${response.status})`);
  return { token: body.token, expiresAt: body.expires_at || "" };
}
