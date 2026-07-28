import { parentPort, workerData } from "node:worker_threads";

import {
  buildContextRoomReports,
  contextHubUiState,
  readFileDiff,
  readReviewBaseFile,
} from "./context_room.mjs";

function runTask(task, root, payload = {}) {
  if (task === "reports") return buildContextRoomReports(root);
  if (task === "context-hub") return contextHubUiState(root, {
    refreshShared: payload.refreshShared !== false,
    refreshGit: payload.refreshGit === true,
    force: payload.force === true,
  });
  if (task === "file-diff") return readFileDiff(root, payload.path || "");
  if (task === "review-base") return readReviewBaseFile(root, payload.path || "");
  throw new Error(`Unknown background task: ${task}`);
}

function taskResult(task, root, payload = {}) {
  try {
    return { ok: true, value: runTask(task, root, payload) };
  } catch (error) {
    return { ok: false, error: error?.message || "Background task failed" };
  }
}

if (workerData?.persistent) {
  parentPort.on("message", (message = {}) => {
    parentPort.postMessage({ id: message.id, ...taskResult(message.task, workerData.root, message.payload) });
  });
} else {
  parentPort.postMessage(taskResult(workerData?.task, workerData?.root, workerData?.payload));
}
