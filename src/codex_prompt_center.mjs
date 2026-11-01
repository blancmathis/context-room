import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";

export const CODEX_PROMPT_PROTOCOL_VERSION = 1;
export const CODEX_PROMPT_RECEIPT_VERSION = 2;
export const CODEX_PROMPT_PUBLICATION_STATE_VERSION = 2;
export const MAX_CODEX_PROMPT_BYTES = 28 * 1024;
export const MAX_CODEX_PROMPT_ESTIMATED_TOKENS = 8_192;
export const CODEX_PROMPT_HIGH_CONTEXT_CONFIRM_TOKENS = 1_000;
export const MAX_CODEX_PROMPT_MANIFEST_BYTES = 16 * 1_048_576;
export const MAX_CODEX_PROMPT_REQUEST_BYTES = 8 * MAX_CODEX_PROMPT_BYTES + 65_536;
export const CODEX_PROMPT_RESTART_MESSAGE = "Quit Codex completely (⌘Q on macOS), reopen it, then create a new task.";

const CATALOG_FILE = "catalog.json";
const OVERRIDES_FILE = "overrides.json";
const LAST_KNOWN_GOOD_FILE = "last-known-good.json";
const PUBLICATION_STATE_FILE = ".publication-state.json";
const RUNTIME_DIR = "runtime";
const WRITE_LOCK_FILE = ".context-room-write.lock";
const WRITE_LOCK_OWNER_FILE = "owner.json";
const WRITE_LOCK_RECLAIM_FILE = ".reclaim";
const INCOMPLETE_WRITE_LOCK_GRACE_MS = 30_000;
const WRITE_LOCK_RECORD_MAX_BYTES = 4_096;
const WRITE_LOCK_PROCESS_START_FS_TOLERANCE_MS = 2_000;
const MAX_RUNTIME_RECEIPT_READ_ATTEMPTS = 2;
const MAX_CODEX_PROMPT_PUBLICATION_STATE_BYTES = 1_048_576;
const DARWIN_PROCESS_START_IDENTITY = /^darwin-proc-bsdinfo-v1:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([1-9]\d*):([0-9]{6})$/;
const DARWIN_PROCESS_START_IDENTITY_SCRIPT = String.raw`
import ctypes
import sys
import uuid

PROC_PIDTBSDINFO = 3
MAXCOMLEN = 16
MAX_BOOT_SESSION_UUID_BYTES = 128

class ProcBsdInfo(ctypes.Structure):
    _fields_ = [
        ("pbi_flags", ctypes.c_uint32),
        ("pbi_status", ctypes.c_uint32),
        ("pbi_xstatus", ctypes.c_uint32),
        ("pbi_pid", ctypes.c_uint32),
        ("pbi_ppid", ctypes.c_uint32),
        ("pbi_uid", ctypes.c_uint32),
        ("pbi_gid", ctypes.c_uint32),
        ("pbi_ruid", ctypes.c_uint32),
        ("pbi_rgid", ctypes.c_uint32),
        ("pbi_svuid", ctypes.c_uint32),
        ("pbi_svgid", ctypes.c_uint32),
        ("rfu_1", ctypes.c_uint32),
        ("pbi_comm", ctypes.c_char * MAXCOMLEN),
        ("pbi_name", ctypes.c_char * (2 * MAXCOMLEN)),
        ("pbi_nfiles", ctypes.c_uint32),
        ("pbi_pgid", ctypes.c_uint32),
        ("pbi_pjobc", ctypes.c_uint32),
        ("e_tdev", ctypes.c_uint32),
        ("e_tpgid", ctypes.c_uint32),
        ("pbi_nice", ctypes.c_int32),
        ("pbi_start_tvsec", ctypes.c_uint64),
        ("pbi_start_tvusec", ctypes.c_uint64),
    ]

def validate_process_info(pid, read_size, expected_size, info):
    if (
        read_size != expected_size
        or info.pbi_pid != pid
        or info.pbi_start_tvsec <= 0
        or info.pbi_start_tvusec >= 1000000
    ):
        raise SystemExit(1)
    return info.pbi_start_tvsec, info.pbi_start_tvusec

def canonical_boot_session_uuid(raw_bytes):
    try:
        raw_text = raw_bytes.decode("ascii")
        canonical = str(uuid.UUID(raw_text))
    except (UnicodeDecodeError, ValueError, AttributeError):
        raise SystemExit(1)
    if raw_text.lower() != canonical:
        raise SystemExit(1)
    return canonical

def read_process_start(pid):
    info = ProcBsdInfo()
    libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    libproc.proc_pidinfo.argtypes = [
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_uint64,
        ctypes.c_void_p,
        ctypes.c_int,
    ]
    libproc.proc_pidinfo.restype = ctypes.c_int
    expected_size = ctypes.sizeof(info)
    read_size = libproc.proc_pidinfo(
        pid,
        PROC_PIDTBSDINFO,
        0,
        ctypes.byref(info),
        expected_size,
    )
    return validate_process_info(pid, read_size, expected_size, info)

def read_boot_session_uuid(libc=None, create_buffer=ctypes.create_string_buffer):
    if libc is None:
        libc = ctypes.CDLL(None, use_errno=True)
    libc.sysctlbyname.argtypes = [
        ctypes.c_char_p,
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_size_t),
        ctypes.c_void_p,
        ctypes.c_size_t,
    ]
    libc.sysctlbyname.restype = ctypes.c_int
    boot_name = b"kern.bootsessionuuid"
    boot_size = ctypes.c_size_t()
    if libc.sysctlbyname(boot_name, None, ctypes.byref(boot_size), None, 0) != 0:
        raise SystemExit(1)
    capacity = boot_size.value
    if capacity <= 0 or capacity > MAX_BOOT_SESSION_UUID_BYTES:
        raise SystemExit(1)
    boot_buffer = create_buffer(capacity)
    returned_size = ctypes.c_size_t(capacity)
    if (
        libc.sysctlbyname(
            boot_name,
            boot_buffer,
            ctypes.byref(returned_size),
            None,
            0,
        ) != 0
        or returned_size.value <= 0
        or returned_size.value > capacity
    ):
        raise SystemExit(1)
    raw_bytes = bytes(boot_buffer.raw[:returned_size.value])
    if raw_bytes.endswith(b"\0"):
        raw_bytes = raw_bytes[:-1]
    return canonical_boot_session_uuid(raw_bytes)

def main():
    try:
        pid = int(sys.argv[1])
    except (IndexError, TypeError, ValueError):
        raise SystemExit(1)
    if pid <= 0:
        raise SystemExit(1)
    start_tvsec, start_tvusec = read_process_start(pid)
    boot_session = read_boot_session_uuid()
    print(
        f"darwin-proc-bsdinfo-v1:{boot_session}:"
        f"{start_tvsec}:{start_tvusec:06d}"
    )

if __name__ == "__main__":
    main()
`;
const SECURE_READ_FLAGS = fs.constants.O_RDONLY
  | (fs.constants.O_NOFOLLOW || 0)
  | (fs.constants.O_CLOEXEC || 0)
  | (fs.constants.O_NONBLOCK || 0);
const CATALOG_ROOT_KEYS = ["schemaVersion", "runtimeVersion", "catalogRevision", "groups"];
const CATALOG_GROUP_KEYS = ["id", "label", "targets"];
const CATALOG_TARGET_KEYS = [
  "id",
  "label",
  "kind",
  "editable",
  "runtimeStatus",
  "officialHash",
  "officialText",
  "effectiveHash",
  "effectiveText",
  "targetPattern",
  "sourceTargetId",
  "readOnlyReason",
  "overrideStrategy",
  "overrideConflict",
  "source",
  "securityClass",
];
const CATALOG_OVERRIDE_CONFLICT_KEYS = ["code", "message", "sourceTargetId"];
const CATALOG_KINDS = new Set([
  "model_base",
  "developer",
  "compact",
  "collaboration",
  "protected",
  "server_owned",
]);
const CATALOG_RUNTIME_STATUSES = new Set([
  "active",
  "available_local_only",
  "bundled",
  "cached",
  "catalogued",
  "configured",
  "selectable",
  "dormant",
  "override_conflict",
  "pattern",
  "shadowed_by_explicit_config",
  "shadowed_by_session_history",
  "personality_dependent",
  "protected",
  "server_owned",
]);
const CATALOG_SECURITY_CLASSES = new Set([
  "local_user_editable",
  "dormant",
  "advanced_pattern",
  "config_shadowed",
  "session_history",
  "dynamic_assembly",
  "enforcement_coupled",
  "security_critical",
  "contract_coupled",
  "state_assembled",
  "protocol_coupled",
  "privacy_sensitive",
  "dynamic_capability",
  "authority_sensitive",
  "runtime_generated",
  "lifecycle_managed",
  "history_semantics",
  "executable_contract",
  "configurable_elsewhere",
  "client_owned",
  "server_owned",
]);
const CATALOG_OVERRIDE_CONFLICT_CODES = new Set([
  "official_hash_mismatch",
  "strategy_mismatch",
  "patch_anchor_mismatch",
  "effective_prompt_too_large",
  "target_became_personality_dependent",
]);
const EDITABLE_KINDS = new Set([
  "model_base",
  "developer",
  "compact",
  "collaboration",
]);
const EDITABLE_RUNTIME_STATUSES = new Set([
  "active",
  "available_local_only",
  "bundled",
  "cached",
  "catalogued",
  "configured",
  "selectable",
  "override_conflict",
]);
const PROTECTED_SECURITY_CLASSES = new Set([
  "enforcement_coupled",
  "security_critical",
  "contract_coupled",
  "state_assembled",
  "protocol_coupled",
  "privacy_sensitive",
  "dynamic_capability",
  "authority_sensitive",
  "runtime_generated",
  "lifecycle_managed",
  "history_semantics",
  "executable_contract",
  "configurable_elsewhere",
  "client_owned",
]);
function promptCenterError(message, statusCode = 400, code = "codex_prompt_request_failed", details = undefined) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function assertExactObjectShape(value, expectedKeys, label, {
  statusCode = 503,
  code = "codex_prompt_invalid_catalog",
  optionalKeys = [],
} = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw promptCenterError(`${label} must be an object`, statusCode, code);
  }
  const keys = Object.keys(value);
  const missing = expectedKeys.filter((key) => !Object.hasOwn(value, key));
  const allowed = new Set([...expectedKeys, ...optionalKeys]);
  const unknown = keys.filter((key) => !allowed.has(key));
  if (missing.length || unknown.length) {
    throw promptCenterError(
      `${label} has an invalid shape`
        + (missing.length ? `; missing: ${missing.join(", ")}` : "")
        + (unknown.length ? `; unsupported: ${unknown.join(", ")}` : ""),
      statusCode,
      code,
    );
  }
}

function sha256(value) {
  const hash = createHash("sha256");
  if (Buffer.isBuffer(value)) hash.update(value);
  else hash.update(String(value), "utf8");
  return `sha256:${hash.digest("hex")}`;
}

function isSha256(value) {
  return /^sha256:[0-9a-f]{64}$/.test(String(value || ""));
}

function isDarwinProcessStartIdentity(value) {
  return DARWIN_PROCESS_START_IDENTITY.test(String(value || ""));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hasLoneUtf16Surrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function assertUnicodeScalarStrings(value, label, {
  statusCode = 422,
  code = "codex_prompt_invalid_unicode",
} = {}) {
  if (typeof value === "string") {
    if (hasLoneUtf16Surrogate(value)) {
      throw promptCenterError(
        `${label} contains an unpaired UTF-16 surrogate`,
        statusCode,
        code,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => assertUnicodeScalarStrings(item, label, { statusCode, code }));
    return;
  }
  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => {
      assertUnicodeScalarStrings(key, label, { statusCode, code });
      assertUnicodeScalarStrings(item, label, { statusCode, code });
    });
  }
}

function byteLength(value) {
  return Buffer.byteLength(String(value), "utf8");
}

export function estimateCodexPromptTokens(value) {
  return Math.ceil(byteLength(value) / 4);
}

function canonicalCatalogTarget(rawTarget = {}) {
  return {
    id: rawTarget.id,
    label: rawTarget.label,
    kind: rawTarget.kind,
    editable: rawTarget.editable,
    runtimeStatus: rawTarget.runtimeStatus,
    officialHash: rawTarget.officialHash,
    officialText: rawTarget.officialText,
    effectiveHash: rawTarget.effectiveHash,
    effectiveText: rawTarget.effectiveText,
    targetPattern: rawTarget.targetPattern,
    sourceTargetId: rawTarget.sourceTargetId,
    readOnlyReason: rawTarget.readOnlyReason,
    overrideStrategy: rawTarget.overrideStrategy,
    overrideConflict: rawTarget.overrideConflict === null || rawTarget.overrideConflict === undefined
      ? rawTarget.overrideConflict
      : {
        code: rawTarget.overrideConflict.code,
        message: rawTarget.overrideConflict.message,
        sourceTargetId: rawTarget.overrideConflict.sourceTargetId,
      },
    source: rawTarget.source,
    securityClass: rawTarget.securityClass,
  };
}

export function computeCodexPromptCatalogRevision(rawCatalog) {
  if (!rawCatalog || typeof rawCatalog !== "object" || Array.isArray(rawCatalog)) return "";
  const canonical = {
    schemaVersion: rawCatalog.schemaVersion,
    runtimeVersion: rawCatalog.runtimeVersion,
    catalogRevision: "",
    groups: Array.isArray(rawCatalog.groups)
      ? rawCatalog.groups.map((group) => ({
        id: group?.id,
        label: group?.label,
        targets: Array.isArray(group?.targets)
          ? group.targets.map(canonicalCatalogTarget)
          : group?.targets,
      }))
      : rawCatalog.groups,
  };
  return sha256(JSON.stringify(canonical));
}

function serializePromptState(value) {
  assertUnicodeScalarStrings(value, "Codex prompt state");
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assertPromptSize(value, label = "Prompt") {
  const size = byteLength(value);
  if (size > MAX_CODEX_PROMPT_BYTES) {
    throw promptCenterError(
      `${label} exceeds the ${MAX_CODEX_PROMPT_BYTES}-byte limit`,
      413,
      "codex_prompt_too_large",
      { maxBytes: MAX_CODEX_PROMPT_BYTES, actualBytes: size },
    );
  }
  const estimatedTokens = estimateCodexPromptTokens(value);
  if (estimatedTokens > MAX_CODEX_PROMPT_ESTIMATED_TOKENS) {
    throw promptCenterError(
      `${label} is estimated at ${estimatedTokens} tokens, exceeding the ${MAX_CODEX_PROMPT_ESTIMATED_TOKENS}-token limit`,
      413,
      "codex_prompt_too_many_estimated_tokens",
      {
        maxEstimatedTokens: MAX_CODEX_PROMPT_ESTIMATED_TOKENS,
        estimatedTokens,
      },
    );
  }
}

function normalizePrompt(value, label) {
  if (typeof value !== "string") {
    throw promptCenterError(`${label} must be text`, 422, "codex_prompt_invalid_catalog");
  }
  assertUnicodeScalarStrings(value, label);
  assertPromptSize(value, label);
  return value;
}

function readBoundedFileDescriptor(descriptor, maxBytes) {
  const chunks = [];
  let totalBytes = 0;
  while (totalBytes <= maxBytes) {
    const remaining = maxBytes + 1 - totalBytes;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1_024, remaining));
    const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    totalBytes += bytesRead;
  }
  return {
    bytes: Buffer.concat(chunks, totalBytes),
    tooLarge: totalBytes > maxBytes,
  };
}

