import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const dir = new URL("../android/app/src/main/java/app/contextroom/tablet/", import.meta.url);

// The Java constant is a concatenation of string literals; JavaScript reads the same literals.
function javaString(file, name) {
  const source = fs.readFileSync(new URL(file, dir), "utf8");
  const match = source.match(new RegExp(`${name}\\s*=\\s*([\\s\\S]*?);\\s*\\n`));
  assert.ok(match, `${name} not found in ${file}`);
  return vm.runInNewContext(match[1]);
}

class FakeEvent { constructor(type, init = {}) { this.type = type; this.cancelable = Boolean(init.cancelable); this.defaultPrevented = false; } preventDefault() { if (this.cancelable) this.defaultPrevented = true; } }
function fakeDialog(name, { refuseCancel = false } = {}) {
  return { name, open: true, closed: 0, dispatchEvent(event) { this.cancelled = true; if (refuseCancel) event.preventDefault(); return !event.defaultPrevented; }, close() { this.closed += 1; this.open = false; } };
}
function runOnPage(script, { dialogs = [], activeElement = null } = {}) {
  const context = { Event: FakeEvent, document: { querySelectorAll: (selector) => (selector === "dialog[open]" ? dialogs.filter((d) => d.open) : []), activeElement } };
  return vm.runInNewContext(script, context);
}

test("Back cancels only the top open dialog and closes it when the dialog allows it", () => {
  const script = javaString("OwnerBack.java", "CLOSE_TOP_DIALOG");
  const under = fakeDialog("under"), top = fakeDialog("top");
  assert.equal(runOnPage(script, { dialogs: [under, top] }), true);
  assert.equal(top.cancelled, true);
  assert.equal(top.closed, 1);
  assert.equal(under.cancelled, undefined);
});

test("Back leaves a dialog open when its own cancel handler refuses, and still consumes the press", () => {
  const script = javaString("OwnerBack.java", "CLOSE_TOP_DIALOG");
  const dialog = fakeDialog("notebook", { refuseCancel: true });
  assert.equal(runOnPage(script, { dialogs: [dialog] }), true);
  assert.equal(dialog.cancelled, true);
  assert.equal(dialog.closed, 0);
  assert.equal(dialog.open, true);
});

test("Back without a dialog reports false so the page history can go back", () => {
  assert.equal(runOnPage(javaString("OwnerBack.java", "CLOSE_TOP_DIALOG"), { dialogs: [] }), false);
});

test("waking drops focus from a text field and leaves other elements alone", () => {
  const script = javaString("OwnerWake.java", "DROP_TEXT_FOCUS");
  const search = { tagName: "INPUT", blurred: 0, blur() { this.blurred += 1; } };
  assert.equal(runOnPage(script, { activeElement: search }), true);
  assert.equal(search.blurred, 1);
  const link = { tagName: "A", blurred: 0, blur() { this.blurred += 1; } };
  assert.equal(runOnPage(script, { activeElement: link }), false);
  assert.equal(link.blurred, 0);
  assert.equal(runOnPage(script, { activeElement: null }), false);
});
