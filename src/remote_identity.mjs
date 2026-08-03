import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_ISSUER = "context-room";
const DEFAULT_AUDIENCE = "context-room";
const MAX_TOKEN_BYTES = 16_384;

function remoteIdentityError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function encode(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decode(value) {
  try {
    return JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
  } catch {
    throw remoteIdentityError("The signed Context Room identity is malformed.", 403, "remote_identity_invalid");
  }
}

function assertSecret(secret) {
  if (Buffer.byteLength(String(secret || ""), "utf8") < 32) {
    throw remoteIdentityError("Context Room remote identity secret must contain at least 32 bytes.", 500, "remote_identity_secret_invalid");
  }
  return String(secret);
}

function normalizedOperations(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))].sort();
}

export function createReplayStore() {
  const consumed = new Map();
  return {
    consume(jti, exp, now) {
      for (const [key, expiresAt] of consumed) if (expiresAt < now) consumed.delete(key);
      if (consumed.has(jti)) return false;
      consumed.set(jti, exp);
      return true;
    },
    clear() {
      consumed.clear();
    },
  };
}

export function signRemoteIdentity(claims, secret, {
  now = Math.floor(Date.now() / 1000),
  ttlSeconds = 30,
  issuer = DEFAULT_ISSUER,
  audience = DEFAULT_AUDIENCE,
  jti = "",
} = {}) {
  const signingSecret = assertSecret(secret);
  const tokenId = String(jti || claims?.jti || "").trim();
  if (!tokenId || tokenId.length > 200) throw remoteIdentityError("A bounded anti-replay identifier is required.", 400, "remote_identity_jti_required");
  const subject = String(claims?.sub || "").trim();
  if (!subject || subject.length > 200) throw remoteIdentityError("A bounded identity subject is required.", 400, "remote_identity_subject_required");
  const lifetime = Number(ttlSeconds);
  if (!Number.isInteger(lifetime) || lifetime < 1 || lifetime > 600) throw remoteIdentityError("Remote identity lifetime must be between 1 and 600 seconds.", 400, "remote_identity_ttl_invalid");
  const payload = {
    ...claims,
    sub: subject,
    kind: String(claims?.kind || "").trim(),
    operations: normalizedOperations(claims?.operations),
    iss: issuer,
    aud: audience,
    iat: now,
    exp: now + lifetime,
    jti: tokenId,
  };
  const header = encode({ alg: "HS256", typ: "JWT", kid: "context-room-v1" });
  const body = encode(payload);
  const unsigned = `${header}.${body}`;
  const signature = createHmac("sha256", signingSecret).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

export function verifyRemoteIdentity(token, secret, {
  now = Math.floor(Date.now() / 1000),
  issuer = DEFAULT_ISSUER,
  audience = DEFAULT_AUDIENCE,
  kind = "",
  operation = "",
  replayStore = null,
} = {}) {
  const signingSecret = assertSecret(secret);
  const value = String(token || "").trim();
  if (!value || Buffer.byteLength(value, "utf8") > MAX_TOKEN_BYTES) throw remoteIdentityError("A signed Context Room identity is required.", 403, "remote_identity_required");
  const parts = value.split(".");
  if (parts.length !== 3) throw remoteIdentityError("The signed Context Room identity is malformed.", 403, "remote_identity_invalid");
  const header = decode(parts[0]);
  if (header.alg !== "HS256" || header.typ !== "JWT") throw remoteIdentityError("The signed Context Room identity algorithm is invalid.", 403, "remote_identity_invalid");
  const unsigned = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(createHmac("sha256", signingSecret).update(unsigned).digest("base64url"), "utf8");
  const received = Buffer.from(parts[2], "utf8");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw remoteIdentityError("The signed Context Room identity is invalid.", 403, "remote_identity_invalid");
  const payload = decode(parts[1]);
  if (payload.iss !== issuer || payload.aud !== audience) throw remoteIdentityError("The signed Context Room identity audience is invalid.", 403, "remote_identity_audience_mismatch");
  if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) || payload.iat > now + 30 || payload.exp < now) {
    throw remoteIdentityError("The signed Context Room identity has expired.", 403, "remote_identity_expired");
  }
  if (payload.exp - payload.iat > 600) throw remoteIdentityError("The signed Context Room identity lifetime is invalid.", 403, "remote_identity_invalid");
  if (!payload.jti || !payload.sub) throw remoteIdentityError("The signed Context Room identity is incomplete.", 403, "remote_identity_invalid");
  if (kind && payload.kind !== kind) throw remoteIdentityError("This identity cannot access the requested Context Room surface.", 403, "remote_identity_kind_mismatch");
  const operations = normalizedOperations(payload.operations);
  if (operation && !operations.includes(operation)) throw remoteIdentityError("This identity is not allowed to perform the requested operation.", 403, "remote_identity_operation_denied");
  if (replayStore && !replayStore.consume(String(payload.jti), payload.exp, now)) throw remoteIdentityError("This signed Context Room request was already used.", 403, "remote_identity_replayed");
  return { ...payload, operations };
}

export function bearerToken(headers = {}) {
  const authorization = String(headers.authorization || "").trim();
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
  return match?.[1] || "";
}
