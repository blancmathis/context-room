import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { threadId, workerData } from "node:worker_threads";
import { types } from "node:util";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_MS = 30_000;
const LOCK_RECORD_MAX_BYTES = 4_096;
const MAX_RECLAIMER_RECORDS = 10_000;
const MAX_WORKER_LOCK_PATHS = 32;
const LOCK_RECORD_TEMP_PREFIX = ".context-room-filesystem-lock-";
const LOCK_RECORD_TEMP_SUFFIX = ".tmp";
const PROCESS_IDENTITY_MAX_BYTES = 8_192;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const lockWait = new Int32Array(new SharedArrayBuffer(4));
const activeOwnerTokens = new Set();
let cachedCurrentProcessIdentity;

function readBoundedUtf8(filePath, maximumBytes) {
  const descriptor = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(maximumBytes + 1);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead <= 0 || bytesRead > maximumBytes) return "";
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function linuxProcessIdentity(pid) {
  try {
    const bootId = readBoundedUtf8("/proc/sys/kernel/random/boot_id", 128).trim().toLowerCase();
    const processStat = readBoundedUtf8(`/proc/${pid}/stat`, PROCESS_IDENTITY_MAX_BYTES).trim();
    const commandEnd = processStat.lastIndexOf(")");
    if (!/^[0-9a-f-]{36}$/.test(bootId) || commandEnd < 2) return "";
    const fieldsAfterCommand = processStat.slice(commandEnd + 1).trim().split(/\s+/);
    const startTimeTicks = fieldsAfterCommand[19];
    if (!/^\d+$/.test(startTimeTicks || "")) return "";
    const pidNamespace = fs.readlinkSync(`/proc/${pid}/ns/pid`);
    if (!/^pid:\[\d+\]$/.test(pidNamespace)) return "";
    return `linux:${bootId}:${pidNamespace}:${startTimeTicks}`;
  } catch {
    return "";
  }
}

function darwinProcessIdentity(pid) {
  try {
    const startedAt = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
      maxBuffer: 4_096,
    }).trim().replace(/\s+/g, " ");
    return startedAt ? `darwin:${startedAt}` : "";
  } catch {
    return "";
  }
}

export function filesystemProcessIdentity(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return "";
  if (process.platform === "linux") return linuxProcessIdentity(Number(pid));
  if (process.platform === "darwin") return darwinProcessIdentity(Number(pid));
  return "";
}

function currentProcessIdentity() {
  if (cachedCurrentProcessIdentity === undefined) {
    cachedCurrentProcessIdentity = filesystemProcessIdentity(process.pid);
  }
  return cachedCurrentProcessIdentity;
}

function waitForLock(deadline, milliseconds = 20) {
  const remaining = deadline - performance.now();
  if (remaining <= 0) return;
  Atomics.wait(lockWait, 0, 0, Math.max(1, Math.min(remaining, Number(milliseconds) || 20)));
}

function assertBeforeDeadline(deadline, options) {
  if (performance.now() >= deadline) throw busyError(options.busyMessage, options.busyCode);
}

function normalizeWorkerLockPaths(paths) {
  if (!Array.isArray(paths)) return [];
  const normalized = [];
  for (const item of paths) {
    const candidate = String(item ?? "").trim();
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    if (normalized.includes(resolved)) continue;
    normalized.push(resolved);
    if (normalized.length > MAX_WORKER_LOCK_PATHS) {
      const error = new RangeError(`At most ${MAX_WORKER_LOCK_PATHS} filesystem lock paths may be supervised`);
      error.code = "filesystem_lock_worker_paths_limit";
      throw error;
    }
  }
  return normalized;
}

function positiveFiniteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function scanDirectory(directory, deadline, options, visitor) {
  assertBeforeDeadline(deadline, options);
  let handle;
  try {
    handle = fs.opendirSync(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  let count = 0;
  try {
    while (true) {
      assertBeforeDeadline(deadline, options);
      const entry = handle.readSync();
      if (!entry) return;
      assertBeforeDeadline(deadline, options);
      count += 1;
      if (count > MAX_RECLAIMER_RECORDS) throw busyError(options.busyMessage, options.busyCode);
      visitor(entry.name);
    }
  } finally {
    try { handle.closeSync(); } catch {}
  }
}

function lockPaths(lockPath) {
  const resolved = path.resolve(lockPath);
  return {
    lock: resolved,
    reclaim: `${resolved}.reclaim`,
    reclaimers: `${resolved}.reclaimers`,
  };
}

function readLockRecord(filePath) {
  let handle;
  try {
    handle = fs.openSync(filePath, "r");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = fs.fstatSync(handle, { bigint: true });
    let record = null;
    if (stat.isFile() && stat.size <= BigInt(LOCK_RECORD_MAX_BYTES)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(handle, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) record = parsed;
      } catch {}
    }
    return {
      pid: Number.isInteger(Number(record?.pid)) ? Number(record.pid) : 0,
      threadId: Number.isInteger(Number(record?.threadId)) ? Number(record.threadId) : 0,
      ownerInstanceId: typeof record?.ownerInstanceId === "string" ? record.ownerInstanceId : "",
      processIdentity: typeof record?.processIdentity === "string" && record.processIdentity.length <= 512
        ? record.processIdentity
        : "",
      kind: record?.kind === "owner" ? "owner" : record?.kind === "coordination" ? "coordination" : "legacy",
      token: typeof record?.token === "string" ? record.token : "",
      acquiredAt: String(record?.acquiredAt || ""),
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      ageMs: Math.max(0, Date.now() - Number(stat.mtimeMs)),
    };
  } finally {
    fs.closeSync(handle);
  }
}

function currentWorkerOwner(lockPath) {
  if (threadId <= 0) return null;
  const owner = workerData?.filesystemLockOwner;
  let allowedPaths = [];
  try {
    allowedPaths = normalizeWorkerLockPaths(owner?.paths);
  } catch {}
  if (
    Number(owner?.version) !== 1
    || typeof owner?.id !== "string"
    || !UUID_PATTERN.test(owner.id)
    || Number(owner?.pid) !== process.pid
    || !allowedPaths.includes(path.resolve(lockPath))
  ) {
    throw busyError("Worker is not supervised for this filesystem lock", "filesystem_lock_worker_unsupervised");
  }
  return owner;
}

function createLockRecord(filePath, { kind = "coordination", ownerLockPath = filePath } = {}) {
  const token = randomUUID();
  const workerOwner = threadId > 0 ? currentWorkerOwner(ownerLockPath) : null;
  const tempPath = path.join(
    path.dirname(filePath),
    `${LOCK_RECORD_TEMP_PREFIX}${workerOwner?.id || "main"}-${token}${LOCK_RECORD_TEMP_SUFFIX}`,
  );
  let handle;
  let created = null;
  let record = null;
  let published = false;
  try {
    handle = fs.openSync(tempPath, "wx", 0o600);
    const stat = fs.fstatSync(handle, { bigint: true });
    created = { dev: stat.dev.toString(), ino: stat.ino.toString() };
    fs.writeFileSync(handle, JSON.stringify({
      pid: process.pid,
      threadId,
      ownerInstanceId: workerOwner?.id || "",
      processIdentity: currentProcessIdentity(),
      kind,
      token,
      acquiredAt: new Date().toISOString(),
    }) + "\n", "utf8");
    fs.fsyncSync(handle);
    record = {
      handle,
      pid: process.pid,
      threadId,
      ownerInstanceId: workerOwner?.id || "",
      processIdentity: currentProcessIdentity(),
      kind,
      token,
      tempPath,
      ...created,
    };
    fs.linkSync(tempPath, filePath);
    published = true;
    try { fs.unlinkSync(tempPath); } catch {}
    const current = readLockRecord(filePath);
    if (!lockRecordMatches(record, current)) {
      throw busyError("Filesystem lock publication changed before validation", "filesystem_lock_publication_changed");
    }
    return record;
  } catch (error) {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch {}
    }
    if (published && created) {
      try {
        const current = readLockRecord(filePath);
        if (lockRecordMatches(record, current)) fs.unlinkSync(filePath);
      } catch {}
    }
    if (created) {
      try {
        const current = readLockRecord(tempPath);
        if (current?.dev === created.dev && current?.ino === created.ino) fs.unlinkSync(tempPath);
      } catch {}
    }
    throw error;
  }
}

