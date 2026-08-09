import { parentPort, workerData } from "node:worker_threads";

import {
  buildContextRoomReports,
  contextHubUiState,
  readFileDiff,
  readReviewBaseFile,
} from "./context_room.mjs";

function runTask(task, root, payload = {}) {
  if (task === "reports") return buildContextRoomReports(root, { readOnly: true });
  if (task === "context-hub") return contextHubUiState(root, {
    refreshShared: payload.refreshShared !== false,
    refreshGit: payload.refreshGit === true,
    force: payload.force === true,
  });
  if (task === "hosted-shared-repository") {
    throw new Error("Hosted Shared repository refresh requires the supervised process transport");
  }
  if (task === "file-diff") return readFileDiff(root, payload.path || "", { readOnly: true });
  if (task === "review-base") return readReviewBaseFile(root, payload.path || "", { readOnly: true });
  throw new Error(`Unknown background task: ${task}`);
}

function taskResult(task, root, payload = {}) {
  try {
    return { ok: true, value: runTask(task, root, payload) };
  } catch (error) {
    let details;
    try {
      const serialized = error?.details === undefined ? "" : JSON.stringify(error.details);
      if (serialized && Buffer.byteLength(serialized, "utf8") <= 8 * 1024) details = JSON.parse(serialized);
    } catch {}
    const statusCode = Number(error?.statusCode);
    const code = String(error?.code || "");
    return {
      ok: false,
      error: {
        message: String(error?.message || "Background task failed").slice(0, 2_048),
        ...(Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599 ? { statusCode } : {}),
        ...(/^[a-z0-9_-]{1,128}$/.test(code) ? { code } : {}),
        ...(error?.expose === true ? { expose: true } : {}),
        ...(error?.retryable === true ? { retryable: true } : {}),
        ...(details !== undefined ? { details } : {}),
      },
    };
  }
}

if (workerData?.persistent) {
  parentPort.on("message", (message = {}) => {
    parentPort.postMessage({ id: message.id, ...taskResult(message.task, workerData.root, message.payload) });
  });
} else {
  parentPort.postMessage(taskResult(workerData?.task, workerData?.root, workerData?.payload));
}
