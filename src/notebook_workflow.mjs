/** The notebook document uses the existing proposal engine, not a parallel review lifecycle. */
import { beginLocalProposal, inspectLocalProposal, submitLocalProposal, readLocalProposalFile } from './local_proposals.mjs';
import { readDocumentAssetReview } from './document_assets.mjs';
import { notebookId, notebookActor, failNotebook } from './notebook_protocol.mjs';
import { NOTEBOOK_STORE, freezeNotebook, readFrozenNotebook, recordNotebookSubmission, notebookReceipt, readNotebook } from './notebooks.mjs';
import { notebookHash, readNotebookJson, writeNotebookJson, readNotebookBytes, writeNotebookBytes, withNotebookLock } from './notebook_io.mjs';
import { publishSharedNotebookSnapshot } from './shared_context.mjs';

/** Durable preparation intent handles interruption between begin, workspace write, submit and receipt. */
export function submitNotebookLocal(root, request, { actor, canWrite = () => false } = {}) {
  const { resourceId, operationId, expectedRevision, locationRevision } = request;
  notebookId(resourceId); notebookId(operationId); actor = notebookActor(actor);
  const fingerprint = notebookHash({ request, actor });
  const intentPath = `${NOTEBOOK_STORE}/submissions/${resourceId}/${operationId}.json`;
  return withNotebookLock(root, `${NOTEBOOK_STORE}/submissions/${resourceId}/submit.lock`, () => {
    const scene = readNotebook(root, resourceId);
    if (!canWrite(scene.locator.path)) failNotebook('notebook_path_scope', 'The notebook is outside the editable document scope.');
    let intent = readNotebookJson(root, intentPath);
    if (intent && intent.fingerprint !== fingerprint) failNotebook('notebook_replay_conflict', 'This submission identifier already names another request.');
    if (intent) {
      const receipt = notebookReceipt(root, resourceId, intent.receiptId);
      if (receipt.status === 'submitted') return { ...receipt, requestId: operationId, replayed: true };
    } else {
      const freezeId = `freeze-${notebookHash({ resourceId, operationId }).slice(0, 48)}`;
      const frozen = freezeNotebook(root, { resourceId, operationId: freezeId, expectedRevision, locationRevision }, { actor, canWrite });
      const before = readDocumentAssetReview(root, frozen.path).before;
      intent = { schemaVersion: 1, fingerprint, resourceId, operationId, freezeId, sourceHash: frozen.sourceHash, path: frozen.path,
        sceneRevision: expectedRevision, locationRevision, actor, title: String(request.title || scene.document.title).slice(0, 240),
        preparationId: `notebook-${notebookHash({ resourceId, operationId }).slice(0, 48)}`,
        receiptId: `submit-${notebookHash({ resourceId, operationId }).slice(0, 48)}`,
        before: before ? { data: before.bytes.toString('base64'), hash: before.hash, mode: before.mode } : null };
      writeNotebookJson(root, intentPath, intent, { exclusive: true });
    }
    const snapshot = readFrozenNotebook(root, resourceId, intent.freezeId);
    if (snapshot.sourceHash !== intent.sourceHash || snapshot.locationRevision !== scene.locator.revision) failNotebook('notebook_location_stale', 'The notebook changed location after preparation. Retained work was not overwritten.');
    if (intent.before && notebookHash(Buffer.from(intent.before.data, 'base64')) !== intent.before.hash) failNotebook('notebook_recovery_conflict', 'The retained accepted base is damaged.');
    const prepared = beginLocalProposal(root, { title: intent.title, description: 'Frozen editable notebook. Drawing and autosave do not accept this document.',
      requestId: intent.preparationId, allowedPaths: [intent.path],
      files: intent.before ? [{ path: intent.path, content: Buffer.from(intent.before.data, 'base64'), mode: intent.before.mode }] : [] });
    let proposal = inspectLocalProposal(root, prepared.id);
    if (proposal.status === 'editing') {
      const current = readNotebookBytes(proposal.editRoot, intent.path);
      const currentHash = current ? notebookHash(current) : null;
      if (currentHash !== intent.sourceHash) {
        if (currentHash !== (intent.before?.hash || null)) failNotebook('notebook_submission_conflict', 'The proposal workspace contains a newer edit. No workspace was replaced.');
        writeNotebookBytes(proposal.editRoot, intent.path, snapshot.bytes, { expectedHash: currentHash, mode: intent.before?.mode || 0o644 });
      }
      proposal = submitLocalProposal(root, prepared.id, { canWrite });
    }
    const file = readLocalProposalFile(root, proposal.id, intent.path);
    if (!file.afterBytes || notebookHash(file.afterBytes) !== intent.sourceHash) failNotebook('notebook_submission_conflict', 'The submitted proposal no longer contains the exact frozen notebook.');
    const receipt = recordNotebookSubmission(root, { resourceId, operationId: intent.receiptId, freezeId: intent.freezeId,
      proposalId: proposal.id, proposalRevision: proposal.submittedRevision }, { actor, canWrite,
      verifyProposal: value => value.sourceHash === notebookHash(file.afterBytes) && value.proposalRevision === file.revision && value.path === file.path });
    return { ...receipt, requestId: operationId };
  });
}

