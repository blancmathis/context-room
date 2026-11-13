// R5 review banner, loaded by app.mjs on the first Accept or Reject of a doc still in « To review ».
// Accept: the shown version becomes the review base, then it is marked verified (as the review flow does).
// Reject: the Hub rejects the item (the doc goes back to its accepted version, with a recovery copy).
// Without a Hub item (one project served alone), the review view of the doc decides.
export async function decideDocReview(action, app) {
  const { state } = app;
  const path = state.selected;
  if (!path || state.dirty) return;
  const buttons = [...document.querySelectorAll("[data-doc-review]")];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    if (action === "accept") {
      const requests = app.reviewFlowDecisionRequests(app.reviewFlowDecisionFor({ id: path }, "verified", { diskHash: state.savedHash }));
      app.setStatus("accepting · " + path);
      await app.api(...requests.baseline);
      await app.api(...requests.review);
      state.reviewHistoryStale = true;
    } else {
      const item = app.contextHubReviewItems().find((entry) => entry.type === "local" && entry.localFile === path && entry.projectId === state.activeProjectLocationId);
      if (!item) return await app.openContextHubLocalReview({ path });
      await app.rejectContextRoomReviews([item]);
    }
    state.docqa = await app.api("/api/docqa");
    app.renderFiles({ force: true });
    if (state.selected !== path) return;
    // Read the file again: after a reject its text changed; the banner leaves with the queue entry.
    await app.selectFile(path, { pushHistory: false, revealInExplorer: false, forceReload: true });
    app.setStatus((action === "accept" ? "accepted · " : "rejected · ") + path);
  } catch (error) {
    app.setStatus((error?.code === "review_revision_conflict" ? "a newer version is waiting · " : "") + (error?.message || error));
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}