function readJsonFile(filePath, {
  required = true,
  maxBytes = MAX_CODEX_PROMPT_MANIFEST_BYTES,
  includeBytes = false,
  requiredMode = null,
} = {}) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, SECURE_READ_FLAGS);
  } catch (error) {
    if (!required && error.code === "ENOENT") return null;
    if (error.code === "ENOENT") {
      throw promptCenterError(
        `Codex prompt data is unavailable: ${path.basename(filePath)} was not found`,
        503,
        "codex_prompt_data_unavailable",
      );
    }
    if (["ELOOP", "EMLINK"].includes(error.code)) {
      throw promptCenterError("Codex prompt storage must not contain symbolic links", 409, "codex_prompt_symlink_refused");
    }
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) {
      throw promptCenterError(`Codex prompt data is not a regular file: ${path.basename(filePath)}`, 409, "codex_prompt_storage_invalid");
    }
    if (requiredMode !== null && (stat.mode & 0o777) !== requiredMode) {
      throw promptCenterError(
        `Codex prompt data must use mode 0${requiredMode.toString(8)}: ${path.basename(filePath)}`,
        409,
        "codex_prompt_storage_permissions_invalid",
      );
    }
    if (stat.size > maxBytes) {
      throw promptCenterError(
        `Codex prompt data exceeds the ${Math.floor(maxBytes / 1_048_576)} MiB file limit`,
        413,
        "codex_prompt_data_too_large",
      );
    }
    const { bytes, tooLarge } = readBoundedFileDescriptor(descriptor, maxBytes);
    if (tooLarge) {
      throw promptCenterError(
        `Codex prompt data exceeds the ${Math.floor(maxBytes / 1_048_576)} MiB file limit`,
        413,
        "codex_prompt_data_too_large",
      );
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw promptCenterError(
        `Codex prompt data is not valid UTF-8: ${path.basename(filePath)}`,
        503,
        "codex_prompt_data_invalid",
        { cause: error.message },
      );
    }
    const value = JSON.parse(text);
    return includeBytes ? { value, bytes, stat } : value;
  } catch (error) {
    if (typeof error?.code === "string" && error.code.startsWith("codex_prompt_")) throw error;
    throw promptCenterError(
      `Codex prompt data is invalid JSON: ${path.basename(filePath)}`,
      503,
      "codex_prompt_data_invalid",
      { cause: error.message },
    );
  } finally {
    fs.closeSync(descriptor);
  }
}

function pathIsWithin(anchorPath, targetPath) {
  const relative = path.relative(anchorPath, targetPath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function promptStorageTrustAnchor(targetPath) {
  const resolved = path.resolve(targetPath);
  const trusted = [os.homedir(), os.tmpdir()]
    .map((candidate) => path.resolve(candidate))
    .filter((candidate) => pathIsWithin(candidate, resolved))
    .sort((left, right) => right.length - left.length);
  return trusted[0] || path.parse(resolved).root;
}

function existingPathSegments(targetPath) {
  const resolved = path.resolve(targetPath);
  const anchor = promptStorageTrustAnchor(resolved);
  const relative = path.relative(anchor, resolved);
  const segments = relative ? relative.split(path.sep).filter(Boolean) : [];
  const paths = [anchor];
  let current = anchor;
  for (const segment of segments) {
    current = path.join(current, segment);
    paths.push(current);
  }
  return paths;
}

export function assertNoPromptStorageSymlinks(targetPath) {
  const candidates = existingPathSegments(targetPath);
  for (const candidate of candidates) {
    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw promptCenterError(
        `Codex prompt storage refuses symbolic links: ${candidate}`,
        409,
        "codex_prompt_symlink_refused",
      );
    }
  }
}

function ensurePrivateDirectory(directoryPath) {
  assertNoPromptStorageSymlinks(directoryPath);
  fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  assertNoPromptStorageSymlinks(directoryPath);
  const stat = fs.lstatSync(directoryPath);
  if (!stat.isDirectory()) {
    throw promptCenterError("Codex prompt storage root is not a directory", 409, "codex_prompt_storage_invalid");
  }
  fs.chmodSync(directoryPath, 0o700);
}

function assertPrivateDirectory(directoryPath, label, { required = true } = {}) {
  let stat;
  try {
    stat = fs.lstatSync(directoryPath);
  } catch (error) {
    if (!required && error.code === "ENOENT") return false;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw promptCenterError(`${label} must be a regular directory`, 409, "codex_prompt_storage_invalid");
  }
  if ((stat.mode & 0o777) !== 0o700) {
    throw promptCenterError(`${label} must use mode 0700`, 409, "codex_prompt_storage_permissions_invalid");
  }
  return true;
}

export function secureAtomicWritePromptState(filePath, value) {
  const directoryPath = path.dirname(filePath);
  ensurePrivateDirectory(directoryPath);
  assertNoPromptStorageSymlinks(filePath);
  if (fs.existsSync(filePath) && !fs.lstatSync(filePath).isFile()) {
    throw promptCenterError("Codex prompt state target is not a regular file", 409, "codex_prompt_storage_invalid");
  }
  const serialized = serializePromptState(value);
  const serializedBytes = byteLength(serialized);
  if (serializedBytes > MAX_CODEX_PROMPT_MANIFEST_BYTES) {
    throw promptCenterError(
      "Codex prompt state exceeds the 16 MiB runtime manifest limit",
      413,
      "codex_prompt_manifest_too_large",
      { maxBytes: MAX_CODEX_PROMPT_MANIFEST_BYTES, actualBytes: serializedBytes },
    );
  }
  const temporaryPath = path.join(
    directoryPath,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor;
  let writeError = null;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, serialized, "utf8");
    fs.fsyncSync(descriptor);
  } catch (error) {
    writeError = error;
  }
  if (descriptor !== undefined) {
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      if (!writeError) writeError = error;
    }
  }
  if (writeError) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") {
        writeError.cleanupWarning = `Temporary prompt state cleanup failed: ${cleanupError.message}`;
      }
    }
    throw writeError;
  }
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") {
        error.cleanupWarning = `Temporary prompt state cleanup failed: ${cleanupError.message}`;
      }
    }
    throw error;
  }

  const warnings = [];
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    warnings.push(`Prompt state committed, but permission finalization failed: ${error.message}`);
  }
  let directoryDescriptor;
  try {
    directoryDescriptor = fs.openSync(directoryPath, "r");
    fs.fsyncSync(directoryDescriptor);
  } catch (error) {
    warnings.push(`Prompt state committed, but directory durability sync failed: ${error.message}`);
  }
  if (directoryDescriptor !== undefined) {
    try {
      fs.closeSync(directoryDescriptor);
    } catch (error) {
      warnings.push(`Prompt state committed, but directory handle cleanup failed: ${error.message}`);
    }
  }
  return {
    filePath,
    committed: true,
    commitWarning: warnings.join(" "),
  };
}

function promptWriteLockIdentity(stat) {
  return `${String(stat.dev)}-${String(stat.ino)}`;
}

