const node = (tag, text = "") => Object.assign(document.createElement(tag), { textContent: text });

export async function openReviewCleanup({ api, onChange }) {
  const state = await api("/api/review-cleanup");
  const dialog = node("dialog"); dialog.setAttribute("aria-label", "Review cleanup");
  dialog.style.cssText = "width:min(680px,calc(100vw - 32px));max-height:85dvh;padding:24px;background:var(--surface-floating);color:var(--text);border:1px solid var(--line);border-radius:12px";
  const heading = node("h2", "Review cleanup"), explanation = node("p", "Pending changes are kept indefinitely unless you refuse them or enable a rule. Refusal restores direct edits with a recovery copy; isolated proposals leave originals unchanged.");
  const days = node("input"); days.type = "number"; days.min = "1"; days.max = "36500"; days.value = String(state.policy.days);
  const daysLabel = node("label", "Older than (days) "); daysLabel.append(days);
  const project = node("select"); project.setAttribute("aria-label", "Cleanup project");
  const all = node("option", "All projects"); all.value = ""; project.append(all);
  for (const item of state.projects) { const option = node("option", item.title); option.value = item.id; project.append(option); }
  if (state.policy.projectIds.length === 1) project.value = state.policy.projectIds[0];
  if (state.policy.projectIds.length > 1 || state.policy.projectIds.length === 1 && !state.projects.some(item => item.id === state.policy.projectIds[0])) {
    const saved = node("option", `${state.policy.projectIds.length} saved projects`); saved.value = "__saved_scope__"; project.append(saved); project.value = saved.value;
  }
  const enabled = node("input"); enabled.type = "checkbox"; enabled.checked = state.policy.enabled;
  const enabledLabel = node("label", " Automatically refuse older changes in this scope"); enabledLabel.prepend(enabled);
  const ageNote = node("p", "Age starts at submission or when Context Room observed this version. Unknown history is not treated as old. Active drafts and unavailable Shared proposals are excluded.");
  const preview = node("button", "Preview older changes"), apply = node("button", "Refuse these changes"), save = node("button", "Save automatic rule"), close = node("button", "Close");
  apply.hidden = true;
  const result = node("div"); result.setAttribute("role", "status");
  const list = node("ul"), controls = node("div"); controls.style.cssText = "display:flex;flex-wrap:wrap;gap:12px;align-items:center";
  controls.append(daysLabel, project, preview);
  const footer = node("div"); footer.style.cssText = "display:flex;flex-wrap:wrap;gap:12px;justify-content:flex-end;margin-top:20px"; footer.append(close, save, apply);
  dialog.append(heading, explanation, controls, ageNote, enabledLabel, result, list, footer);
  if (state.receipts?.length) {
    const history = node("details"), summary = node("summary", "Recent cleanup results"); history.append(summary);
    for (const receipt of state.receipts) {
      history.append(node("p", `${receipt.at} · ${receipt.automatic ? "Automatic" : "Manual"} · ${receipt.applied} refused · ${receipt.errors.length} errors${receipt.processing ? " · interrupted operation" : ""}`));
      for (const error of receipt.errors) history.append(node("p", error.message));
    }
    dialog.append(history);
  }
  document.body.append(dialog); dialog.showModal();
  let plan = null, busy = false;
  const selection = () => ({ days: Number(days.value), projectIds: project.value === "__saved_scope__" ? state.policy.projectIds : project.value ? [project.value] : [] });
  const post = (url, body) => api(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const invalidate = () => { plan = null; apply.hidden = true; list.replaceChildren(); };
  days.addEventListener("input", invalidate); project.addEventListener("change", invalidate);
  const perform = async (operation) => {
    if (busy) return; busy = true;
    for (const field of [days, project, enabled, preview, apply, save, close]) field.disabled = true;
    try { await operation(); } catch (error) { result.textContent = error.message; }
    finally { busy = false; for (const field of [days, project, enabled, preview, apply, save, close]) field.disabled = false; }
  };
  preview.addEventListener("click", () => perform(async () => {
    plan = await post("/api/review-cleanup/preview", selection());
    list.replaceChildren(...plan.items.map((item) => node("li", `${item.title} · ${item.kind}`)));
    result.textContent = `${plan.items.length} changes match this exact selection.`;
    apply.hidden = !plan.items.length;
  }));
  apply.addEventListener("click", () => perform(async () => {
    if (!plan) return;
    const outcome = await post("/api/review-cleanup/apply", { ...selection(), expectedRevision: plan.revision });
    result.textContent = `${outcome.applied.length} refused. ${outcome.errors.length} require attention.`;
    invalidate();
    list.replaceChildren(...outcome.errors.map((item) => node("li", item.message)));
    await onChange();
  }));
  save.addEventListener("click", () => perform(async () => {
    await post("/api/review-cleanup/policy", { ...selection(), enabled: enabled.checked });
    result.textContent = enabled.checked ? "Automatic refusal is enabled for this scope. It runs during available app refreshes." : "Automatic refusal is disabled. Pending changes are kept indefinitely.";
    await onChange();
  }));
  close.addEventListener("click", () => { if (!busy) dialog.close(); });
  dialog.addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
}
