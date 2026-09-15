package app.contextroom.tablet;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Real owner transport and system picker. The fixture contains synthetic PCM;
 * no microphone, recognizer, provider or physical audibility is tested here. */
@RunWith(AndroidJUnit4.class)
public final class OwnerRecordingTest {
  @Test public void explicitOriginalRecordingReviewAndExportNeverAutoplaysOrSends() throws Exception {
    OwnerWorkspaceTest ui = new OwnerWorkspaceTest(); NotebookDeviceTest drawing = ui.drawing;
    JSONObject ticket = drawing.fixture(), recording = ticket.getJSONObject("testRecording");
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
        ui.evaluate(activity, "[...document.querySelectorAll('button')].find(n => n.textContent === 'Discuss').click()");
        ui.visible(activity, "document.querySelector('.assistant-panel')?.dataset.ready === 'true'");
        ui.click(activity, "[aria-label='Recovered recordings'] > details > summary");
        ui.visible(activity, "document.querySelector('[aria-label=\"Recovered recordings\"]')?.textContent.includes('No recording has been explicitly attached')");
        ui.evaluate(activity, "[...document.querySelectorAll('[aria-label=\"Recovered recordings\"] button')].find(n => n.textContent === 'Attach recovered recording').click()");
        ui.evaluate(activity, "document.querySelector('[aria-label=\"Private recovery snapshot directory\"]').value=" + JSONObject.quote(recording.getString("snapshot")));
        ui.evaluate(activity, "document.querySelector('[aria-label=\"Original PCM filename\"]').value=" + JSONObject.quote(recording.getString("name")));
        ui.evaluate(activity, "document.querySelector('[aria-label=\"Recording label\"]').value='Synthetic Android recording'");
        ui.evaluate(activity, "[...document.querySelectorAll('[aria-label=\"Recovered recordings\"] button')].find(n => n.textContent === 'Preview recording link').click()");
        ui.visible(activity, "[...document.querySelectorAll('[aria-label=\"Recovered recordings\"] button')].some(n => n.textContent === 'Attach this exact recording' && !n.hidden && !n.disabled)");
        ui.screenshot(activity, "owner-recording-preview");
        ui.evaluate(activity, "[...document.querySelectorAll('[aria-label=\"Recovered recordings\"] button')].find(n => n.textContent === 'Attach this exact recording').click()");
        ui.visible(activity, "document.querySelector('[aria-label=\"Recovered recordings\"] article strong')?.textContent === 'Synthetic Android recording'");
        ui.evaluate(activity, "[...document.querySelectorAll('[aria-label=\"Recovered recordings\"] button')].find(n => n.textContent === 'Load audio for review').click()");
        ui.visible(activity, "document.querySelector('[aria-label=\"Recovered recordings\"] audio')?.getAttribute('src')?.startsWith('blob:')");
        assertEquals("true", ui.evaluate(activity, "document.querySelector('[aria-label=\"Recovered recordings\"] audio').paused"));
        assertEquals("true", ui.evaluate(activity, "typeof window.ContextRoomOwnerCredential === 'undefined'"));
        ui.screenshot(activity, "owner-recording-loaded");
        ui.evaluate(activity, "[...document.querySelectorAll('[aria-label=\"Recovered recordings\"] button')].find(n => n.textContent === 'Export original PCM').click()");
        ui.systemClick("SAVE");
        ui.visible(activity, "[...document.querySelectorAll('[aria-label=\"Recovered recordings\"] button')].some(n => n.textContent === 'Export original PCM' && !n.disabled)");
        ui.screenshot(activity, "owner-recording-exported");
        assertEquals("\"idle\"", ui.evaluate(activity, "document.querySelector('.assistant-panel').dataset.operationStatus"));
      } catch (Throwable failure) { ui.screenshot(activity, "owner-failure"); throw failure; }
    }
  }
}