function readPromptWriteLockRecord(recordPath, label) {
  let descriptor;
  try {
    descriptor = fs.openSync(recordPath, SECURE_READ_FLAGS);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (["ELOOP", "EMLINK"].includes(error.code)) {
      throw promptCenterError(`${label} is invalid`, 409, "codex_prompt_symlink_refused");
    }
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > WRITE_LOCK_RECORD_MAX_BYTES) {
      throw promptCenterError(`${label} is invalid`, 409, "codex_prompt_storage_invalid");
    }
    let record = null;
    try {
      const { bytes, tooLarge } = readBoundedFileDescriptor(descriptor, WRITE_LOCK_RECORD_MAX_BYTES);
      if (tooLarge) throw new SyntaxError("write-lock record is too large");
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (
        parsed
        && typeof parsed === "object"
        && !Array.isArray(parsed)
        && Object.keys(parsed).length === 3
        && Number.isSafeInteger(parsed.pid)
        && parsed.pid > 0
        && typeof parsed.token === "string"
        && /^[0-9a-f]{32}$/.test(parsed.token)
        && (
          parsed.processStartedAtUnixMs === null
          || (Number.isSafeInteger(parsed.processStartedAtUnixMs) && parsed.processStartedAtUnixMs >= 0)
        )
      ) {
        record = {
          pid: parsed.pid,
          token: parsed.token,
          processStartedAtUnixMs: parsed.processStartedAtUnixMs,
        };
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && error?.code !== "ERR_ENCODING_INVALID_ENCODED_DATA") throw error;
    }
    return {
      ...record,
      pid: record?.pid || 0,
      token: record?.token || "",
      processStartedAtUnixMs: record?.processStartedAtUnixMs ?? null,
      dev: stat.dev,
      ino: stat.ino,
      mtimeMs: stat.mtimeMs,
      ageMs: Math.max(0, Date.now() - stat.mtimeMs),
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function readPromptWriteLock(lockPath) {
  let stat;
  try {
    stat = fs.lstatSync(lockPath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw promptCenterError("Codex prompt write lock is not a regular directory", 409, "codex_prompt_symlink_refused");
  }
  if ((stat.mode & 0o777) !== 0o700) {
    throw promptCenterError("Codex prompt write lock must use mode 0700", 409, "codex_prompt_storage_permissions_invalid");
  }
  const ownerPath = path.join(lockPath, WRITE_LOCK_OWNER_FILE);
  const owner = readPromptWriteLockRecord(ownerPath, "Codex prompt write lock owner");
  return {
    ...owner,
    pid: owner?.pid || 0,
    token: owner?.token || "",
    processStartedAtUnixMs: owner?.processStartedAtUnixMs ?? null,
    ownerDev: owner?.dev ?? null,
    ownerIno: owner?.ino ?? null,
    reclaim: readPromptWriteLockRecord(
      path.join(lockPath, WRITE_LOCK_RECLAIM_FILE),
      "Codex prompt write-lock reclaim claim",
    ),
    dev: stat.dev,
    ino: stat.ino,
    identity: promptWriteLockIdentity(stat),
    ageMs: Math.max(0, Date.now() - stat.mtimeMs),
  };
}

function promptWriteLockRecordIsLiveOrFresh(record, isPidAlive, getProcessStartUnixMs, {
  ageMs = Number.isFinite(record?.mtimeMs)
    ? Math.max(0, Date.now() - record.mtimeMs)
    : record?.ageMs ?? Number.POSITIVE_INFINITY,
} = {}) {
  if (!record) return false;
  const ownerAlive = Boolean(record.pid && isPidAlive(record.pid));
  let currentProcessStartedAtUnixMs = null;
  if (ownerAlive) {
    try {
      currentProcessStartedAtUnixMs = getProcessStartUnixMs(record.pid);
    } catch {}
  }
  const hasVerifiedCurrentProcessStart = Boolean(
    Number.isSafeInteger(currentProcessStartedAtUnixMs)
    && currentProcessStartedAtUnixMs >= 0
  );
  if (ownerAlive && !hasVerifiedCurrentProcessStart) return true;
  const verifiedLiveOwner = Boolean(
    ownerAlive
    && record.processStartedAtUnixMs !== null
    && currentProcessStartedAtUnixMs === record.processStartedAtUnixMs
  );
  const legacyLiveOwner = Boolean(
    ownerAlive
    && record.processStartedAtUnixMs === null
    && Number.isFinite(record.mtimeMs)
    && currentProcessStartedAtUnixMs <= record.mtimeMs + WRITE_LOCK_PROCESS_START_FS_TOLERANCE_MS
  );
  const incompleteAndFresh = Boolean(
    ageMs < INCOMPLETE_WRITE_LOCK_GRACE_MS
    && (
      !record.pid
      || record.processStartedAtUnixMs === null
    )
  );
  return verifiedLiveOwner || legacyLiveOwner || incompleteAndFresh;
}

function promptWriteLockIdentityMatches(left, right) {
  return Boolean(
    left
    && right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.ownerDev === right.ownerDev
    && left.ownerIno === right.ownerIno
    && left.pid === right.pid
    && left.token === right.token
    && left.processStartedAtUnixMs === right.processStartedAtUnixMs
  );
}

function removePromptWriteLockRecordIfOwned(handle) {
  try {
    const stat = fs.lstatSync(handle.path);
    if (stat.dev !== handle.dev || stat.ino !== handle.ino) return false;
    fs.unlinkSync(handle.path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function promptWriteLockDirectoryIdentityMatches(lockPath, expected) {
  try {
    const stat = fs.lstatSync(lockPath);
    return Boolean(
      stat.isDirectory()
      && !stat.isSymbolicLink()
      && stat.dev === expected.dev
      && stat.ino === expected.ino
    );
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function preparePromptWriteLockRecord(lockPath, recordName, record) {
  const temporaryName = `${recordName}.tmp.${process.pid}.${randomBytes(16).toString("hex")}`;
  const temporaryPath = path.join(lockPath, temporaryName);
  let descriptor;
  let temporary = null;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    const stat = fs.fstatSync(descriptor);
    temporary = {
      path: temporaryPath,
      dev: stat.dev,
      ino: stat.ino,
    };
    fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    return temporary;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {}
    }
    if (temporary) {
      try {
        removePromptWriteLockRecordIfOwned(temporary);
      } catch (cleanupError) {
        error.cleanupWarning = combinePromptWarnings(
          error.cleanupWarning,
          `Temporary write-lock record cleanup failed: ${cleanupError.message}`,
        );
      }
    }
    throw error;
  }
}

function retirePromptWriteLockGeneration(lockPath) {
  const retiredPath = `${lockPath}.retired.${process.pid}.${randomBytes(16).toString("hex")}`;
  fs.renameSync(lockPath, retiredPath);
  return retiredPath;
}

function cleanupRetiredPromptWriteLock(retiredPath, expectedOwner, expectedReclaim) {
  const retired = readPromptWriteLock(retiredPath);
  if (
    !promptWriteLockIdentityMatches(expectedOwner, retired)
    || retired.reclaim?.dev !== expectedReclaim.dev
    || retired.reclaim?.ino !== expectedReclaim.ino
  ) {
    throw promptCenterError(
      "Codex prompt write lock changed generation during cleanup",
      409,
      "codex_prompt_write_in_progress",
    );
  }
  if (retired.ownerDev !== null && retired.ownerIno !== null) {
    const ownerRemoved = removePromptWriteLockRecordIfOwned({
      path: path.join(retiredPath, WRITE_LOCK_OWNER_FILE),
      dev: retired.ownerDev,
      ino: retired.ownerIno,
    });
    if (!ownerRemoved) {
      throw promptCenterError(
        "Codex prompt write-lock owner changed during cleanup",
        409,
        "codex_prompt_write_in_progress",
      );
    }
  }
  const reclaimRemoved = removePromptWriteLockRecordIfOwned({
    path: path.join(retiredPath, WRITE_LOCK_RECLAIM_FILE),
    dev: retired.reclaim.dev,
    ino: retired.reclaim.ino,
  });
  if (!reclaimRemoved) {
    throw promptCenterError(
      "Codex prompt write-lock reclaim claim changed during cleanup",
      409,
      "codex_prompt_write_in_progress",
    );
  }
  fs.rmdirSync(retiredPath);
}

function createPromptWriteReclaim(lockPath, expectedOwner, getProcessStartUnixMs) {
  const reclaimPath = path.join(lockPath, WRITE_LOCK_RECLAIM_FILE);
  const token = randomBytes(16).toString("hex");
  const initial = readPromptWriteLock(lockPath);
  if (
    !promptWriteLockIdentityMatches(expectedOwner, initial)
    || initial.reclaim
  ) {
    throw promptCenterError(
      "Codex prompt write lock changed generation before reclaim publication",
      409,
      "codex_prompt_write_in_progress",
    );
  }
  let processStartedAtUnixMs = null;
  try {
    const value = getProcessStartUnixMs(process.pid);
    if (Number.isSafeInteger(value) && value >= 0) processStartedAtUnixMs = value;
  } catch {}
  const temporary = preparePromptWriteLockRecord(
    lockPath,
    WRITE_LOCK_RECLAIM_FILE,
    { pid: process.pid, token, processStartedAtUnixMs },
  );
  let published = false;
  try {
    const beforePublication = readPromptWriteLock(lockPath);
    if (
      !promptWriteLockIdentityMatches(expectedOwner, beforePublication)
      || beforePublication.reclaim
    ) {
      throw promptCenterError(
        "Codex prompt write lock changed generation before reclaim publication",
        409,
        "codex_prompt_write_in_progress",
      );
    }
    fs.linkSync(temporary.path, reclaimPath);
    published = true;
    const afterPublication = readPromptWriteLock(lockPath);
    if (
      !promptWriteLockIdentityMatches(expectedOwner, afterPublication)
      || afterPublication.reclaim?.dev !== temporary.dev
      || afterPublication.reclaim?.ino !== temporary.ino
      || afterPublication.reclaim?.token !== token
      || afterPublication.reclaim?.pid !== process.pid
      || afterPublication.reclaim?.processStartedAtUnixMs !== processStartedAtUnixMs
    ) {
      throw promptCenterError(
        "Codex prompt write lock changed generation during reclaim publication",
        409,
        "codex_prompt_write_in_progress",
      );
    }
    removePromptWriteLockRecordIfOwned(temporary);
    return { path: reclaimPath, dev: temporary.dev, ino: temporary.ino };
  } catch (error) {
    if (published) {
      try {
        removePromptWriteLockRecordIfOwned({
          path: reclaimPath,
          dev: temporary.dev,
          ino: temporary.ino,
        });
      } catch (cleanupError) {
        error.cleanupWarning = combinePromptWarnings(
          error.cleanupWarning,
          `Published write-lock reclaim cleanup failed: ${cleanupError.message}`,
        );
      }
    }
    try {
      removePromptWriteLockRecordIfOwned(temporary);
    } catch (cleanupError) {
      error.cleanupWarning = combinePromptWarnings(
        error.cleanupWarning,
        `Temporary write-lock reclaim cleanup failed: ${cleanupError.message}`,
      );
    }
    throw error;
  }
}

function reclaimStalePromptWriteLock(lockPath, expectedOwner, isPidAlive, getProcessStartUnixMs) {
  if (expectedOwner.reclaim) {
    if (promptWriteLockRecordIsLiveOrFresh(
      expectedOwner.reclaim,
      isPidAlive,
      getProcessStartUnixMs,
    )) {
      throw promptCenterError(
        "Another Context Room is reclaiming Codex prompt storage. Retry after it finishes.",
        409,
        "codex_prompt_write_in_progress",
      );
    }
    const current = readPromptWriteLock(lockPath);
    if (
      !current
      || current.dev !== expectedOwner.dev
      || current.ino !== expectedOwner.ino
      || current.reclaim?.dev !== expectedOwner.reclaim.dev
      || current.reclaim?.ino !== expectedOwner.reclaim.ino
    ) {
      return false;
    }
    removePromptWriteLockRecordIfOwned({
      path: path.join(lockPath, WRITE_LOCK_RECLAIM_FILE),
      dev: expectedOwner.reclaim.dev,
      ino: expectedOwner.reclaim.ino,
    });
    return false;
  }

  let reclaim;
  let retiredPath = null;
  try {
    reclaim = createPromptWriteReclaim(lockPath, expectedOwner, getProcessStartUnixMs);
  } catch (error) {
    if (["ENOENT", "EEXIST"].includes(error.code)) return false;
    throw error;
  }
  try {
    const claimed = readPromptWriteLock(lockPath);
    if (!promptWriteLockIdentityMatches(expectedOwner, claimed)) return false;
    if (claimed.reclaim?.dev !== reclaim.dev || claimed.reclaim?.ino !== reclaim.ino) return false;
    retiredPath = retirePromptWriteLockGeneration(lockPath);
    cleanupRetiredPromptWriteLock(retiredPath, claimed, reclaim);
    return true;
  } finally {
    if (!retiredPath) removePromptWriteLockRecordIfOwned(reclaim);
  }
}

function acquirePromptWriteLock(storageRoot, isPidAlive, getProcessStartUnixMs) {
  ensurePrivateDirectory(storageRoot);
  const lockPath = path.join(storageRoot, WRITE_LOCK_FILE);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const token = randomBytes(16).toString("hex");
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = readPromptWriteLock(lockPath);
      if (owner?.reclaim) {
        reclaimStalePromptWriteLock(lockPath, owner, isPidAlive, getProcessStartUnixMs);
        continue;
      }
      if (promptWriteLockRecordIsLiveOrFresh(owner, isPidAlive, getProcessStartUnixMs)) {
        throw promptCenterError(
          "Another Context Room is saving Codex prompts. Retry after it finishes.",
          409,
          "codex_prompt_write_in_progress",
        );
      }
      if (!owner) continue;
      reclaimStalePromptWriteLock(lockPath, owner, isPidAlive, getProcessStartUnixMs);
      continue;
    }

    const ownerPath = path.join(lockPath, WRITE_LOCK_OWNER_FILE);
    const lockStat = fs.lstatSync(lockPath);
    try {
      let processStartedAtUnixMs = null;
      try {
        const value = getProcessStartUnixMs(process.pid);
        if (Number.isSafeInteger(value) && value >= 0) processStartedAtUnixMs = value;
      } catch {}
      const temporary = preparePromptWriteLockRecord(
        lockPath,
        WRITE_LOCK_OWNER_FILE,
        { pid: process.pid, token, processStartedAtUnixMs },
      );
      try {
        if (!promptWriteLockDirectoryIdentityMatches(lockPath, lockStat)) {
          throw promptCenterError(
            "Codex prompt write lock changed generation before owner publication",
            409,
            "codex_prompt_write_in_progress",
          );
        }
        fs.renameSync(temporary.path, ownerPath);
      } catch (error) {
        try {
          removePromptWriteLockRecordIfOwned(temporary);
        } catch (cleanupError) {
          error.cleanupWarning = combinePromptWarnings(
            error.cleanupWarning,
            `Temporary write-lock owner cleanup failed: ${cleanupError.message}`,
          );
        }
        throw error;
      }
      const stat = fs.lstatSync(lockPath);
      const published = readPromptWriteLock(lockPath);
      if (
        stat.dev !== lockStat.dev
        || stat.ino !== lockStat.ino
        || published?.dev !== lockStat.dev
        || published?.ino !== lockStat.ino
        || published?.ownerDev !== temporary.dev
        || published?.ownerIno !== temporary.ino
        || published?.pid !== process.pid
        || published?.token !== token
        || published?.processStartedAtUnixMs !== processStartedAtUnixMs
      ) {
        throw promptCenterError(
          "Codex prompt write lock changed generation during acquisition",
          409,
          "codex_prompt_write_in_progress",
        );
      }
      return {
        lockPath,
        ownerPath,
        token,
        dev: stat.dev,
        ino: stat.ino,
      };
    } catch (error) {
      // Leave a partially initialized generation in place. Removing the
      // canonical path here cannot be atomically bound to the directory
      // generation created above, so an interleaved successor could otherwise
      // be deleted. The normal stale-lock protocol reclaims this generation
      // after its incomplete-lock grace period.
      throw error;
    }
  }
  throw promptCenterError(
    "Codex prompt storage could not acquire its private write lock",
    409,
    "codex_prompt_write_in_progress",
  );
}

function combinePromptWarnings(...warnings) {
  return warnings.flat().filter(Boolean).join(" ");
}

function releasePromptWriteLock(handle, getProcessStartUnixMs) {
  let reclaim = null;
  let retiredPath = null;
  try {
    const current = readPromptWriteLock(handle.lockPath);
    if (
      !current
      || current.reclaim
      || current.dev !== handle.dev
      || current.ino !== handle.ino
      || current.token !== handle.token
    ) {
      return "Codex prompt save finished, but its write lock changed generation before cleanup.";
    }
    try {
      reclaim = createPromptWriteReclaim(handle.lockPath, current, getProcessStartUnixMs);
    } catch (error) {
      if (["ENOENT", "EEXIST"].includes(error.code)) {
        return "Codex prompt save finished, but its write lock changed generation before cleanup.";
      }
      throw error;
    }
    const claimed = readPromptWriteLock(handle.lockPath);
    if (
      !promptWriteLockIdentityMatches(current, claimed)
      || claimed.reclaim?.dev !== reclaim.dev
      || claimed.reclaim?.ino !== reclaim.ino
    ) {
      return "Codex prompt save finished, but its write lock changed generation before cleanup.";
    }
    retiredPath = retirePromptWriteLockGeneration(handle.lockPath);
    cleanupRetiredPromptWriteLock(retiredPath, claimed, reclaim);
    return "";
  } catch (error) {
    if (error.code === "ENOENT" && !retiredPath) return "";
    return `Codex prompt save finished, but write lock cleanup failed: ${error.message}`;
  } finally {
    if (reclaim && !retiredPath) removePromptWriteLockRecordIfOwned(reclaim);
  }
}

function withPromptWriteLock(storageRoot, isPidAlive, getProcessStartUnixMs, action) {
  const handle = acquirePromptWriteLock(storageRoot, isPidAlive, getProcessStartUnixMs);
  let result;
  let actionError = null;
  try {
    result = action();
  } catch (error) {
    actionError = error;
  }
  const cleanupWarning = releasePromptWriteLock(handle, getProcessStartUnixMs);
  if (actionError) {
    if (cleanupWarning) actionError.cleanupWarning = combinePromptWarnings(actionError.cleanupWarning, cleanupWarning);
    throw actionError;
  }
  if (cleanupWarning && result && typeof result === "object" && !Array.isArray(result)) {
    return {
      ...result,
      commitWarning: combinePromptWarnings(result.commitWarning, cleanupWarning),
    };
  }
  return result;
}

function normalizeCatalogOverrideConflict(rawConflict, targetId) {
  if (rawConflict === null) return null;
  assertExactObjectShape(
    rawConflict,
    CATALOG_OVERRIDE_CONFLICT_KEYS,
    `Override conflict for ${targetId}`,
  );
  if (
    typeof rawConflict.code !== "string"
    || typeof rawConflict.message !== "string"
    || typeof rawConflict.sourceTargetId !== "string"
    || !CATALOG_OVERRIDE_CONFLICT_CODES.has(rawConflict.code)
    || !rawConflict.message
    || !rawConflict.sourceTargetId
  ) {
    throw promptCenterError(
      `Override conflict is incomplete for ${targetId}`,
      503,
      "codex_prompt_invalid_catalog",
    );
  }
  return {
    code: rawConflict.code,
    message: rawConflict.message,
    sourceTargetId: rawConflict.sourceTargetId,
  };
}

function normalizeCatalogTarget(rawTarget, group) {
  assertExactObjectShape(rawTarget, CATALOG_TARGET_KEYS, "Codex prompt target");
  for (const [key, label] of [
    ["id", "id"],
    ["label", "label"],
    ["kind", "kind"],
    ["runtimeStatus", "runtimeStatus"],
    ["source", "source"],
    ["securityClass", "securityClass"],
  ]) {
    if (typeof rawTarget[key] !== "string" || (["id", "label"].includes(key) && !rawTarget[key])) {
      throw promptCenterError(
        `Codex prompt target ${label} must be ${["id", "label"].includes(key) ? "non-empty " : ""}text`,
        503,
        "codex_prompt_invalid_catalog",
      );
    }
  }
  if (typeof rawTarget.editable !== "boolean") {
    throw promptCenterError("Codex prompt target editable must be a boolean", 503, "codex_prompt_invalid_catalog");
  }
  if (
    !CATALOG_KINDS.has(rawTarget.kind)
    || !CATALOG_RUNTIME_STATUSES.has(rawTarget.runtimeStatus)
    || !CATALOG_SECURITY_CLASSES.has(rawTarget.securityClass)
  ) {
    throw promptCenterError(
      `Codex prompt target enum value is unsupported for ${rawTarget.id}`,
      503,
      "codex_prompt_invalid_catalog",
    );
  }
  for (const key of [
    "officialHash",
    "officialText",
    "effectiveHash",
    "effectiveText",
    "targetPattern",
    "sourceTargetId",
    "readOnlyReason",
    "overrideStrategy",
  ]) {
    if (rawTarget[key] !== null && typeof rawTarget[key] !== "string") {
      throw promptCenterError(
        `Codex prompt target ${key} must be text or null`,
        503,
        "codex_prompt_invalid_catalog",
      );
    }
  }

  const id = rawTarget.id;
  const hasOfficialContent = rawTarget.officialText !== null;
  const official = hasOfficialContent
    ? normalizePrompt(rawTarget.officialText, `Official prompt ${id}`)
    : null;
  const runtimeEffectiveText = rawTarget.effectiveText === null
    ? null
    : normalizePrompt(rawTarget.effectiveText, `Runtime effective prompt ${id}`);
  const runtimeEffectiveHash = rawTarget.effectiveHash;
  if ((rawTarget.officialText === null) !== (rawTarget.officialHash === null)) {
    throw promptCenterError(
      `Official prompt text and hash presence do not match for ${id}`,
      503,
      "codex_prompt_invalid_catalog",
    );
  }
  if ((rawTarget.effectiveText === null) !== (rawTarget.effectiveHash === null)) {
    throw promptCenterError(
      `Effective prompt text and hash presence do not match for ${id}`,
      503,
      "codex_prompt_invalid_catalog",
    );
  }
  if (runtimeEffectiveHash !== null && !isSha256(runtimeEffectiveHash)) {
    throw promptCenterError(`Effective hash is invalid for ${id}`, 503, "codex_prompt_invalid_catalog");
  }
  if (
    runtimeEffectiveText !== null
    && runtimeEffectiveHash !== null
    && runtimeEffectiveHash !== sha256(runtimeEffectiveText)
  ) {
    throw promptCenterError(
      `Effective hash does not match the catalog content for ${id}`,
      503,
      "codex_prompt_invalid_catalog",
    );
  }
  const officialHash = rawTarget.officialHash;
  if (officialHash !== null && !isSha256(officialHash)) {
    throw promptCenterError(`Official hash is invalid for ${id}`, 503, "codex_prompt_invalid_catalog");
  }
  if (hasOfficialContent && officialHash !== null && officialHash !== sha256(official)) {
    throw promptCenterError(
      `Official hash does not match the catalog content for ${id}`,
      503,
      "codex_prompt_invalid_catalog",
    );
  }
  const runtimeStatus = rawTarget.runtimeStatus;
  const lifecycle = "";
  const securityClass = rawTarget.securityClass;
  const overrideConflict = normalizeCatalogOverrideConflict(rawTarget.overrideConflict, id);
  if ((runtimeStatus === "override_conflict") !== Boolean(overrideConflict)) {
    throw promptCenterError(
      `Override conflict metadata does not match runtimeStatus for ${id}`,
      503,
      "codex_prompt_invalid_catalog",
    );
  }
  const runtimeEditable = rawTarget.editable;
  const trustedEditableContract = (
    EDITABLE_KINDS.has(rawTarget.kind)
    && securityClass === "local_user_editable"
    && EDITABLE_RUNTIME_STATUSES.has(runtimeStatus)
  );
  if (
    runtimeEditable
    && (
      !trustedEditableContract
      || !hasOfficialContent
      || runtimeEffectiveText === null
      || rawTarget.readOnlyReason !== null
    )
  ) {
    throw promptCenterError(
      `Editable target authority metadata is invalid for ${id}`,
      503,
      "codex_prompt_invalid_catalog",
    );
  }
  if (!runtimeEditable && securityClass === "local_user_editable") {
    throw promptCenterError(
      `Read-only target cannot use local_user_editable security metadata for ${id}`,
      503,
      "codex_prompt_invalid_catalog",
    );
  }
  const editable = runtimeEditable && trustedEditableContract && hasOfficialContent;
  if (editable && officialHash === null) {
    throw promptCenterError(`Editable target ${id} requires an official hash`, 503, "codex_prompt_invalid_catalog");
  }
  const overrideStrategy = rawTarget.overrideStrategy;
  if (overrideStrategy !== null && !["patch", "replacement"].includes(overrideStrategy)) {
    throw promptCenterError(`Override strategy is invalid for ${id}`, 503, "codex_prompt_invalid_catalog");
  }
  if (
    editable
    && overrideStrategy !== (official === "" ? "replacement" : "patch")
  ) {
    throw promptCenterError(
      `Editable target override strategy does not match its official baseline for ${id}`,
      503,
      "codex_prompt_invalid_catalog",
    );
  }
  const sourceTargetId = rawTarget.sourceTargetId;
  if (sourceTargetId !== null && sourceTargetId.length === 0) {
    throw promptCenterError(
      `Codex prompt target sourceTargetId must be non-empty for ${id}`,
      503,
      "codex_prompt_invalid_catalog",
    );
  }
  if (
    editable
    && sourceTargetId === null
    && (
      runtimeEffectiveText !== official
      || runtimeEffectiveHash !== officialHash
    )
  ) {
    throw promptCenterError(
      `Editable target without override provenance must match its official baseline for ${id}`,
      503,
      "codex_prompt_invalid_catalog",
    );
  }
  const modelPatternMetadata = (
    id === "model/base/*"
    || runtimeStatus === "pattern"
    || securityClass === "advanced_pattern"
    || rawTarget.targetPattern !== null
  );
  if (
    modelPatternMetadata
    && (
      id !== "model/base/*"
      || rawTarget.kind !== "model_base"
      || runtimeStatus !== "pattern"
      || runtimeEditable
      || securityClass !== "advanced_pattern"
      || rawTarget.officialHash !== null
      || rawTarget.officialText !== null
      || runtimeEffectiveHash !== null
      || runtimeEffectiveText !== null
      || rawTarget.targetPattern !== "model/base/{modelSlug}"
      || ![null, "model/base/*"].includes(sourceTargetId)
      || !rawTarget.readOnlyReason
      || rawTarget.overrideStrategy !== null
      || overrideConflict !== null
    )
  ) {
    throw promptCenterError(
      `Model prompt pattern metadata is invalid for ${id}`,
      503,
      "codex_prompt_invalid_catalog",
    );
  }
  const protectedMetadata = (
    rawTarget.kind === "protected"
    || runtimeStatus === "protected"
    || PROTECTED_SECURITY_CLASSES.has(securityClass)
  );
  if (
    protectedMetadata
    && (
      rawTarget.kind !== "protected"
      || runtimeStatus !== "protected"
      || runtimeEditable
      || !PROTECTED_SECURITY_CLASSES.has(securityClass)
      || rawTarget.officialHash !== null
      || rawTarget.officialText !== null
      || runtimeEffectiveHash !== null
      || runtimeEffectiveText !== null
      || rawTarget.targetPattern !== null
      || sourceTargetId !== null
      || !rawTarget.readOnlyReason
      || rawTarget.overrideStrategy !== null
      || overrideConflict !== null
    )
  ) {
    throw promptCenterError(
      `Protected prompt metadata is invalid for ${id}`,
      503,
      "codex_prompt_invalid_catalog",
    );
  }
  const serverOwnedMetadata = (
    rawTarget.kind === "server_owned"
    || runtimeStatus === "server_owned"
    || securityClass === "server_owned"
  );
  if (
    serverOwnedMetadata
    && (
      rawTarget.kind !== "server_owned"
      || runtimeStatus !== "server_owned"
      || runtimeEditable
      || securityClass !== "server_owned"
      || rawTarget.officialHash !== null
      || rawTarget.officialText !== null
      || runtimeEffectiveHash !== null
      || runtimeEffectiveText !== null
      || rawTarget.targetPattern !== null
      || sourceTargetId !== null
      || !rawTarget.readOnlyReason
      || rawTarget.overrideStrategy !== null
      || overrideConflict !== null
    )
  ) {
    throw promptCenterError(
      `Server-owned prompt metadata is invalid for ${id}`,
      503,
      "codex_prompt_invalid_catalog",
    );
  }
  if (
    (
      runtimeStatus === "shadowed_by_explicit_config"
      || securityClass === "config_shadowed"
    )
    && (
      runtimeStatus !== "shadowed_by_explicit_config"
      || !["model_base", "developer", "compact"].includes(rawTarget.kind)
      || runtimeEditable
      || securityClass !== "config_shadowed"
      || official === null
      || officialHash === null
      || runtimeEffectiveText === null
      || runtimeEffectiveHash === null
      || rawTarget.targetPattern !== null
      || sourceTargetId !== null
      || rawTarget.overrideStrategy !== null
      || overrideConflict !== null
      || !rawTarget.readOnlyReason
    )
  ) {
    throw promptCenterError(
      `Explicit-config shadow metadata is invalid for ${id}`,
      503,
      "codex_prompt_invalid_catalog",
    );
  }
  if (
    (
      runtimeStatus === "dormant"
      || securityClass === "dormant"
    )
    && (
      runtimeStatus !== "dormant"
      || runtimeEditable
      || securityClass !== "dormant"
      || rawTarget.kind !== "collaboration"
      || rawTarget.targetPattern !== null
      || sourceTargetId !== null
      || rawTarget.overrideStrategy !== null
      || overrideConflict !== null
      || !rawTarget.readOnlyReason
    )
  ) {
    throw promptCenterError(
      `Dormant collaboration metadata is invalid for ${id}`,
      503,
      "codex_prompt_invalid_catalog",
    );
  }
  if (
    (
      runtimeStatus === "shadowed_by_session_history"
      || securityClass === "session_history"
    )
    && (
      runtimeStatus !== "shadowed_by_session_history"
      || runtimeEditable
      || rawTarget.kind !== "model_base"
      || securityClass !== "session_history"
      || official === null
      || officialHash === null
      || rawTarget.targetPattern !== null
      || sourceTargetId !== null
      || rawTarget.overrideStrategy !== null
      || overrideConflict !== null
      || !rawTarget.readOnlyReason
      || runtimeEffectiveText === null
      || runtimeEffectiveHash === null
    )
  ) {
    throw promptCenterError(
      `Session-history shadow metadata is invalid for ${id}`,
      503,
      "codex_prompt_invalid_catalog",
    );
  }
  if (
    runtimeStatus === "personality_dependent"
    && (
      runtimeEditable
      || rawTarget.kind !== "model_base"
      || securityClass !== "dynamic_assembly"
      || official === null
      || officialHash === null
      || rawTarget.targetPattern !== null
      || sourceTargetId !== null
      || rawTarget.overrideStrategy !== null
      || overrideConflict !== null
      || !rawTarget.readOnlyReason
      || runtimeEffectiveText === null
      || runtimeEffectiveHash === null
    )
  ) {
    throw promptCenterError(
      `Personality-dependent target metadata is invalid for ${id}`,
      503,
      "codex_prompt_invalid_catalog",
    );
  }
  if (
    securityClass === "dynamic_assembly"
    && (
      runtimeStatus !== "personality_dependent"
      && overrideConflict?.code !== "target_became_personality_dependent"
    )
  ) {
    throw promptCenterError(
      `Dynamic prompt assembly metadata is invalid for ${id}`,
      503,
      "codex_prompt_invalid_catalog",
    );
  }
  if (
    overrideConflict
    && (
      sourceTargetId !== null
      || runtimeEffectiveText !== official
      || runtimeEffectiveHash !== officialHash
    )
  ) {
    throw promptCenterError(
      `Override conflict fallback is invalid for ${id}`,
      503,
      "codex_prompt_invalid_catalog",
    );
  }
  if (
    overrideConflict
    && !editable
    && (
      runtimeEditable
      || !rawTarget.readOnlyReason
      || overrideStrategy !== null
    )
  ) {
    throw promptCenterError(
      `Read-only override conflict metadata is invalid for ${id}`,
      503,
      "codex_prompt_invalid_catalog",
    );
  }
  if (
    overrideConflict?.code === "target_became_personality_dependent"
    && (
      rawTarget.kind !== "model_base"
      || runtimeEditable
      || securityClass !== "dynamic_assembly"
      || rawTarget.targetPattern !== null
    )
  ) {
    throw promptCenterError(
      `Personality-dependent migration conflict metadata is invalid for ${id}`,
      503,
      "codex_prompt_invalid_catalog",
    );
  }
  const editabilityReason = !runtimeEditable
    ? "This runtime contract is read-only."
    : !hasOfficialContent
      ? "This target does not publish one official baseline, so the full-text editor cannot derive a safe exact overlay."
      : !trustedEditableContract
        ? "This target is not in the runtime's local-user-editable security class or editable runtime status."
        : "This runtime contract is read-only.";
  return {
    id,
    label: rawTarget.label,
    description: "",
    groupId: group.id,
    groupLabel: group.label,
    source: rawTarget.source,
    kind: rawTarget.kind,
    role: "",
    lifecycle,
    editable,
    readOnlyReason: editable
      ? ""
      : rawTarget.readOnlyReason || editabilityReason,
    official,
    officialHash,
    officialContentAvailable: hasOfficialContent,
    runtimeEffectiveText,
    runtimeEffectiveHash,
    runtimeStatus,
    targetPattern: rawTarget.targetPattern || "",
    sourceTargetId,
    overrideStrategy,
    overrideConflict,
    requiredPlaceholders: [],
    securityClass,
  };
}

export function normalizeCodexPromptCatalog(rawCatalog) {
  if (!rawCatalog || typeof rawCatalog !== "object" || Array.isArray(rawCatalog)) {
    throw promptCenterError("Codex prompt catalog must be an object", 503, "codex_prompt_invalid_catalog");
  }
  assertUnicodeScalarStrings(rawCatalog, "Codex prompt catalog", {
    statusCode: 503,
    code: "codex_prompt_invalid_catalog",
  });
  const protocolVersion = rawCatalog.schemaVersion;
  if (protocolVersion !== CODEX_PROMPT_PROTOCOL_VERSION) {
    throw promptCenterError(
      `Unsupported Codex prompt protocol version: ${Number.isFinite(protocolVersion) ? protocolVersion : "missing"}`,
      503,
      "codex_prompt_protocol_unsupported",
      { supported: CODEX_PROMPT_PROTOCOL_VERSION, received: Number.isFinite(protocolVersion) ? protocolVersion : null },
    );
  }
  assertExactObjectShape(rawCatalog, CATALOG_ROOT_KEYS, "Codex prompt catalog");
  if (typeof rawCatalog.runtimeVersion !== "string") {
    throw promptCenterError("Codex prompt runtimeVersion must be text", 503, "codex_prompt_invalid_catalog");
  }
  if (!isSha256(rawCatalog.catalogRevision)) {
    throw promptCenterError("Codex prompt catalogRevision must be a SHA-256 hash", 503, "codex_prompt_invalid_catalog");
  }
  if (!Array.isArray(rawCatalog.groups)) {
    throw promptCenterError("Codex prompt catalog groups must be an array", 503, "codex_prompt_invalid_catalog");
  }
  const calculatedRevision = computeCodexPromptCatalogRevision(rawCatalog);
  if (rawCatalog.catalogRevision !== calculatedRevision) {
    throw promptCenterError(
      "Codex prompt catalogRevision does not match the typed catalog content",
      503,
      "codex_prompt_invalid_catalog",
      { expected: calculatedRevision, received: rawCatalog.catalogRevision },
    );
  }
  const ids = new Set();
  const groups = rawCatalog.groups.map((rawGroup) => {
    assertExactObjectShape(rawGroup, CATALOG_GROUP_KEYS, "Codex prompt catalog group");
    if (typeof rawGroup.id !== "string" || !rawGroup.id || typeof rawGroup.label !== "string" || !rawGroup.label) {
      throw promptCenterError("Codex prompt catalog group id and label must be non-empty text", 503, "codex_prompt_invalid_catalog");
    }
    if (!Array.isArray(rawGroup.targets)) {
      throw promptCenterError("Codex prompt catalog group targets must be an array", 503, "codex_prompt_invalid_catalog");
    }
    const id = rawGroup.id;
    const label = rawGroup.label;
    const targets = rawGroup.targets.map((target) => normalizeCatalogTarget(target, { id, label }));
    for (const target of targets) {
      if (ids.has(target.id)) {
        throw promptCenterError(`Duplicate Codex prompt target: ${target.id}`, 503, "codex_prompt_invalid_catalog");
      }
      ids.add(target.id);
    }
    return { id, label, targets };
  });
  return {
    protocolVersion,
    codexVersion: rawCatalog.runtimeVersion,
    generatedAt: "",
    catalogRevision: calculatedRevision,
    groups,
  };
}

export function readCodexPromptCatalog({ storageRoot = defaultCodexPromptStorageRoot(), catalog = null } = {}) {
  if (catalog) return normalizeCodexPromptCatalog(catalog);
  assertNoPromptStorageSymlinks(storageRoot);
  assertPrivateDirectory(storageRoot, "Codex prompt storage");
  return normalizeCodexPromptCatalog(readJsonFile(path.join(storageRoot, CATALOG_FILE), {
    requiredMode: 0o600,
  }));
}

function emptyOverrides() {
  return {
    schemaVersion: CODEX_PROMPT_PROTOCOL_VERSION,
    revision: 0,
    overrides: [],
    manifestHash: null,
  };
}

function normalizePatch(rawPatch, targetId) {
  assertExactObjectShape(
    rawPatch,
    ["before", "after", "expectedMatches"],
    `Patch for ${targetId}`,
    { statusCode: 503, code: "codex_prompt_override_invalid" },
  );
  if (typeof rawPatch.before !== "string" || typeof rawPatch.after !== "string") {
    throw promptCenterError(
      `Patch before and after must be text for ${targetId}`,
      503,
      "codex_prompt_override_invalid",
    );
  }
  const before = normalizePrompt(rawPatch.before, `Patch source for ${targetId}`);
  const after = normalizePrompt(rawPatch.after, `Patch replacement for ${targetId}`);
  const expectedMatches = rawPatch.expectedMatches;
  if (!Number.isInteger(expectedMatches) || expectedMatches !== 1) {
    throw promptCenterError(`Patch expectedMatches must be exactly 1 for ${targetId}`, 503, "codex_prompt_override_invalid");
  }
  if (!before) {
    throw promptCenterError(`Patch source must not be empty for ${targetId}`, 503, "codex_prompt_override_invalid");
  }
  return { before, after, expectedMatches };
}

function normalizeOverride(rawOverride) {
  assertExactObjectShape(
    rawOverride,
    ["targetId", "patches", "replacement"],
    "Codex prompt override",
    {
      statusCode: 503,
      code: "codex_prompt_override_invalid",
      optionalKeys: ["officialHash"],
    },
  );
  assertUnicodeScalarStrings(rawOverride, "Codex prompt override", {
    statusCode: 503,
    code: "codex_prompt_override_invalid",
  });
  const targetId = rawOverride.targetId;
  if (typeof targetId !== "string" || !targetId) {
    throw promptCenterError("Every Codex prompt override requires a text targetId", 503, "codex_prompt_override_invalid");
  }
  if (!Array.isArray(rawOverride.patches)) {
    throw promptCenterError(`Override patches must be an array for ${targetId}`, 503, "codex_prompt_override_invalid");
  }
  const officialHash = Object.hasOwn(rawOverride, "officialHash") ? rawOverride.officialHash : null;
  if (officialHash !== null && typeof officialHash !== "string") {
    throw promptCenterError(`Override officialHash must be text or null for ${targetId}`, 503, "codex_prompt_override_invalid");
  }
  if (rawOverride.replacement !== null && typeof rawOverride.replacement !== "string") {
    throw promptCenterError(`Override replacement must be text or null for ${targetId}`, 503, "codex_prompt_override_invalid");
  }
  const patches = rawOverride.patches.map((patch) => normalizePatch(patch, targetId));
  const replacement = rawOverride.replacement === null
    ? null
    : normalizePrompt(rawOverride.replacement, `Replacement prompt ${targetId}`);
  const normalized = {
    targetId,
    officialHash,
    patches,
    replacement,
  };
  if (normalized.officialHash !== null && !isSha256(normalized.officialHash)) {
    throw promptCenterError(`Override officialHash is invalid for ${targetId}`, 503, "codex_prompt_override_invalid");
  }
  if (targetId !== "model/base/*" && normalized.officialHash === null) {
    throw promptCenterError(`Override officialHash is required for ${targetId}`, 503, "codex_prompt_override_invalid");
  }
  const usesPatches = patches.length > 0;
  const usesReplacement = replacement !== null;
  if (
    targetId === "model/base/*"
    && (
      normalized.officialHash !== null
      || !usesPatches
      || usesReplacement
    )
  ) {
    throw promptCenterError(
      "Override model/base/* must use patches with officialHash and replacement set to null",
      503,
      "codex_prompt_override_invalid",
    );
  }
  if (usesPatches === usesReplacement) {
    throw promptCenterError(
      `Override ${targetId} must use either patches or replacement, but not both`,
      503,
      "codex_prompt_override_invalid",
    );
  }
  return { ...normalized, overrideHash: sha256(stableJson(normalized)) };
}

function normalizeOverrides(rawOverrides, { manifestHash = null } = {}) {
  if (!rawOverrides) return emptyOverrides();
  assertExactObjectShape(
    rawOverrides,
    ["schemaVersion", "revision", "overrides"],
    "Codex prompt manifest",
    { statusCode: 503, code: "codex_prompt_override_invalid" },
  );
  const protocolVersion = rawOverrides.schemaVersion;
  if (protocolVersion !== CODEX_PROMPT_PROTOCOL_VERSION) {
    throw promptCenterError("Unsupported Codex prompt override protocol", 503, "codex_prompt_protocol_unsupported");
  }
  if (!Array.isArray(rawOverrides.overrides)) {
    throw promptCenterError("Codex prompt manifest overrides must be an array", 503, "codex_prompt_override_invalid");
  }
  const revision = rawOverrides.revision;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw promptCenterError("Codex prompt manifest revision must be a non-negative safe integer", 503, "codex_prompt_override_invalid");
  }
  const source = rawOverrides.overrides;
  const seen = new Set();
  const overrides = source.map(normalizeOverride);
  for (const override of overrides) {
    if (seen.has(override.targetId)) {
      throw promptCenterError(`Duplicate Codex prompt override: ${override.targetId}`, 503, "codex_prompt_override_invalid");
    }
    seen.add(override.targetId);
  }
  return {
    schemaVersion: protocolVersion,
    revision,
    overrides,
    manifestHash,
  };
}

function nextPromptManifestRevision(revision) {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) {
    throw promptCenterError(
      "Codex prompt manifest revision cannot be incremented safely",
      409,
      "codex_prompt_manifest_revision_exhausted",
    );
  }
  return revision + 1;
}

export function readCodexPromptOverrides({ storageRoot = defaultCodexPromptStorageRoot() } = {}) {
  assertNoPromptStorageSymlinks(storageRoot);
  if (!assertPrivateDirectory(storageRoot, "Codex prompt storage", { required: false })) {
    return emptyOverrides();
  }
  const record = readJsonFile(path.join(storageRoot, OVERRIDES_FILE), {
    required: false,
    includeBytes: true,
    requiredMode: 0o600,
  });
  if (!record) return emptyOverrides();
  return normalizeOverrides(record.value, { manifestHash: sha256(record.bytes) });
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let offset = 0;
  while (offset <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) break;
    count += 1;
    offset = index + Math.max(needle.length, 1);
  }
  return count;
}

export function applyCodexPromptPatches(official, patches, { targetId = "" } = {}) {
  let effective = official;
  for (const [index, patch] of patches.entries()) {
    const matches = countOccurrences(effective, patch.before);
    if (matches !== patch.expectedMatches) {
      throw promptCenterError(
        `Override patch ${index + 1} for ${targetId || "this prompt"} expected ${patch.expectedMatches} match${patch.expectedMatches === 1 ? "" : "es"} but found ${matches}`,
        409,
        "codex_prompt_override_conflict",
        { targetId, patchIndex: index, expectedMatches: patch.expectedMatches, actualMatches: matches },
      );
    }
    effective = effective.split(patch.before).join(patch.after);
    assertPromptSize(effective, `Effective prompt ${targetId}`);
  }
  return effective;
}

function commonPrefixLength(left, right) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function commonSuffixLength(left, right, prefixLength) {
  const limit = Math.min(left.length, right.length) - prefixLength;
  let length = 0;
  while (length < limit && left[left.length - 1 - length] === right[right.length - 1 - length]) length += 1;
  return length;
}

function expandPatchAnchor(official, prefixLength, suffixLength) {
  let start = prefixLength;
  let end = official.length - suffixLength;
  if (start === end) {
    if (start > 0) start -= 1;
    else if (end < official.length) end += 1;
  }
  while (start > 0 && official[start - 1] !== "\n") start -= 1;
  while (end < official.length && official[end] !== "\n") end += 1;
  if (end < official.length) end += 1;
  if (start === end && official) end = official.length;
  return { start, end };
}

export function createCodexPromptPatches(official, effective) {
  if (official === effective) return [];
  if (!official) {
    throw promptCenterError("An empty official prompt cannot be overridden safely", 422, "codex_prompt_empty_official");
  }
  const prefixLength = commonPrefixLength(official, effective);
  const suffixLength = commonSuffixLength(official, effective, prefixLength);
  const { start, end } = expandPatchAnchor(official, prefixLength, suffixLength);
  const before = official.slice(start, end);
  const effectiveEnd = effective.length - Math.max(0, official.length - end);
  const after = effective.slice(start, effectiveEnd);
  const contextual = { before, after, expectedMatches: 1 };
  if (
    before
    && countOccurrences(official, before) === 1
    && applyCodexPromptPatches(official, [contextual]) === effective
  ) {
    return [contextual];
  }
  return [{ before: official, after: effective, expectedMatches: 1 }];
}

function targetLookup(catalog) {
  return new Map(catalog.groups.flatMap((group) => group.targets.map((target) => [target.id, target])));
}

function findTarget(catalog, targetId) {
  const target = targetLookup(catalog).get(String(targetId || ""));
  if (!target) throw promptCenterError("Unknown Codex prompt target", 404, "codex_prompt_target_not_found");
  return target;
}

function validateRequiredPlaceholders(target, effective) {
  const missing = target.requiredPlaceholders.filter((placeholder) => !effective.includes(placeholder));
  if (missing.length) {
    throw promptCenterError(
      `Required placeholder${missing.length === 1 ? "" : "s"} missing: ${missing.join(", ")}`,
      422,
      "codex_prompt_placeholder_missing",
      { targetId: target.id, missing },
    );
  }
}

function currentOverrideForTarget(overrides, target) {
  const exact = overrides.overrides.find((item) => item.targetId === target.id);
  if (exact) return exact;
  if (target.sourceTargetId) {
    const source = overrides.overrides.find((item) => item.targetId === target.sourceTargetId);
    if (source) return source;
  }
  if (target.editable && target.id.startsWith("model/base/") && target.id !== "model/base/*") {
    return overrides.overrides.find((item) => item.targetId === "model/base/*") || null;
  }
  return null;
}

function staleReadOnlyOverrideConflict(target, override) {
  if (!override || target.editable || target.runtimeStatus === "pattern") return null;
  return preferredOverrideConflict(target, override, {
    code: "codex_prompt_override_target_read_only",
    message: `This saved override cannot apply because ${target.id} is now read-only. Restore official to remove it.`,
  });
}

function catalogOverrideIssues(catalog, overrides) {
  const targets = targetLookup(catalog);
  const issues = [];
  for (const override of overrides.overrides) {
    const target = targets.get(override.targetId);
    if (!target) {
      issues.push({
        targetId: override.targetId,
        code: "codex_prompt_override_target_unknown",
        message: `Saved override target is absent from the runtime catalog: ${override.targetId}`,
      });
      continue;
    }
    if (
      target.overrideConflict?.code === "target_became_personality_dependent"
      && target.overrideConflict.sourceTargetId === override.targetId
      && !target.editable
    ) {
      continue;
    }
    const readOnlyConflict = staleReadOnlyOverrideConflict(target, override);
    if (readOnlyConflict) {
      issues.push({
        targetId: override.targetId,
        ...readOnlyConflict,
      });
      continue;
    }
    const expectedStrategy = target.overrideStrategy
      || (target.runtimeStatus === "pattern" ? "patch" : null);
    const actualStrategy = override.replacement === null ? "patch" : "replacement";
    if (!expectedStrategy || actualStrategy !== expectedStrategy) {
      issues.push({
        targetId: override.targetId,
        code: "codex_prompt_override_strategy_invalid",
        message: `Saved override strategy ${actualStrategy} is incompatible with ${override.targetId}`,
        expected: expectedStrategy,
        received: actualStrategy,
      });
    }
  }
  return issues;
}

function assertNoCatalogOverrideIssues(catalog, overrides) {
  const issues = catalogOverrideIssues(catalog, overrides);
  if (issues.length) {
    throw promptCenterError(
      "Resolve incompatible or orphaned Codex prompt overrides before saving another change.",
      409,
      "codex_prompt_manifest_conflict",
      { issues },
    );
  }
}

function orphanedCatalogTarget(override) {
  return {
    id: override.targetId,
    label: override.targetId,
    description: "Saved override whose target is absent from the installed runtime catalog.",
    groupId: "orphaned-overrides",
    groupLabel: "Orphaned overrides",
    source: "",
    kind: "orphaned_override",
    role: "",
    lifecycle: "",
    editable: false,
    readOnlyReason: "This target is no longer published. Restore it to remove the incompatible override.",
    official: "",
    officialHash: override.officialHash,
    officialContentAvailable: false,
    runtimeEffectiveText: null,
    runtimeEffectiveHash: null,
    runtimeStatus: "orphaned_override",
    targetPattern: "",
    sourceTargetId: null,
    overrideStrategy: null,
    overrideConflict: null,
    requiredPlaceholders: [],
    securityClass: "runtime_contract",
  };
}

function catalogWithOrphanedOverrides(catalog, overrides) {
  const targets = targetLookup(catalog);
  const orphaned = overrides.overrides
    .filter((override) => !targets.has(override.targetId))
    .map(orphanedCatalogTarget);
  if (!orphaned.length) return catalog;
  return {
    ...catalog,
    groups: [
      ...catalog.groups,
      { id: "orphaned-overrides", label: "Orphaned overrides", targets: orphaned },
    ],
  };
}

function baselineEffectiveWithoutRegistry(target) {
  if (!target.editable) {
    return {
      effective: target.runtimeEffectiveText,
      effectiveHash: target.runtimeEffectiveHash,
    };
  }
  if (!target.sourceTargetId && target.runtimeEffectiveText !== null) {
    return {
      effective: target.runtimeEffectiveText,
      effectiveHash: target.runtimeEffectiveHash,
    };
  }
  return {
    effective: target.official,
    effectiveHash: target.officialHash,
  };
}

function preferredOverrideConflict(target, override, fallback) {
  if (
    target.overrideConflict
    && override
    && target.overrideConflict.sourceTargetId === override.targetId
  ) {
    return target.overrideConflict;
  }
  return fallback;
}

function resolveOverride(target, override) {
  if (target.runtimeStatus === "orphaned_override") {
    return {
      effective: null,
      effectiveHash: null,
      overrideHash: override?.overrideHash || "",
      override: override || null,
      overrideInherited: false,
      conflict: override ? {
        code: "codex_prompt_override_target_unknown",
        message: "This saved override target is absent from the installed runtime catalog.",
      } : null,
    };
  }
  if (!target.editable) {
    const baseline = baselineEffectiveWithoutRegistry(target);
    return {
      ...baseline,
      overrideHash: override?.overrideHash || "",
      override: null,
      overrideInherited: false,
      conflict: staleReadOnlyOverrideConflict(target, override) || target.overrideConflict || null,
    };
  }
  if (!override) {
    const baseline = baselineEffectiveWithoutRegistry(target);
    return {
      ...baseline,
      overrideHash: "",
      override: null,
      overrideInherited: false,
      conflict: null,
    };
  }
  if (override.officialHash !== null && override.officialHash !== target.officialHash) {
    return {
      effective: target.official,
      effectiveHash: target.officialHash,
      overrideHash: override.overrideHash,
      override,
      overrideInherited: override.targetId !== target.id,
      conflict: preferredOverrideConflict(target, override, {
        code: "codex_prompt_official_changed",
        message: "The official prompt changed after this override was saved.",
      }),
    };
  }
  try {
    const usesReplacement = override.replacement !== null;
    if (
      !target.overrideStrategy
      || (target.overrideStrategy === "replacement" && !usesReplacement)
      || (target.overrideStrategy === "patch" && usesReplacement)
    ) {
      throw promptCenterError(
        `Saved override strategy no longer matches the runtime catalog for ${target.id}`,
        409,
        "codex_prompt_override_strategy_changed",
      );
    }
    const effective = override.replacement === null
      ? applyCodexPromptPatches(target.official, override.patches, { targetId: target.id })
      : override.replacement;
    validateRequiredPlaceholders(target, effective);
    const effectiveHash = sha256(effective);
    return {
      effective,
      effectiveHash,
      overrideHash: override.overrideHash,
      override,
      overrideInherited: override.targetId !== target.id,
      conflict: null,
    };
  } catch (error) {
    return {
      effective: target.official,
      effectiveHash: target.officialHash,
      overrideHash: override.overrideHash,
      override,
      overrideInherited: override.targetId !== target.id,
      conflict: preferredOverrideConflict(target, override, {
        code: error.code || "codex_prompt_override_conflict",
        message: error.message,
      }),
    };
  }
}

function defaultPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function defaultCodexRuntimeProcess(pid) {
  try {
    const command = execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    }).trim();
    return /\bapp-server\b/.test(command)
      && /(?:^|[/\s])codex(?:[\s-]|$)/i.test(command);
  } catch {
    return false;
  }
}

