package app.contextroom.tablet;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public final class OwnerDraftTest {
  @Test public void aRecoveredTabletDraftCanBeEditedAndReopenedThroughTheOwnerHub() throws Exception {
    OwnerWorkspaceTest ui = new OwnerWorkspaceTest(); NotebookDeviceTest drawing = ui.drawing;
    JSONObject ticket = drawing.fixture(), draft = ticket.getJSONObject("testTabletDraft");
    String button = "[data-local-draft='" + draft.getString("proposalId") + "']";
    String initial = draft.getString("content").replace("\r\n", "\n"), addition = "\nAdded on the connected Android owner.\n";
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      MainActivity activity = drawing.activity(scenario);
      NotebookDeviceTest.waitFor("Notebook engine unavailable", () -> drawing.onUi(activity, () -> activity.engineReady));
      ui.instrumentation.runOnMainSync(() -> activity.pair(ticket));
      NotebookDeviceTest.waitFor("Owner surface did not open", () -> drawing.onUi(activity, () -> activity.showingOwner && activity.ownerWorkspace != null));
      try {
        ui.visible(activity, "document.body?.dataset.workspaceDiagnostics && JSON.parse(document.body.dataset.workspaceDiagnostics).phase === 'ready'");
        ui.click(activity, button); ui.visible(activity, "document.querySelector('dialog[open] textarea')");
        assertEquals(JSONObject.quote(initial), ui.evaluate(activity, "document.querySelector('dialog[open] textarea').value"));
        assertEquals("true", ui.evaluate(activity, "typeof window.ContextRoomOwnerCredential === 'undefined'"));
        ui.screenshot(activity, "owner-recovered-tablet-draft");
        ui.evaluate(activity, "(()=>{const e=document.querySelector('dialog[open] textarea');e.value += " + JSONObject.quote(addition) + ";e.dispatchEvent(new Event('input',{bubbles:true}))})()");
        ui.visible(activity, "[...document.querySelectorAll('dialog[open] button')].some(n=>n.textContent==='Save draft'&&!n.disabled)");
        ui.evaluate(activity, "[...document.querySelectorAll('dialog[open] button')].find(n=>n.textContent==='Save draft').click()");
        ui.visible(activity, "document.querySelector('dialog[open] [role=status]')?.textContent.includes('Draft saved')");
        ui.evaluate(activity, "[...document.querySelectorAll('dialog[open] button')].find(n=>n.textContent==='Close').click()");
        ui.visible(activity, "!document.querySelector('dialog[open]')");
        ui.evaluate(activity, "window.__draftTestDeparting = true; location.reload()");
        ui.visible(activity, "window.__draftTestDeparting !== true && document.body?.dataset.workspaceDiagnostics && JSON.parse(document.body.dataset.workspaceDiagnostics).phase === 'ready'");
        ui.click(activity, button); ui.visible(activity, "document.querySelector('dialog[open] textarea')");
        assertEquals(JSONObject.quote(initial + addition), ui.evaluate(activity, "document.querySelector('dialog[open] textarea').value"));
        ui.screenshot(activity, "owner-saved-tablet-draft");
      } catch (Throwable failure) { ui.screenshot(activity, "owner-failure"); throw failure; }
    }
  }
}