function lockRecordMatches(expected, current) {
  return Boolean(
    expected
    && current
    && expected.dev === current.dev
    && expected.ino === current.ino
    && expected.token === current.token
  );
}

function lockOwnerAlive(record, options) {
  if (!Number.isInteger(record?.pid) || record.pid <= 0) return false;
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    if (error?.code !== "EPERM") return false;
  }
  if (!record.processIdentity) {
    if (options?.requireProcessIdentity && record.pid === process.pid && record.threadId === threadId) {
      return activeOwnerTokens.has(record.token);
    }
    return true;
  }
  const observedIdentity = filesystemProcessIdentity(record.pid);
  return !observedIdentity || observedIdentity === record.processIdentity;
}

function lockIsStale(record, staleMs, options) {
  if (!record || record.ageMs <= staleMs) return false;
  if (!record.token) return true;
  return !lockOwnerAlive(record, options);
}

function busyError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 409;
  return error;
}

function removeUniqueLockRecord(filePath, expected) {
  try {
    const current = readLockRecord(filePath);
    if (!lockRecordMatches(expected, current)) return false;
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function removeCreatedTempRecord(expected) {
  if (!expected?.tempPath) return false;
  try {
    return removeUniqueLockRecord(expected.tempPath, expected);
  } catch {
    return false;
  }
}

function releaseReclaim(paths, reclaim) {
  try {
    const current = readLockRecord(paths.reclaim);
    if (lockRecordMatches(reclaim, current)) fs.unlinkSync(paths.reclaim);
  } catch {}
  removeCreatedTempRecord(reclaim);
  try { fs.closeSync(reclaim.handle); } catch {}
}

function reclaimerTicketSequence(name) {
  const match = /^(\d{20})\.ticket$/.exec(name);
  return match ? BigInt(match[1]) : null;
}

function unsafeSidecarError(paths) {
  const error = new Error(`Filesystem lock reclaimers must be a direct non-symlink directory beside ${paths.lock}`);
  error.code = "filesystem_lock_unsafe_sidecar";
  error.statusCode = 409;
  return error;
}

function openReclaimerDirectory(paths, { create = false } = {}) {
  let before;
  try {
    before = fs.lstatSync(paths.reclaimers, { bigint: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    if (!create) return null;
    try {
      fs.mkdirSync(paths.reclaimers, { mode: 0o700 });
    } catch (mkdirError) {
      if (mkdirError?.code !== "EEXIST") throw mkdirError;
    }
    before = fs.lstatSync(paths.reclaimers, { bigint: true });
  }
  if (before.isSymbolicLink() || !before.isDirectory()) throw unsafeSidecarError(paths);

  const parentReal = fs.realpathSync(path.dirname(paths.lock));
  const directoryReal = fs.realpathSync(paths.reclaimers);
  if (path.dirname(directoryReal) !== parentReal || path.basename(directoryReal) !== path.basename(paths.reclaimers)) {
    throw unsafeSidecarError(paths);
  }

  const descriptor = fs.openSync(
    paths.reclaimers,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0),
  );
  const opened = fs.fstatSync(descriptor, { bigint: true });
  if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) {
    fs.closeSync(descriptor);
    throw unsafeSidecarError(paths);
  }
  const operationPath = process.platform === "linux" ? `/proc/self/fd/${descriptor}` : paths.reclaimers;
  const assertHeld = () => {
    let current;
    try {
      current = fs.lstatSync(paths.reclaimers, { bigint: true });
    } catch {
      throw unsafeSidecarError(paths);
    }
    if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== opened.dev || current.ino !== opened.ino) {
      throw unsafeSidecarError(paths);
    }
  };
  try {
    assertHeld();
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
  return {
    path: operationPath,
    assertHeld,
    close() {
      fs.closeSync(descriptor);
    },
  };
}

function createReclaimerTicket(directory, ownerLockPath, deadline, options) {
  while (true) {
    directory.assertHeld();
    let maximum = -1n;
    scanDirectory(directory.path, deadline, options, (name) => {
      const sequence = reclaimerTicketSequence(name);
      if (sequence !== null && sequence > maximum) maximum = sequence;
    });
    directory.assertHeld();
    const sequence = maximum + 1n;
    if (sequence > 99_999_999_999_999_999_999n) throw busyError(options.busyMessage, options.busyCode);
    const ticketPath = path.join(directory.path, `${sequence.toString().padStart(20, "0")}.ticket`);
    try {
      return {
        ticketPath,
        ticket: createLockRecord(ticketPath, { kind: "coordination", ownerLockPath }),
        sequence,
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
}

function recoverStaleReclaim(paths, deadline, observed, options) {
  assertBeforeDeadline(deadline, options);
  const directory = openReclaimerDirectory(paths, { create: true });
  let ticketPath;
  let ticket;
  try {
    ({ ticketPath, ticket } = createReclaimerTicket(directory, paths.lock, deadline, options));
    try { fs.closeSync(ticket.handle); } catch {}
    while (true) {
      directory.assertHeld();
      const contenders = [];
      scanDirectory(directory.path, deadline, options, (name) => {
        const sequence = reclaimerTicketSequence(name);
        if (sequence === null) return;
        const contenderPath = path.join(directory.path, name);
        const contender = readLockRecord(contenderPath);
        if (!contender) return;
        if (lockIsStale(contender, options.staleMs, options)) {
          removeUniqueLockRecord(contenderPath, contender);
          return;
        }
        contenders.push({ ...contender, sequence, path: contenderPath });
      });
      directory.assertHeld();
      contenders.sort((left, right) => left.sequence < right.sequence ? -1 : left.sequence > right.sequence ? 1 : 0);
      if (contenders[0]?.path === ticketPath) {
        const current = readLockRecord(paths.reclaim);
        if (!lockRecordMatches(observed, current) || !lockIsStale(current, options.staleMs, options)) return false;
        fs.unlinkSync(paths.reclaim);
        return true;
      }
      assertBeforeDeadline(deadline, options);
      waitForLock(deadline);
    }
  } finally {
    if (ticketPath && ticket) {
      try { removeUniqueLockRecord(ticketPath, ticket); } catch {}
      removeCreatedTempRecord(ticket);
    }
    directory.close();
  }
}

function withReclaim(paths, deadline, options, operation) {
  let reclaim = null;
  while (reclaim === null) {
    assertBeforeDeadline(deadline, options);
    try {
      reclaim = createLockRecord(paths.reclaim, { kind: "coordination", ownerLockPath: paths.lock });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const observed = readLockRecord(paths.reclaim);
      if (lockIsStale(observed, options.staleMs, options)) {
        recoverStaleReclaim(paths, deadline, observed, options);
        continue;
      }
      assertBeforeDeadline(deadline, options);
      waitForLock(deadline);
    }
  }
  try {
    assertBeforeDeadline(deadline, options);
    return operation();
  } finally {
    releaseReclaim(paths, reclaim);
  }
}

function removeLockGeneration(paths, expected) {
  const current = readLockRecord(paths.lock);
  if (!lockRecordMatches(expected, current)) return false;
  fs.unlinkSync(paths.lock);
  return true;
}

function acquireLock(paths, deadline, options) {
  assertBeforeDeadline(deadline, options);
  fs.mkdirSync(path.dirname(paths.lock), { recursive: true, mode: 0o700 });
  while (true) {
    assertBeforeDeadline(deadline, options);
    if (fs.existsSync(paths.reclaim)) {
      const reclaim = readLockRecord(paths.reclaim);
      if (lockIsStale(reclaim, options.staleMs, options)) {
        withReclaim(paths, deadline, options, () => {});
        continue;
      }
      assertBeforeDeadline(deadline, options);
      waitForLock(deadline);
      continue;
    }
    try {
      const owner = createLockRecord(paths.lock, { kind: "owner", ownerLockPath: paths.lock });
      const current = readLockRecord(paths.lock);
      if (lockRecordMatches(owner, current)) return owner;
      try { fs.closeSync(owner.handle); } catch {}
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const observed = readLockRecord(paths.lock);
      if (lockIsStale(observed, options.staleMs, options)) {
        const recovered = withReclaim(paths, deadline, options, () => {
          const claimed = readLockRecord(paths.lock);
          if (!lockIsStale(claimed, options.staleMs, options)) return false;
          return removeLockGeneration(paths, claimed);
        });
        if (recovered) continue;
      }
      assertBeforeDeadline(deadline, options);
      waitForLock(deadline);
    }
  }
}

function releaseLock(paths, owner) {
  try {
    removeLockGeneration(paths, owner);
  } finally {
    removeCreatedTempRecord(owner);
    try { fs.closeSync(owner.handle); } catch {}
  }
}

export function createFilesystemLockWorkerOwner(paths) {
  const normalizedPaths = normalizeWorkerLockPaths(paths);
  if (!normalizedPaths.length) throw new Error("At least one filesystem lock path is required for Worker supervision");
  return Object.freeze({ version: 1, id: randomUUID(), pid: process.pid, paths: Object.freeze(normalizedPaths) });
}

function recordBelongsToWorkerOwner(record, owner) {
  return Boolean(
    record
    && Number(record.pid) === Number(owner?.pid)
    && record.ownerInstanceId
    && record.ownerInstanceId === owner?.id
  );
}

function workerOwnerTempNameMatches(name, owner) {
  if (!UUID_PATTERN.test(String(owner?.id || ""))) return false;
  const prefix = `${LOCK_RECORD_TEMP_PREFIX}${owner.id}-`;
  if (!name.startsWith(prefix) || !name.endsWith(LOCK_RECORD_TEMP_SUFFIX)) return false;
  const token = name.slice(prefix.length, -LOCK_RECORD_TEMP_SUFFIX.length);
  return UUID_PATTERN.test(token);
}

function removeWorkerOwnerTemps(directory, owner, deadline, options) {
  let removed = 0;
  scanDirectory(directory, deadline, options, (name) => {
    if (!workerOwnerTempNameMatches(name, owner)) return;
    const tempPath = path.join(directory, name);
    try {
      const stat = fs.lstatSync(tempPath);
      if (!stat.isFile()) return;
      fs.unlinkSync(tempPath);
      removed += 1;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  });
  return removed;
}

export function cleanupFilesystemLockWorkerOwner(owner, options = {}) {
  const normalizedOptions = {
    timeoutMs: positiveFiniteNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS),
    staleMs: positiveFiniteNumber(options.staleMs, DEFAULT_STALE_MS),
    busyMessage: "Filesystem Worker lock cleanup is busy",
    busyCode: "filesystem_lock_cleanup_busy",
  };
  const deadline = performance.now() + normalizedOptions.timeoutMs;
  let removed = 0;
  for (const lockPath of normalizeWorkerLockPaths(owner?.paths).slice(0, MAX_WORKER_LOCK_PATHS)) {
    assertBeforeDeadline(deadline, normalizedOptions);
    const paths = lockPaths(lockPath);
    try {
      removed += removeWorkerOwnerTemps(path.dirname(paths.lock), owner, deadline, normalizedOptions);
      scanDirectory(paths.reclaimers, deadline, normalizedOptions, (name) => {
        if (workerOwnerTempNameMatches(name, owner)) {
          const tempPath = path.join(paths.reclaimers, name);
          try {
            const stat = fs.lstatSync(tempPath);
            if (stat.isFile()) {
              fs.unlinkSync(tempPath);
              removed += 1;
            }
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
          return;
        }
        if (reclaimerTicketSequence(name) === null) return;
        const ticketPath = path.join(paths.reclaimers, name);
        const ticket = readLockRecord(ticketPath);
        if (recordBelongsToWorkerOwner(ticket, owner) && removeUniqueLockRecord(ticketPath, ticket)) removed += 1;
      });
      assertBeforeDeadline(deadline, normalizedOptions);
      const abandonedReclaim = readLockRecord(paths.reclaim);
      if (recordBelongsToWorkerOwner(abandonedReclaim, owner) && removeUniqueLockRecord(paths.reclaim, abandonedReclaim)) removed += 1;
      withReclaim(paths, deadline, normalizedOptions, () => {
        const current = readLockRecord(paths.lock);
        if (recordBelongsToWorkerOwner(current, owner) && removeLockGeneration(paths, current)) removed += 1;
      });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  assertBeforeDeadline(deadline, normalizedOptions);
  return { removed };
}

export function acquireFilesystemLock(lockPath, options = {}) {
  const normalizedOptions = {
    timeoutMs: positiveFiniteNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS),
    staleMs: positiveFiniteNumber(options.staleMs, DEFAULT_STALE_MS),
    busyMessage: String(options.busyMessage || `Filesystem resource is busy: ${lockPath}`),
    busyCode: String(options.busyCode || "filesystem_lock_busy"),
    requireProcessIdentity: Boolean(options.requireProcessIdentity),
    secureSidecars: Boolean(options.secureSidecars),
  };
  const paths = lockPaths(lockPath);
  if (threadId > 0) currentWorkerOwner(paths.lock);
  if (normalizedOptions.requireProcessIdentity && !currentProcessIdentity()) {
    const error = new Error("Filesystem lock process identity is unavailable");
    error.code = "filesystem_lock_process_identity_unavailable";
    throw error;
  }
  if (normalizedOptions.secureSidecars) openReclaimerDirectory(paths)?.close();
  const owner = acquireLock(paths, performance.now() + normalizedOptions.timeoutMs, normalizedOptions);
  activeOwnerTokens.add(owner.token);
  let released = false;
  const assertHeld = () => {
    if (released) throw busyError(normalizedOptions.busyMessage, normalizedOptions.busyCode);
    const current = readLockRecord(paths.lock);
    if (!lockRecordMatches(owner, current)) throw busyError(normalizedOptions.busyMessage, normalizedOptions.busyCode);
  };
  try {
    assertHeld();
  } catch (error) {
    activeOwnerTokens.delete(owner.token);
    releaseLock(paths, owner);
    throw error;
  }
  return Object.freeze({
    assertHeld,
    release() {
      if (released) return false;
      released = true;
      try {
        releaseLock(paths, owner);
      } finally {
        activeOwnerTokens.delete(owner.token);
      }
      return true;
    },
  });
}

export function withFilesystemLock(lockPath, operation, options = {}) {
  if (types.isAsyncFunction(operation)) {
    const error = new TypeError("withFilesystemLock operation must be synchronous");
    error.code = "filesystem_lock_async_unsupported";
    throw error;
  }
  const lease = acquireFilesystemLock(lockPath, options);
  try {
    const result = operation({
      assertHeld: lease.assertHeld,
    });
    if (result && typeof result.then === "function") {
      const error = new TypeError("withFilesystemLock operation must be synchronous");
      error.code = "filesystem_lock_async_unsupported";
      throw error;
    }
    return result;
  } finally {
    lease.release();
  }
}