function defaultCodexRuntimeProcessStartUnixMs(pid) {
  try {
    const started = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    }).trim();
    const startedAtUnixMs = Date.parse(started);
    return Number.isFinite(startedAtUnixMs) && startedAtUnixMs >= 0 ? startedAtUnixMs : null;
  } catch {
    return null;
  }
}

function defaultCodexRuntimeProcessStartIdentity(pid) {
  if (process.platform !== "darwin" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const identity = execFileSync("/usr/bin/python3", [
      "-c",
      DARWIN_PROCESS_START_IDENTITY_SCRIPT,
      String(pid),
    ], {
      encoding: "utf8",
      env: {
        LANG: "C",
        LC_ALL: "C",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    }).trim();
    return isDarwinProcessStartIdentity(identity) ? identity : null;
  } catch {
    return null;
  }
}

export function codexPromptDarwinIdentityHelperSourceForTest() {
  return DARWIN_PROCESS_START_IDENTITY_SCRIPT;
}

function normalizeActiveOverrides(receipt) {
  if (!Array.isArray(receipt.activeOverrides)) {
    throw promptCenterError("Codex prompt runtime receipt has no activeOverrides array", 503, "codex_prompt_receipt_invalid");
  }
  const records = [];
  const hashes = {};
  const sources = {};
  for (const item of receipt.activeOverrides) {
    assertExactObjectShape(
      item,
      ["targetId", "sourceTargetId", "effectiveHash"],
      "Codex prompt runtime active override",
      { statusCode: 503, code: "codex_prompt_receipt_invalid" },
    );
    const targetId = typeof item.targetId === "string" ? item.targetId : "";
    const sourceTargetId = typeof item.sourceTargetId === "string" ? item.sourceTargetId : "";
    const effectiveHash = typeof item.effectiveHash === "string" ? item.effectiveHash : "";
    if (!targetId || !sourceTargetId || Object.hasOwn(hashes, targetId) || Object.hasOwn(sources, targetId)) {
      throw promptCenterError("Codex prompt runtime receipt contains an invalid or duplicate target", 503, "codex_prompt_receipt_invalid");
    }
    if (!isSha256(effectiveHash)) {
      throw promptCenterError("Codex prompt runtime receipt contains an invalid effective hash", 503, "codex_prompt_receipt_invalid");
    }
    records.push({ targetId, sourceTargetId, effectiveHash });
    sources[targetId] = sourceTargetId;
    hashes[targetId] = effectiveHash;
  }
  return { records, hashes, sources };
}

function expectedActiveOverrides(catalog) {
  return catalog.groups.flatMap((group) => group.targets)
    .filter((target) => target.sourceTargetId !== null && target.runtimeEffectiveHash !== null)
    .map((target) => ({
      targetId: target.id,
      sourceTargetId: target.sourceTargetId,
      effectiveHash: target.runtimeEffectiveHash,
    }));
}

function assertActiveOverridesMatchSnapshot(actual, catalog) {
  const expected = expectedActiveOverrides(catalog);
  const matches = actual.length === expected.length && actual.every((item, index) => (
    item.targetId === expected[index].targetId
    && item.sourceTargetId === expected[index].sourceTargetId
    && item.effectiveHash === expected[index].effectiveHash
  ));
  if (!matches) {
    throw promptCenterError(
      "Codex prompt runtime activeOverrides do not exactly match the referenced catalog snapshot",
      503,
      "codex_prompt_receipt_invalid",
      { expected, received: actual },
    );
  }
}

function rawCatalogRevision(rawCatalog) {
  return computeCodexPromptCatalogRevision(rawCatalog);
}

function runtimeSnapshotResult(runtimePath, {
  pid,
  catalogFile,
  catalogHash,
  catalogRevision,
  processStartedAtUnixMs,
  beforeRuntimeSnapshotRead,
}) {
  try {
    if (typeof beforeRuntimeSnapshotRead === "function") {
      beforeRuntimeSnapshotRead({ pid, catalogFile });
    }
    const snapshotPath = path.join(runtimePath, catalogFile);
    const record = readJsonFile(snapshotPath, {
      maxBytes: MAX_CODEX_PROMPT_MANIFEST_BYTES,
      includeBytes: true,
      requiredMode: 0o600,
    });
    if (record.stat.mtimeMs < processStartedAtUnixMs) {
      throw promptCenterError(
        `Codex prompt runtime catalog predates process ${pid}: ${catalogFile}`,
        503,
        "codex_prompt_runtime_catalog_stale",
      );
    }
    if (sha256(record.bytes) !== catalogHash) {
      throw promptCenterError(
        `Codex prompt runtime catalog hash does not match ${catalogFile}`,
        503,
        "codex_prompt_runtime_catalog_invalid",
      );
    }
    if (rawCatalogRevision(record.value) !== catalogRevision) {
      throw promptCenterError(
        `Codex prompt runtime catalog has an invalid logical revision: ${catalogFile}`,
        503,
        "codex_prompt_runtime_catalog_invalid",
      );
    }
    const catalog = normalizeCodexPromptCatalog(record.value);
    if (catalog.catalogRevision !== catalogRevision) {
      throw promptCenterError(
        `Codex prompt runtime catalog revision does not match receipt ${pid}.json`,
        503,
        "codex_prompt_runtime_catalog_invalid",
      );
    }
    return { catalog, error: null };
  } catch (error) {
    return {
      catalog: null,
      error: {
        code: error.code || "codex_prompt_runtime_catalog_invalid",
        message: error.message,
      },
    };
  }
}

function unverifiedRuntimeReceipt(
  pid,
  processStartedAtUnixMs,
  message,
  processStartIdentity = null,
  publicationGeneration = 0,
) {
  return {
    pid,
    alive: true,
    identityVerified: false,
    processStartedAtUnixMs,
    processStartIdentity,
    publicationGeneration,
    loadedAtUnixMs: 0,
    codexVersion: "",
    catalogFile: "",
    catalogHash: "",
    catalogRevision: "",
    catalog: null,
    catalogError: {
      code: "codex_prompt_runtime_identity_unverified",
      message,
    },
    manifestRevision: 0,
    manifestHash: null,
    loadedHashes: {},
    sourceTargetIds: {},
    activeOverrides: [],
  };
}

function normalizeRuntimeReceipt(receipt, {
  entryName,
  filenamePid,
  runtimePath,
  processStartedAtUnixMs,
  processStartIdentity,
  publicationState,
  beforeRuntimeSnapshotRead,
}) {
  const receiptKeys = [
    "schemaVersion",
    "pid",
    "publicationGeneration",
    "processStartIdentity",
    "loadedAtUnixMs",
    "runtimeVersion",
    "manifestRevision",
    "manifestHash",
    "catalogFile",
    "catalogHash",
    "catalogRevision",
    "activeOverrides",
  ];
  assertExactObjectShape(receipt, receiptKeys, `Codex prompt receipt ${entryName}`, {
    statusCode: 503,
    code: "codex_prompt_receipt_invalid",
  });
  const schemaVersion = receipt.schemaVersion;
  if (schemaVersion !== CODEX_PROMPT_RECEIPT_VERSION) {
    throw promptCenterError(
      `Unsupported Codex prompt receipt protocol in ${entryName}`,
      503,
      "codex_prompt_protocol_unsupported",
    );
  }
  if (typeof receipt.runtimeVersion !== "string") {
    throw promptCenterError(
      `Codex prompt receipt runtimeVersion must be text in ${entryName}`,
      503,
      "codex_prompt_receipt_invalid",
    );
  }
  const pid = receipt.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid !== filenamePid) {
    throw promptCenterError(
      `Codex prompt receipt PID does not match ${entryName}`,
      503,
      "codex_prompt_receipt_invalid",
    );
  }
  const publicationGeneration = receipt.publicationGeneration;
  if (!Number.isSafeInteger(publicationGeneration) || publicationGeneration <= 0) {
    throw promptCenterError(
      `Codex prompt receipt has an invalid publicationGeneration in ${entryName}`,
      503,
      "codex_prompt_receipt_invalid",
    );
  }
  if (!isDarwinProcessStartIdentity(receipt.processStartIdentity)) {
    throw promptCenterError(
      `Codex prompt receipt has an invalid processStartIdentity in ${entryName}`,
      503,
      "codex_prompt_receipt_invalid",
    );
  }
  if (receipt.processStartIdentity !== processStartIdentity) {
    return unverifiedRuntimeReceipt(
      pid,
      processStartedAtUnixMs,
      `Codex prompt receipt belongs to another process generation: ${entryName}`,
      processStartIdentity,
      publicationGeneration,
    );
  }
  if (publicationState.runtimeOwnerGenerations[String(pid)] !== publicationGeneration) {
    return unverifiedRuntimeReceipt(
      pid,
      processStartedAtUnixMs,
      `Codex prompt receipt is not owned by the current publication generation: ${entryName}`,
      processStartIdentity,
      publicationGeneration,
    );
  }
  const catalogRevision = receipt.catalogRevision;
  const catalogHash = receipt.catalogHash;
  const catalogFile = receipt.catalogFile;
  if (
    typeof catalogRevision !== "string"
    || typeof catalogHash !== "string"
    || typeof catalogFile !== "string"
    || !isSha256(catalogRevision)
    || !isSha256(catalogHash)
  ) {
    throw promptCenterError(
      `Codex prompt receipt has an invalid catalog identity in ${entryName}`,
      503,
      "codex_prompt_receipt_invalid",
    );
  }
  const catalogFileMatch = /^([1-9]\d*)\.([0-9a-f]{64})\.catalog\.json$/.exec(catalogFile);
  if (
    !catalogFileMatch
    || Number(catalogFileMatch[1]) !== pid
    || `sha256:${catalogFileMatch[2]}` !== catalogHash
  ) {
    throw promptCenterError(
      `Codex prompt receipt has an invalid catalogFile in ${entryName}`,
      503,
      "codex_prompt_receipt_invalid",
    );
  }
  const loadedAtUnixMs = receipt.loadedAtUnixMs;
  if (!Number.isSafeInteger(loadedAtUnixMs) || loadedAtUnixMs < 0 || loadedAtUnixMs > Date.now() + 300_000) {
    throw promptCenterError(
      `Codex prompt receipt has an invalid load timestamp in ${entryName}`,
      503,
      "codex_prompt_receipt_invalid",
    );
  }
  if (loadedAtUnixMs < processStartedAtUnixMs) {
    return unverifiedRuntimeReceipt(
      pid,
      processStartedAtUnixMs,
      `Codex prompt receipt predates the current process start: ${entryName}`,
    );
  }
  const manifestHash = receipt.manifestHash;
  if (manifestHash !== null && typeof manifestHash !== "string") {
    throw promptCenterError(
      `Codex prompt receipt manifestHash must be text or null in ${entryName}`,
      503,
      "codex_prompt_receipt_invalid",
    );
  }
  if (manifestHash !== null && !isSha256(manifestHash)) {
    throw promptCenterError(
      `Codex prompt receipt has an invalid manifest hash in ${entryName}`,
      503,
      "codex_prompt_receipt_invalid",
    );
  }
  const manifestRevision = receipt.manifestRevision;
  if (!Number.isSafeInteger(manifestRevision) || manifestRevision < 0) {
    throw promptCenterError(
      `Codex prompt receipt has an invalid manifest revision in ${entryName}`,
      503,
      "codex_prompt_receipt_invalid",
    );
  }
  const active = normalizeActiveOverrides(receipt);
  const snapshot = runtimeSnapshotResult(runtimePath, {
    pid,
    catalogFile,
    catalogHash,
    catalogRevision,
    processStartedAtUnixMs,
    beforeRuntimeSnapshotRead,
  });
  if (snapshot.catalog) {
    if (receipt.runtimeVersion !== snapshot.catalog.codexVersion) {
      throw promptCenterError(
        `Codex prompt receipt runtimeVersion does not match its catalog snapshot in ${entryName}`,
        503,
        "codex_prompt_receipt_invalid",
      );
    }
    assertActiveOverridesMatchSnapshot(active.records, snapshot.catalog);
  }
  return {
    pid,
    alive: true,
    identityVerified: true,
    processStartedAtUnixMs,
    processStartIdentity,
    publicationGeneration,
    loadedAtUnixMs,
    codexVersion: receipt.runtimeVersion,
    catalogFile,
    catalogHash,
    catalogRevision,
    catalog: snapshot.catalog,
    catalogError: snapshot.error,
    manifestRevision,
    manifestHash,
    activeOverrides: active.records,
    loadedHashes: active.hashes,
    sourceTargetIds: active.sources,
  };
}