/** The same frozen notebook can enter Shared only through its existing proposal engine. */
export function submitNotebookShared(root, request, { actor, canWrite = () => false } = {}) {
  const { resourceId, operationId, expectedRevision, locationRevision } = request;
  notebookId(resourceId); notebookId(operationId); actor = notebookActor(actor);
  const fingerprint = notebookHash({ request, actor });
  const intentPath = `${NOTEBOOK_STORE}/submissions/${resourceId}/${operationId}.json`;
  return withNotebookLock(root, `${NOTEBOOK_STORE}/submissions/${resourceId}/submit.lock`, () => {
    const scene = readNotebook(root, resourceId);
    if (!canWrite(scene.locator.path)) failNotebook('notebook_path_scope', 'The notebook is outside the editable document scope.');
    let intent = readNotebookJson(root, intentPath);
    if (intent && (intent.scope !== 'shared' || intent.fingerprint !== fingerprint)) failNotebook('notebook_replay_conflict', 'This submission identifier already names another request.');
    if (intent) {
      const receipt = notebookReceipt(root, resourceId, intent.receiptId);
      if (receipt.status === 'submitted') return { ...receipt, requestId: operationId, replayed: true };
    } else {
      if (!request.target?.repositoryIdentity || !request.target?.projectId || !request.target?.repositoryPath) failNotebook('notebook_shared_target', 'Inspect the exact Shared destination before submitting this notebook.');
      const submissionId = notebookHash({ root, resourceId, operationId });
      const freezeId = `freeze-${submissionId.slice(0, 48)}`;
      const frozen = freezeNotebook(root, { resourceId, operationId: freezeId, expectedRevision, locationRevision }, { actor, canWrite });
      intent = { schemaVersion: 1, scope: 'shared', fingerprint, resourceId, operationId, submissionId, freezeId,
        receiptId: `submit-${submissionId.slice(0, 48)}`, sourceHash: frozen.sourceHash, path: frozen.path,
        target: request.target, title: String(request.title || scene.document.title).slice(0, 160) };
      writeNotebookJson(root, intentPath, intent, { exclusive: true });
    }
    const snapshot = readFrozenNotebook(root, resourceId, intent.freezeId);
    const canPublish = () => {
      const current = readNotebook(root, resourceId, { includeDocument: false });
      return current.locator.revision === snapshot.locationRevision && current.locator.path === intent.path && canWrite(intent.path);
    };
    if (snapshot.sourceHash !== intent.sourceHash || !canPublish()) failNotebook('notebook_location_stale', 'The frozen notebook changed location or scope. Its retained snapshot was not replaced.');
    const published = publishSharedNotebookSnapshot(root, { submissionId: intent.submissionId, sourcePath: intent.path,
      bytes: snapshot.bytes, target: intent.target, title: intent.title, canPublish });
    const receipt = recordNotebookSubmission(root, { resourceId, operationId: intent.receiptId, freezeId: intent.freezeId,
      scope: 'shared', target: published, proposalId: published.proposalId, proposalRevision: published.proposalRevision }, {
      actor, canWrite, verifyProposal: value => value.sourceHash === published.sourceHash && value.proposalRevision === published.proposalRevision
        && value.proposalId === published.proposalId && value.path === intent.path,
    });
    return { ...receipt, requestId: operationId, replayed: Boolean(published.replayed) };
  });
}

/** A reviewed correction is reconciled explicitly; it never silently overwrites later working gestures. */
export function notebookReviewReconciliation(root, resourceId, freezeId) {
  const scene = readNotebook(root, resourceId), snapshot = readFrozenNotebook(root, resourceId, freezeId);
  const accepted = readDocumentAssetReview(root, snapshot.path).before;
  return { resourceId, path: snapshot.path, frozenHash: snapshot.sourceHash, acceptedHash: accepted?.hash || null,
    workingRevision: scene.revision, frozenRevision: snapshot.sceneRevision, laterWorkingChanges: scene.revision !== snapshot.sceneRevision,
    acceptedMatchesFrozen: accepted?.hash === snapshot.sourceHash, requiresExplicitReconciliation: Boolean(accepted && accepted.hash !== snapshot.sourceHash) };
}
