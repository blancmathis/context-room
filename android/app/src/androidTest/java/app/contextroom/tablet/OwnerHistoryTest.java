package app.contextroom.tablet;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public final class OwnerHistoryTest {
  @Test public void originalHistoryUsesTheOwnerTransportAndAndroidFilePicker() throws Exception {
    OwnerWorkspaceTest ui = new OwnerWorkspaceTest(); NotebookDeviceTest drawing = ui.drawing;
    JSONObject ticket = drawing.fixture(), legacy = ticket.getJSONObject("testLegacyHistory");
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      MainActivity activity = drawing.activity(scenario);
      NotebookDeviceTest.waitFor("Notebook engine unavailable", () -> drawing.onUi(activity, () -> activity.engineReady));
      ui.instrumentation.runOnMainSync(() -> activity.pair(ticket));
      NotebookDeviceTest.waitFor("Owner surface did not open", () -> drawing.onUi(activity, () -> activity.showingOwner && activity.ownerWorkspace != null));
      try {
        ui.visible(activity, "document.body?.dataset.workspaceDiagnostics && JSON.parse(document.body.dataset.workspaceDiagnostics).phase === 'ready'");
        ui.evaluate(activity, "[...document.querySelectorAll('a.global-project-row')].find(n => n.textContent.includes('Owner integration project'))?.click()");
        ui.visible(activity, "document.querySelector('[data-global-project-folder=\"docs\"]')");
        ui.evaluate(activity, "(()=>{const n=document.querySelector('[data-global-project-folder=\"docs\"]');if(n.getAttribute('aria-expanded')!=='true')n.click()})()");
        ui.click(activity, "[data-global-project-file='docs/Guide.md']");
        ui.visible(activity, "document.querySelector('#viewer')?.textContent.includes('Connected owner guide')");
        ui.visible(activity, "[...document.querySelectorAll('button')].some(n => n.textContent === 'Discuss')");
        ui.evaluate(activity, "[...document.querySelectorAll('button')].find(n => n.textContent === 'Discuss').click()");
        ui.visible(activity, "document.querySelector('.assistant-panel')?.dataset.ready === 'true'");
        assertEquals(JSONObject.quote(legacy.getString("conversationId")), ui.evaluate(activity, "document.querySelector('[aria-label=\"Saved conversations for this original source\"]').value"));
        ui.click(activity, "[aria-label='Recovered Lisière history'] > details > summary");
        ui.visible(activity, "document.querySelector('[aria-label=\"Recovered Lisière history\"]')?.textContent.includes('Original human question')");
        ui.visible(activity, "document.querySelector('[aria-label=\"Recovered Lisière history\"]')?.textContent.includes('Delivery unconfirmed')");
        assertEquals("true", ui.evaluate(activity, "typeof window.ContextRoomOwnerCredential === 'undefined'"));
        ui.screenshot(activity, "owner-retained-history");
        ui.evaluate(activity, "[...document.querySelectorAll('[aria-label=\"Recovered Lisière history\"] button')].find(n => n.textContent === 'Export original history').click()");
        ui.systemClick("SAVE");
        ui.visible(activity, "document.querySelector('[aria-label=\"Recovered Lisière history\"]')?.textContent.includes('Original history exported.')");
        ui.screenshot(activity, "owner-exported-history");
        assertEquals("\"idle\"", ui.evaluate(activity, "document.querySelector('.assistant-panel').dataset.operationStatus"));
      } catch (Throwable failure) { ui.screenshot(activity, "owner-failure"); throw failure; }
    }
  }
}