function normalizeRuntimePublicationState(value) {
  assertExactObjectShape(
    value,
    [
      "schemaVersion",
      "nextGeneration",
      "globalOwnerGeneration",
      "runtimeRegistryGenerations",
      "runtimeOwnerGenerations",
    ],
    "Codex prompt publication state",
    {
      statusCode: 503,
      code: "codex_prompt_publication_state_invalid",
    },
  );
  if (value.schemaVersion !== CODEX_PROMPT_PUBLICATION_STATE_VERSION) {
    throw promptCenterError(
      "Unsupported Codex prompt publication state protocol",
      503,
      "codex_prompt_publication_state_invalid",
    );
  }
  const nextGeneration = value.nextGeneration;
  const globalOwnerGeneration = value.globalOwnerGeneration;
  if (
    !Number.isSafeInteger(nextGeneration)
    || nextGeneration < 1
    || !Number.isSafeInteger(globalOwnerGeneration)
    || globalOwnerGeneration < 0
    || Object.is(globalOwnerGeneration, -0)
    || globalOwnerGeneration >= nextGeneration
  ) {
    throw promptCenterError(
      "Codex prompt publication state contains an invalid generation",
      503,
      "codex_prompt_publication_state_invalid",
    );
  }
  const rawRegistries = value.runtimeRegistryGenerations;
  const rawOwners = value.runtimeOwnerGenerations;
  if (!rawRegistries || typeof rawRegistries !== "object" || Array.isArray(rawRegistries)) {
    throw promptCenterError(
      "Codex prompt publication state runtimeRegistryGenerations must be an object",
      503,
      "codex_prompt_publication_state_invalid",
    );
  }
  if (!rawOwners || typeof rawOwners !== "object" || Array.isArray(rawOwners)) {
    throw promptCenterError(
      "Codex prompt publication state runtimeOwnerGenerations must be an object",
      503,
      "codex_prompt_publication_state_invalid",
    );
  }
  const registryKeys = Object.keys(rawRegistries);
  const ownerKeys = Object.keys(rawOwners);
  if (
    registryKeys.length !== ownerKeys.length
    || registryKeys.some((pidKey) => !Object.hasOwn(rawOwners, pidKey))
  ) {
    throw promptCenterError(
      "Codex prompt publication state runtime generation maps must have identical PID keys",
      503,
      "codex_prompt_publication_state_invalid",
    );
  }
  const runtimeRegistryGenerations = {};
  const runtimeOwnerGenerations = {};
  for (const pidKey of registryKeys) {
    const pid = Number(pidKey);
    const registryGeneration = rawRegistries[pidKey];
    const ownerGeneration = rawOwners[pidKey];
    if (
      !/^[1-9]\d*$/.test(pidKey)
      || !Number.isSafeInteger(pid)
      || pid < 1
      || pid > 0xffff_ffff
      || String(pid) !== pidKey
      || !Number.isSafeInteger(registryGeneration)
      || registryGeneration < 1
      || registryGeneration >= nextGeneration
      || !Number.isSafeInteger(ownerGeneration)
      || ownerGeneration < 1
      || ownerGeneration >= nextGeneration
      || registryGeneration > ownerGeneration
    ) {
      throw promptCenterError(
        "Codex prompt publication state contains invalid runtime generations",
        503,
        "codex_prompt_publication_state_invalid",
      );
    }
    runtimeRegistryGenerations[pidKey] = registryGeneration;
    runtimeOwnerGenerations[pidKey] = ownerGeneration;
  }
  return {
    schemaVersion: CODEX_PROMPT_PUBLICATION_STATE_VERSION,
    nextGeneration,
    globalOwnerGeneration,
    runtimeRegistryGenerations,
    runtimeOwnerGenerations,
  };
}

function readRuntimePublicationStateRecord(storageRoot) {
  try {
    const record = readJsonFile(path.join(storageRoot, PUBLICATION_STATE_FILE), {
      required: false,
      maxBytes: MAX_CODEX_PROMPT_PUBLICATION_STATE_BYTES,
      includeBytes: true,
      requiredMode: 0o600,
    });
    if (!record) {
      return {
        record: null,
        error: {
          code: "codex_prompt_publication_state_unavailable",
          message: "Codex prompt publication state is unavailable.",
        },
      };
    }
    return {
      record: {
        ...record,
        value: normalizeRuntimePublicationState(record.value),
      },
      error: null,
    };
  } catch (error) {
    return {
      record: null,
      error: {
        code: error.code || "codex_prompt_publication_state_invalid",
        message: error.message,
      },
    };
  }
}

function readRuntimeReceiptRecord(receiptPath, entryName, processStartedAtUnixMs, {
  required = true,
} = {}) {
  let record;
  try {
    record = readJsonFile(receiptPath, {
      required,
      maxBytes: MAX_CODEX_PROMPT_MANIFEST_BYTES,
      includeBytes: true,
      requiredMode: 0o600,
    });
  } catch (error) {
    throw promptCenterError(
      `Codex prompt runtime receipt is invalid: ${entryName}`,
      503,
      "codex_prompt_receipt_invalid",
      { cause: error.message },
    );
  }
  if (!record) return { missing: true, stale: false, record: null };
  if (record.stat.mtimeMs < processStartedAtUnixMs) {
    return { missing: false, stale: true, record: null };
  }
  return {
    missing: false,
    stale: false,
    record,
  };
}

function safeReceiptPublicationGeneration(receipt) {
  return Number.isSafeInteger(receipt?.publicationGeneration)
    && receipt.publicationGeneration > 0
    ? receipt.publicationGeneration
    : 0;
}

function runtimeReceiptEntries(runtimePath) {
  return fs.readdirSync(runtimePath, { withFileTypes: true })
    .filter((entry) => /^\d+\.json$/.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function publicationStateOwnsRuntimeReceiptProofs(publicationStateRead, proofs) {
  return Boolean(publicationStateRead.record)
    && proofs.every((proof) => (
      publicationStateRead.record.value.runtimeOwnerGenerations[String(proof.pid)]
        === proof.publicationGeneration
    ));
}

function readRuntimeProcessIdentitySet({
  runtimePath,
  isPidAlive,
  isRuntimeProcess,
  getRuntimeProcessStartIdentity,
}) {
  const identities = new Map();
  for (const entry of runtimeReceiptEntries(runtimePath)) {
    const pid = Number(path.basename(entry.name, ".json"));
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    let alive = false;
    try {
      alive = Boolean(isPidAlive(pid));
    } catch {}
    if (!alive) continue;
    let runtimeProcess = false;
    try {
      runtimeProcess = isRuntimeProcess(pid) === true;
    } catch {}
    if (!runtimeProcess) continue;
    let processStartIdentity = null;
    try {
      processStartIdentity = getRuntimeProcessStartIdentity(pid);
    } catch {}
    identities.set(
      pid,
      isDarwinProcessStartIdentity(processStartIdentity) ? processStartIdentity : null,
    );
  }
  return identities;
}

function sameRuntimeProcessIdentitySet(expected, actual) {
  return expected.size === actual.size
    && [...expected].every(([pid, identity]) => actual.get(pid) === identity);
}

function runtimeReceiptBatchProofIsStable({
  storageRoot,
  runtimePath,
  initialPublicationStateRead,
  initialProcessIdentities,
  proofs,
  isPidAlive,
  isRuntimeProcess,
  getRuntimeProcessStartIdentity,
  beforeRuntimeBatchReceiptRead,
  batchAttempt,
}) {
  if (!proofs.length) return true;
  const publicationStateBefore = readRuntimePublicationStateRecord(storageRoot);
  let stable = (
    publicationStateOwnsRuntimeReceiptProofs(initialPublicationStateRead, proofs)
    && publicationStateOwnsRuntimeReceiptProofs(publicationStateBefore, proofs)
  );
  for (const proof of proofs) {
    if (typeof beforeRuntimeBatchReceiptRead === "function") {
      try {
        beforeRuntimeBatchReceiptRead({
          pid: proof.pid,
          entryName: proof.entryName,
          batchAttempt,
        });
      } catch {
        stable = false;
      }
    }
    let currentRead = null;
    try {
      currentRead = readRuntimeReceiptRecord(
        proof.receiptPath,
        proof.entryName,
        proof.processStartedAtUnixMs,
        { required: false },
      );
    } catch {
      stable = false;
      continue;
    }
    if (
      currentRead.missing
      || currentRead.stale
      || !proof.receiptBytes.equals(currentRead.record.bytes)
      || safeReceiptPublicationGeneration(currentRead.record.value) !== proof.publicationGeneration
    ) {
      stable = false;
    }
  }
  const publicationStateAfter = readRuntimePublicationStateRecord(storageRoot);
  if (!publicationStateOwnsRuntimeReceiptProofs(publicationStateAfter, proofs)) {
    stable = false;
  }
  try {
    const finalProcessIdentities = readRuntimeProcessIdentitySet({
      runtimePath,
      isPidAlive,
      isRuntimeProcess,
      getRuntimeProcessStartIdentity,
    });
    if (!sameRuntimeProcessIdentitySet(initialProcessIdentities, finalProcessIdentities)) {
      stable = false;
    }
  } catch {
    stable = false;
  }
  return stable;
}

export function readCodexPromptRuntimeReceipts({
  storageRoot = defaultCodexPromptStorageRoot(),
  isPidAlive = defaultPidAlive,
  isRuntimeProcess = defaultCodexRuntimeProcess,
  getRuntimeProcessStartUnixMs = defaultCodexRuntimeProcessStartUnixMs,
  getRuntimeProcessStartIdentity = defaultCodexRuntimeProcessStartIdentity,
  beforeRuntimeSnapshotRead = null,
  beforeRuntimeBatchReceiptRead = null,
} = {}) {
  const runtimePath = path.join(storageRoot, RUNTIME_DIR);
  assertNoPromptStorageSymlinks(runtimePath);
  if (!assertPrivateDirectory(storageRoot, "Codex prompt storage", { required: false })) return [];
  if (!assertPrivateDirectory(runtimePath, "Codex prompt runtime directory", { required: false })) return [];
  for (
    let batchAttempt = 0;
    batchAttempt < MAX_RUNTIME_RECEIPT_READ_ATTEMPTS;
    batchAttempt += 1
  ) {
    const entries = runtimeReceiptEntries(runtimePath);
    const initialPublicationStateRead = readRuntimePublicationStateRecord(storageRoot);
    const initialProcessIdentities = new Map();
    const proofs = [];
    const receipts = entries.flatMap((entry) => {
      const filenamePid = Number(path.basename(entry.name, ".json"));
      if (!Number.isSafeInteger(filenamePid) || filenamePid <= 0 || !isPidAlive(filenamePid)) return [];
      let identityVerified = false;
      try {
        identityVerified = isRuntimeProcess(filenamePid) === true;
      } catch {}
      if (!identityVerified) return [];
      let processStartIdentity = null;
      try {
        processStartIdentity = getRuntimeProcessStartIdentity(filenamePid);
      } catch {}
      initialProcessIdentities.set(
        filenamePid,
        isDarwinProcessStartIdentity(processStartIdentity) ? processStartIdentity : null,
      );
      if (!isDarwinProcessStartIdentity(processStartIdentity)) {
        return [unverifiedRuntimeReceipt(
          filenamePid,
          null,
          `Could not verify the exact start identity of Codex process ${filenamePid}.`,
        )];
      }
      let processStartedAtUnixMs = null;
      try {
        processStartedAtUnixMs = getRuntimeProcessStartUnixMs(filenamePid);
      } catch {}
      if (!Number.isFinite(processStartedAtUnixMs) || processStartedAtUnixMs < 0) {
        return [unverifiedRuntimeReceipt(
          filenamePid,
          null,
          `Could not verify the start time of Codex process ${filenamePid}.`,
          processStartIdentity,
        )];
      }
      const receiptPath = path.join(runtimePath, entry.name);
      const firstRead = readRuntimeReceiptRecord(
        receiptPath,
        entry.name,
        processStartedAtUnixMs,
        { required: false },
      );
      if (firstRead.missing) return [];
      if (firstRead.stale) {
        return [unverifiedRuntimeReceipt(
          filenamePid,
          processStartedAtUnixMs,
          `Codex prompt receipt predates the current process start: ${entry.name}`,
          processStartIdentity,
        )];
      }
      let currentRecord = firstRead.record;
      let normalized = null;
      for (let attempt = 0; attempt < MAX_RUNTIME_RECEIPT_READ_ATTEMPTS; attempt += 1) {
        const publicationStateRead = readRuntimePublicationStateRecord(storageRoot);
        let normalizationError = null;
        if (publicationStateRead.record) {
          try {
            normalized = normalizeRuntimeReceipt(currentRecord.value, {
              entryName: entry.name,
              filenamePid,
              runtimePath,
              processStartedAtUnixMs,
              processStartIdentity,
              publicationState: publicationStateRead.record.value,
              beforeRuntimeSnapshotRead,
            });
          } catch (error) {
            normalizationError = error;
          }
        } else {
          normalized = unverifiedRuntimeReceipt(
            filenamePid,
            processStartedAtUnixMs,
            publicationStateRead.error.message,
            processStartIdentity,
            safeReceiptPublicationGeneration(currentRecord.value),
          );
        }
        const latestRead = readRuntimeReceiptRecord(
          receiptPath,
          entry.name,
          processStartedAtUnixMs,
          { required: false },
        );
        const latestPublicationStateRead = readRuntimePublicationStateRecord(storageRoot);
        if (latestRead.missing) {
          normalized = unverifiedRuntimeReceipt(
            filenamePid,
            processStartedAtUnixMs,
            `Codex prompt receipt was removed while its publication was being verified: ${entry.name}`,
            processStartIdentity,
            safeReceiptPublicationGeneration(currentRecord.value),
          );
          break;
        }
        if (latestRead.stale) {
          return [unverifiedRuntimeReceipt(
            filenamePid,
            processStartedAtUnixMs,
            `Codex prompt receipt predates the current process start: ${entry.name}`,
            processStartIdentity,
          )];
        }
        const latestRecord = latestRead.record;
        const receiptStable = currentRecord.bytes.equals(latestRecord.bytes);
        const publicationStateStable = (
          publicationStateRead.record
          && latestPublicationStateRead.record
          && publicationStateRead.record.value.runtimeOwnerGenerations[String(filenamePid)]
            === latestPublicationStateRead.record.value.runtimeOwnerGenerations[String(filenamePid)]
        );
        const publicationStateUnavailable = (
          !publicationStateRead.record
          && !latestPublicationStateRead.record
        );
        if (receiptStable && (publicationStateStable || publicationStateUnavailable)) {
          if (normalizationError) throw normalizationError;
          break;
        }
        if (attempt + 1 >= MAX_RUNTIME_RECEIPT_READ_ATTEMPTS) {
          normalized = unverifiedRuntimeReceipt(
            filenamePid,
            processStartedAtUnixMs,
            `Codex prompt receipt or publication state changed repeatedly while its catalog snapshot was being verified: ${entry.name}`,
            processStartIdentity,
            safeReceiptPublicationGeneration(latestRecord.value),
          );
          break;
        }
        currentRecord = latestRecord;
      }
      let processStartIdentityAfter = null;
      try {
        processStartIdentityAfter = getRuntimeProcessStartIdentity(filenamePid);
      } catch {}
      if (
        !isDarwinProcessStartIdentity(processStartIdentityAfter)
        || processStartIdentityAfter !== processStartIdentity
      ) {
        return [unverifiedRuntimeReceipt(
          filenamePid,
          processStartedAtUnixMs,
          `Codex process ${filenamePid} changed generation while its prompt receipt was being verified.`,
          processStartIdentityAfter,
        )];
      }
      if (normalized.identityVerified) {
        proofs.push({
          pid: filenamePid,
          entryName: entry.name,
          receiptPath,
          processStartedAtUnixMs,
          publicationGeneration: normalized.publicationGeneration,
          receiptBytes: currentRecord.bytes,
        });
      }
      return [normalized];
    });
    if (runtimeReceiptBatchProofIsStable({
      storageRoot,
      runtimePath,
      initialPublicationStateRead,
      initialProcessIdentities,
      proofs,
      isPidAlive,
      isRuntimeProcess,
      getRuntimeProcessStartIdentity,
      beforeRuntimeBatchReceiptRead,
      batchAttempt,
    })) {
      return receipts;
    }
    if (batchAttempt + 1 >= MAX_RUNTIME_RECEIPT_READ_ATTEMPTS) {
      return receipts.map((receipt) => (
        receipt.identityVerified
          ? unverifiedRuntimeReceipt(
              receipt.pid,
              receipt.processStartedAtUnixMs,
              "Codex prompt runtime receipts changed repeatedly while a consistent batch was being verified.",
              receipt.processStartIdentity,
              receipt.publicationGeneration,
            )
          : receipt
      ));
    }
  }
  return [];
}

function runtimeTargetProof(receipt, targetId) {
  if (!receipt.catalog) return { hash: "", text: null };
  const snapshotTarget = targetLookup(receipt.catalog).get(targetId);
  if (!snapshotTarget) return { hash: "", text: null };
  if (snapshotTarget.sourceTargetId !== null && snapshotTarget.runtimeEffectiveHash !== null) {
    const exactHash = receipt.loadedHashes[targetId] || "";
    const exactSource = receipt.sourceTargetIds[targetId] || "";
    if (
      exactHash !== snapshotTarget.runtimeEffectiveHash
      || exactSource !== snapshotTarget.sourceTargetId
    ) {
      return { hash: "", text: null };
    }
    return {
      hash: exactHash,
      text: snapshotTarget.runtimeEffectiveText,
    };
  }
  const snapshotHash = snapshotTarget.runtimeEffectiveHash || snapshotTarget.officialHash || "";
  const snapshotText = snapshotTarget.runtimeEffectiveHash === snapshotHash
    ? snapshotTarget.runtimeEffectiveText
    : snapshotTarget.officialHash === snapshotHash
      ? snapshotTarget.official
      : null;
  return {
    hash: snapshotHash,
    text: snapshotText,
  };
}

function loadedStateForTarget(target, resolved, receipts, catalog, overrides) {
  const alive = receipts.filter((receipt) => receipt.alive);
  if (target.runtimeStatus === "pattern") {
    return {
      status: "pattern",
      loaded: null,
      loadedHash: "",
      processes: alive.length,
    };
  }
  if (!target.officialHash && !target.runtimeEffectiveHash && !resolved.override) {
    return {
      status: "catalogued",
      loaded: null,
      loadedHash: "",
      processes: alive.length,
    };
  }
  if (!alive.length) {
    return { status: resolved.override ? "pending_next_launch" : "not_running", loaded: null, loadedHash: "", processes: 0 };
  }
  const manifestCurrent = alive.every((receipt) => (
    receipt.manifestRevision === overrides.revision
    && receipt.manifestHash === overrides.manifestHash
  ));
  const catalogCurrent = alive.every((receipt) => receipt.catalogRevision === catalog.catalogRevision);
  const identityVerified = alive.every((receipt) => receipt.identityVerified === true);
  const proofs = alive.map((receipt) => runtimeTargetProof(receipt, target.id));
  if (proofs.some((proof) => !proof.hash)) {
    return {
      status: "unverified_runtime",
      loaded: null,
      loadedHash: "",
      processes: alive.length,
      manifestCurrent,
      catalogCurrent,
      identityVerified,
    };
  }
  const hashes = [...new Set(proofs.map((proof) => proof.hash))];
  const knownText = (hash) => {
    const snapshotText = proofs.find((proof) => proof.hash === hash && proof.text !== null)?.text;
    if (snapshotText !== undefined) return snapshotText;
    if (hash === resolved.effectiveHash) return resolved.effective;
    if (hash === target.runtimeEffectiveHash) return target.runtimeEffectiveText;
    if (hash === target.officialHash) return target.official;
    return null;
  };
  if (hashes.length > 1) {
    return {
      status: "mixed_versions",
      loaded: null,
      loadedHash: "",
      loadedHashes: hashes,
      processes: alive.length,
      manifestCurrent,
      catalogCurrent,
      identityVerified,
    };
  }
  const loadedHash = hashes[0] || "";
  if (!loadedHash) {
    return {
      status: "unverified_runtime",
      loaded: null,
      loadedHash: "",
      processes: alive.length,
      manifestCurrent,
      catalogCurrent,
      identityVerified,
    };
  }
  if (loadedHash === resolved.effectiveHash) {
    const status = resolved.override
      ? "loaded"
      : loadedHash === target.officialHash
        ? "official_loaded"
        : "effective_loaded";
    return {
      status,
      loaded: knownText(loadedHash),
      loadedHash,
      processes: alive.length,
      manifestCurrent,
      catalogCurrent,
      identityVerified,
    };
  }
  return {
    status: target.editable ? "restart_required" : "loaded_differs",
    loaded: knownText(loadedHash),
    loadedHash,
    processes: alive.length,
    manifestCurrent,
    catalogCurrent,
    identityVerified,
  };
}

function statusLabel(status) {
  return ({
    conflict: "Conflict",
    loaded: "Runtime loaded",
    official_loaded: "Official loaded by runtime",
    effective_loaded: "Effective loaded by runtime",
    pending_next_launch: "Pending next launch",
    not_running: "Codex not running",
    mixed_versions: "Mixed runtime-loaded state",
    unverified_runtime: "Runtime-loaded state unavailable",
    restart_required: "Restart required",
    loaded_differs: "Loaded prompt differs",
    catalogued: "Catalogued",
    pattern: "Target pattern",
  })[status] || "Unknown";
}

function currentState({ catalog, overrides, receipts, target }) {
  const override = currentOverrideForTarget(overrides, target);
  const resolved = resolveOverride(target, override);
  const loaded = loadedStateForTarget(target, resolved, receipts, catalog, overrides);
  const status = resolved.conflict ? "conflict" : loaded.status;
  return {
    resolved,
    loaded,
    status,
    statusLabel: statusLabel(status),
    restartRequired: ["restart_required", "pending_next_launch", "mixed_versions", "loaded_differs"].includes(status),
    catalogRevision: catalog.catalogRevision,
    overridesRevision: overrides.revision,
  };
}

// No Codex prompt storage yet (Codex never ran, or no runtime catalog):
// the Prompt Center shows an empty state, not an error.
function codexPromptStorageExists(storageRoot) {
  assertNoPromptStorageSymlinks(storageRoot);
  return assertPrivateDirectory(storageRoot, "Codex prompt storage", { required: false });
}

function emptyCodexPromptCenterSummary() {
  return {
    schemaVersion: CODEX_PROMPT_PROTOCOL_VERSION,
    codexVersion: "",
    catalogRevision: "",
    overridesRevision: 0,
    generatedAt: "",
    available: false,
    unavailableReason: "No Codex prompt catalog on this machine yet. Start Codex once to publish it.",
    groups: [],
    summary: { targets: 0, editable: 0, overrides: 0, conflicts: 0, restartRequired: 0, liveProcesses: 0 },
    restartMessage: CODEX_PROMPT_RESTART_MESSAGE,
  };
}

export function readCodexPromptCenterSummary({
  storageRoot = defaultCodexPromptStorageRoot(),
  catalog: suppliedCatalog = null,
  isPidAlive = defaultPidAlive,
  isRuntimeProcess = defaultCodexRuntimeProcess,
  getRuntimeProcessStartUnixMs = defaultCodexRuntimeProcessStartUnixMs,
  getRuntimeProcessStartIdentity = defaultCodexRuntimeProcessStartIdentity,
} = {}) {
  if (!suppliedCatalog && !codexPromptStorageExists(storageRoot)) return emptyCodexPromptCenterSummary();
  const runtimeCatalog = readCodexPromptCatalog({ storageRoot, catalog: suppliedCatalog });
  const overrides = readCodexPromptOverrides({ storageRoot });
  const catalog = catalogWithOrphanedOverrides(runtimeCatalog, overrides);
  const receipts = readCodexPromptRuntimeReceipts({
    storageRoot,
    isPidAlive,
    isRuntimeProcess,
    getRuntimeProcessStartUnixMs,
    getRuntimeProcessStartIdentity,
  });
  const groups = catalog.groups.map((group) => ({
    id: group.id,
    label: group.label,
    targets: group.targets.map((target) => {
      const state = currentState({ catalog, overrides, receipts, target });
      return {
        id: target.id,
        label: target.label,
        description: target.description,
        source: target.source,
        kind: target.kind,
        role: target.role,
        editable: target.editable,
        readOnlyReason: target.readOnlyReason,
        securityClass: target.securityClass,
        runtimeStatus: target.runtimeStatus,
        targetPattern: target.targetPattern,
        sourceTargetId: target.sourceTargetId,
        overrideStrategy: target.overrideStrategy,
        overrideConflict: target.overrideConflict,
        officialContentAvailable: target.officialContentAvailable,
        status: state.status,
        statusLabel: state.statusLabel,
        hasOverride: Boolean(state.resolved.overrideHash),
        overrideInherited: state.resolved.overrideInherited,
        conflict: state.resolved.conflict,
        officialHash: target.officialHash,
        effectiveHash: state.resolved.effectiveHash,
        loadedHash: state.loaded.loadedHash,
      };
    }),
  }));
  return {
    schemaVersion: catalog.protocolVersion,
    codexVersion: catalog.codexVersion,
    catalogRevision: catalog.catalogRevision,
    overridesRevision: overrides.revision,
    generatedAt: catalog.generatedAt,
    groups,
    summary: {
      targets: groups.reduce((total, group) => total + group.targets.length, 0),
      editable: groups.reduce((total, group) => total + group.targets.filter((target) => target.editable).length, 0),
      overrides: overrides.overrides.length,
      conflicts: groups.reduce((total, group) => total + group.targets.filter((target) => target.status === "conflict").length, 0),
      restartRequired: groups.reduce((total, group) => total + group.targets.filter((target) => (
        ["restart_required", "pending_next_launch", "mixed_versions", "loaded_differs"].includes(target.status)
      )).length, 0),
      liveProcesses: receipts.filter((receipt) => receipt.alive).length,
    },
    restartMessage: CODEX_PROMPT_RESTART_MESSAGE,
  };
}

function promptTargetResponse(target, catalog, overrides, receipts, { commitWarning = "" } = {}) {
  const state = currentState({ catalog, overrides, receipts, target });
  return {
    ...target,
    catalogRevision: catalog.catalogRevision,
    overridesRevision: overrides.revision,
    effective: state.resolved.effective,
    effectiveHash: state.resolved.effectiveHash,
    overrideHash: state.resolved.overrideHash,
    overrideInherited: state.resolved.overrideInherited,
    overrideSourceTargetId: state.resolved.override?.targetId || null,
    patches: state.resolved.override?.patches || [],
    replacement: state.resolved.override?.replacement ?? null,
    loaded: state.loaded.loaded,
    loadedHash: state.loaded.loadedHash,
    loadedHashes: state.loaded.loadedHashes || [],
    liveProcesses: state.loaded.processes,
    runtimeIdentityVerified: state.loaded.identityVerified ?? null,
    runtimeManifestCurrent: state.loaded.manifestCurrent ?? null,
    runtimeCatalogCurrent: state.loaded.catalogCurrent ?? null,
    status: state.status,
    statusLabel: state.statusLabel,
    conflict: state.resolved.conflict,
    restartRequired: state.restartRequired,
    restartMessage: CODEX_PROMPT_RESTART_MESSAGE,
    ...(commitWarning ? { commitWarning } : {}),
  };
}

export function readCodexPromptTarget(targetId, {
  storageRoot = defaultCodexPromptStorageRoot(),
  catalog: suppliedCatalog = null,
  isPidAlive = defaultPidAlive,
  isRuntimeProcess = defaultCodexRuntimeProcess,
  getRuntimeProcessStartUnixMs = defaultCodexRuntimeProcessStartUnixMs,
  getRuntimeProcessStartIdentity = defaultCodexRuntimeProcessStartIdentity,
} = {}) {
  if (!suppliedCatalog && !codexPromptStorageExists(storageRoot)) {
    throw promptCenterError("Unknown Codex prompt target", 404, "codex_prompt_target_not_found");
  }
  const runtimeCatalog = readCodexPromptCatalog({ storageRoot, catalog: suppliedCatalog });
  const overrides = readCodexPromptOverrides({ storageRoot });
  const catalog = catalogWithOrphanedOverrides(runtimeCatalog, overrides);
  const receipts = readCodexPromptRuntimeReceipts({
    storageRoot,
    isPidAlive,
    isRuntimeProcess,
    getRuntimeProcessStartUnixMs,
    getRuntimeProcessStartIdentity,
  });
  const target = findTarget(catalog, targetId);
  return promptTargetResponse(target, catalog, overrides, receipts);
}

function assertCurrentDraft(payload, catalog, overrides, target) {
  if (String(payload.catalogRevision || "") !== catalog.catalogRevision) {
    throw promptCenterError(
      "The Codex prompt catalog changed. Refresh before saving.",
      409,
      "codex_prompt_catalog_stale",
      { expected: catalog.catalogRevision, received: String(payload.catalogRevision || "") },
    );
  }
  const receivedOfficialHash = payload.officialHash === null ? null : String(payload.officialHash || "");
  if (receivedOfficialHash !== target.officialHash) {
    throw promptCenterError(
      "The official Codex prompt changed. Refresh before saving.",
      409,
      "codex_prompt_official_stale",
      { expected: target.officialHash, received: receivedOfficialHash },
    );
  }
  const currentOverride = currentOverrideForTarget(overrides, target);
  const currentOverrideHash = currentOverride?.overrideHash || "";
  if (String(payload.overrideHash || "") !== currentOverrideHash) {
    throw promptCenterError(
      "This Codex prompt override changed in another editor. Refresh before saving.",
      409,
      "codex_prompt_override_stale",
      { expected: currentOverrideHash, received: String(payload.overrideHash || "") },
    );
  }
  return currentOverride;
}

export function validateCodexPromptDraft(payload, {
  storageRoot = defaultCodexPromptStorageRoot(),
  catalog: suppliedCatalog = null,
} = {}) {
  const catalog = readCodexPromptCatalog({ storageRoot, catalog: suppliedCatalog });
  const overrides = readCodexPromptOverrides({ storageRoot });
  assertNoCatalogOverrideIssues(catalog, overrides);
  const target = findTarget(catalog, payload?.targetId);
  if (!target.editable) {
    throw promptCenterError(
      target.readOnlyReason || "This Codex prompt is read-only.",
      403,
      "codex_prompt_read_only",
      { targetId: target.id },
    );
  }
  const currentOverride = assertCurrentDraft(payload || {}, catalog, overrides, target);
  const effective = normalizePrompt(payload?.effective ?? "", `Effective prompt ${target.id}`);
  validateRequiredPlaceholders(target, effective);
  if (!target.officialContentAvailable && target.overrideStrategy !== "replacement") {
    throw promptCenterError(
      "The installed Codex build did not publish this target's official content, so Context Room cannot derive a safe exact overlay.",
      409,
      "codex_prompt_official_content_unavailable",
      { targetId: target.id },
    );
  }
  const materializesInheritedOverride = Boolean(
    currentOverride
    && currentOverride.targetId !== target.id
    && effective === target.official
  );
  const replacement = target.overrideStrategy === "replacement" ? effective : null;
  const patches = replacement === null
    ? materializesInheritedOverride
      ? [{ before: target.official, after: target.official, expectedMatches: 1 }]
      : createCodexPromptPatches(target.official, effective)
    : [];
  const applied = replacement === null
    ? (patches.length ? applyCodexPromptPatches(target.official, patches, { targetId: target.id }) : target.official)
    : replacement;
  if (applied !== effective) {
    throw promptCenterError("The exact prompt overlay did not reproduce the draft", 422, "codex_prompt_overlay_invalid");
  }
  return {
    valid: true,
    targetId: target.id,
    changed: effective !== target.official || materializesInheritedOverride,
    bytes: byteLength(effective),
    estimatedTokens: estimateCodexPromptTokens(effective),
    maxBytes: MAX_CODEX_PROMPT_BYTES,
    maxEstimatedTokens: MAX_CODEX_PROMPT_ESTIMATED_TOKENS,
    officialHash: target.officialHash,
    effectiveHash: sha256(effective),
    overrideHash: String(payload?.overrideHash || ""),
    catalogRevision: catalog.catalogRevision,
    overridesRevision: overrides.revision,
    patches,
    replacement,
  };
}

function normalizedCommittedOverrides(value) {
  return normalizeOverrides(value, { manifestHash: sha256(serializePromptState(value)) });
}

function persistedOverridesState(overrides) {
  return {
    schemaVersion: CODEX_PROMPT_PROTOCOL_VERSION,
    revision: overrides.revision,
    overrides: overrides.overrides.map(({ overrideHash: _overrideHash, ...override }) => override),
  };
}

function backupCurrentOverrides(storageRoot, overrides) {
  return secureAtomicWritePromptState(
    path.join(storageRoot, LAST_KNOWN_GOOD_FILE),
    persistedOverridesState(overrides),
  );
}

function promptTargetResponseAfterCommit(
  target,
  catalog,
  overrides,
  storageRoot,
  isPidAlive,
  isRuntimeProcess,
  getRuntimeProcessStartUnixMs,
  getRuntimeProcessStartIdentity,
  commitWarnings = [],
) {
  try {
    const receipts = readCodexPromptRuntimeReceipts({
      storageRoot,
      isPidAlive,
      isRuntimeProcess,
      getRuntimeProcessStartUnixMs,
      getRuntimeProcessStartIdentity,
    });
    return promptTargetResponse(target, catalog, overrides, receipts, {
      commitWarning: combinePromptWarnings(commitWarnings),
    });
  } catch (error) {
    return promptTargetResponse(target, catalog, overrides, [], {
      commitWarning: combinePromptWarnings(
        commitWarnings,
        `Override commit succeeded, but runtime-loaded status could not be refreshed: ${error.message}`,
      ),
    });
  }
}

export function writeCodexPromptOverride(payload, {
  storageRoot = defaultCodexPromptStorageRoot(),
  catalog: suppliedCatalog = null,
  isPidAlive = defaultPidAlive,
  isRuntimeProcess = defaultCodexRuntimeProcess,
  getRuntimeProcessStartUnixMs = defaultCodexRuntimeProcessStartUnixMs,
  getRuntimeProcessStartIdentity = defaultCodexRuntimeProcessStartIdentity,
  getProcessStartUnixMs = defaultCodexRuntimeProcessStartUnixMs,
} = {}) {
  return withPromptWriteLock(storageRoot, isPidAlive, getProcessStartUnixMs, () => {
    const validation = validateCodexPromptDraft(payload, { storageRoot, catalog: suppliedCatalog });
    if (
      Object.hasOwn(payload || {}, "acknowledgeHighContext")
      && typeof payload.acknowledgeHighContext !== "boolean"
    ) {
      throw promptCenterError(
        "acknowledgeHighContext must be a boolean",
        422,
        "codex_prompt_high_context_ack_invalid",
      );
    }
    if (
      validation.changed
      && validation.estimatedTokens > CODEX_PROMPT_HIGH_CONTEXT_CONFIRM_TOKENS
      && payload?.acknowledgeHighContext !== true
    ) {
      throw promptCenterError(
        `Saving this prompt requires explicit confirmation because it is estimated at ${validation.estimatedTokens} tokens`,
        422,
        "codex_prompt_high_context_ack_required",
        {
          threshold: CODEX_PROMPT_HIGH_CONTEXT_CONFIRM_TOKENS,
          estimatedTokens: validation.estimatedTokens,
        },
      );
    }
    if (!validation.changed) {
      return deleteCodexPromptOverrideUnlocked(payload, {
        storageRoot,
        catalog: suppliedCatalog,
        isPidAlive,
        isRuntimeProcess,
        getRuntimeProcessStartUnixMs,
        getRuntimeProcessStartIdentity,
      });
    }
    const catalog = readCodexPromptCatalog({ storageRoot, catalog: suppliedCatalog });
    const overrides = readCodexPromptOverrides({ storageRoot });
    assertNoCatalogOverrideIssues(catalog, overrides);
    const target = findTarget(catalog, validation.targetId);
    assertCurrentDraft(payload || {}, catalog, overrides, target);
    const nextOverride = {
      targetId: validation.targetId,
      officialHash: validation.officialHash,
      patches: validation.patches,
      replacement: validation.replacement,
    };
    const nextOverrides = overrides.overrides
      .filter((item) => item.targetId !== validation.targetId)
      .map(({ overrideHash: _overrideHash, ...item }) => item);
    nextOverrides.push(nextOverride);
    nextOverrides.sort((left, right) => left.targetId.localeCompare(right.targetId));
    const nextState = {
      schemaVersion: CODEX_PROMPT_PROTOCOL_VERSION,
      revision: nextPromptManifestRevision(overrides.revision),
      overrides: nextOverrides,
    };
    const backupWrite = backupCurrentOverrides(storageRoot, overrides);
    const manifestWrite = secureAtomicWritePromptState(path.join(storageRoot, OVERRIDES_FILE), nextState);
    const committedOverrides = normalizedCommittedOverrides(nextState);
    return promptTargetResponseAfterCommit(
      target,
      catalog,
      committedOverrides,
      storageRoot,
      isPidAlive,
      isRuntimeProcess,
      getRuntimeProcessStartUnixMs,
      getRuntimeProcessStartIdentity,
      [backupWrite.commitWarning, manifestWrite.commitWarning],
    );
  });
}

function deleteCodexPromptOverrideUnlocked(payload, {
  storageRoot = defaultCodexPromptStorageRoot(),
  catalog: suppliedCatalog = null,
  isPidAlive = defaultPidAlive,
  isRuntimeProcess = defaultCodexRuntimeProcess,
  getRuntimeProcessStartUnixMs = defaultCodexRuntimeProcessStartUnixMs,
  getRuntimeProcessStartIdentity = defaultCodexRuntimeProcessStartIdentity,
} = {}) {
  const runtimeCatalog = readCodexPromptCatalog({ storageRoot, catalog: suppliedCatalog });
  const overrides = readCodexPromptOverrides({ storageRoot });
  const catalog = catalogWithOrphanedOverrides(runtimeCatalog, overrides);
  const target = findTarget(catalog, payload?.targetId);
  const currentOverride = assertCurrentDraft(payload || {}, catalog, overrides, target);
  if (currentOverride && currentOverride.targetId !== target.id) {
    throw promptCenterError(
      `This prompt inherits ${currentOverride.targetId}; restore that source target instead.`,
      409,
      "codex_prompt_inherited_override",
      { targetId: target.id, sourceTargetId: currentOverride.targetId },
    );
  }
  const exists = overrides.overrides.some((item) => item.targetId === target.id);
  if (!exists) {
    return readCodexPromptTarget(target.id, {
      storageRoot,
      catalog: suppliedCatalog,
      isPidAlive,
      isRuntimeProcess,
      getRuntimeProcessStartUnixMs,
      getRuntimeProcessStartIdentity,
    });
  }
  const nextState = {
    schemaVersion: CODEX_PROMPT_PROTOCOL_VERSION,
    revision: nextPromptManifestRevision(overrides.revision),
    overrides: overrides.overrides
      .filter((item) => item.targetId !== target.id)
      .map(({ overrideHash: _overrideHash, ...item }) => item),
  };
  const backupWrite = backupCurrentOverrides(storageRoot, overrides);
  const manifestWrite = secureAtomicWritePromptState(path.join(storageRoot, OVERRIDES_FILE), nextState);
  const committedOverrides = normalizedCommittedOverrides(nextState);
  return promptTargetResponseAfterCommit(
    target,
    catalog,
    committedOverrides,
    storageRoot,
    isPidAlive,
    isRuntimeProcess,
    getRuntimeProcessStartUnixMs,
    getRuntimeProcessStartIdentity,
    [backupWrite.commitWarning, manifestWrite.commitWarning],
  );
}

export function deleteCodexPromptOverride(payload, {
  storageRoot = defaultCodexPromptStorageRoot(),
  catalog: suppliedCatalog = null,
  isPidAlive = defaultPidAlive,
  isRuntimeProcess = defaultCodexRuntimeProcess,
  getRuntimeProcessStartUnixMs = defaultCodexRuntimeProcessStartUnixMs,
  getRuntimeProcessStartIdentity = defaultCodexRuntimeProcessStartIdentity,
  getProcessStartUnixMs = defaultCodexRuntimeProcessStartUnixMs,
} = {}) {
  return withPromptWriteLock(
    storageRoot,
    isPidAlive,
    getProcessStartUnixMs,
    () => deleteCodexPromptOverrideUnlocked(payload, {
      storageRoot,
      catalog: suppliedCatalog,
      isPidAlive,
      isRuntimeProcess,
      getRuntimeProcessStartUnixMs,
      getRuntimeProcessStartIdentity,
    }),
  );
}

export function defaultCodexPromptStorageRoot() {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "prompt-overrides");
}

export function createCodexPromptCenterProvider({
  storageRoot = defaultCodexPromptStorageRoot(),
  catalog = null,
  isPidAlive = defaultPidAlive,
  isRuntimeProcess = defaultCodexRuntimeProcess,
  getRuntimeProcessStartUnixMs = defaultCodexRuntimeProcessStartUnixMs,
  getRuntimeProcessStartIdentity = defaultCodexRuntimeProcessStartIdentity,
  getProcessStartUnixMs = defaultCodexRuntimeProcessStartUnixMs,
} = {}) {
  const options = {
    storageRoot,
    catalog,
    isPidAlive,
    isRuntimeProcess,
    getRuntimeProcessStartUnixMs,
    getRuntimeProcessStartIdentity,
    getProcessStartUnixMs,
  };
  return Object.freeze({
    readSummary: () => readCodexPromptCenterSummary(options),
    readTarget: (targetId) => readCodexPromptTarget(targetId, options),
    validateDraft: (payload) => validateCodexPromptDraft(payload, options),
    writeOverride: (payload) => writeCodexPromptOverride(payload, options),
    deleteOverride: (payload) => deleteCodexPromptOverride(payload, options),
    refresh: () => readCodexPromptCenterSummary(options),
  });
}
