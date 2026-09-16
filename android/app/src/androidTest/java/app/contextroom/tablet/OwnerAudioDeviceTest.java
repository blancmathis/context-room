package app.contextroom.tablet;

import android.app.Instrumentation;
import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** The production WebView bridge, Android permission dialog and original-source recovery. */
@RunWith(AndroidJUnit4.class)
public final class OwnerAudioDeviceTest {
  final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
  final OwnerWorkspaceTest ui = new OwnerWorkspaceTest();
  @Test public void ownerDictationClosesInBackgroundAndRecoversOnlyInItsOriginalConversation() throws Exception {
    JSONObject ticket = ui.drawing.fixture();
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      MainActivity activity = ui.drawing.activity(scenario);
      NotebookDeviceTest.waitFor("Notebook engine unavailable", () -> ui.drawing.onUi(activity, () -> activity.engineReady));
      instrumentation.runOnMainSync(() -> activity.pair(ticket));
      NotebookDeviceTest.waitFor("Owner surface did not open", () -> ui.drawing.onUi(activity, () -> activity.showingOwner && activity.ownerWorkspace != null));
      try {
        ui.visible(activity, "document.body.dataset.workspaceDiagnostics && JSON.parse(document.body.dataset.workspaceDiagnostics).phase === 'ready'");
        ui.evaluate(activity, "[...document.querySelectorAll('a.global-project-row')].find(n=>n.textContent.includes('Owner integration project'))?.click()");
        ui.visible(activity, "document.querySelector('[data-global-project-folder=\"docs\"]')");
        ui.evaluate(activity, "(()=>{const n=document.querySelector('[data-global-project-folder=\"docs\"]');if(n.getAttribute('aria-expanded')!=='true')n.click()})()");
        ui.click(activity, "[data-global-project-file='docs/Guide.md']");
        ui.visible(activity, "document.querySelector('#viewer')?.textContent.includes('Connected owner guide')");
        ui.visible(activity, "document.querySelector('[data-file-conversation]:not([disabled])')");
        ui.click(activity, "[data-file-conversation]");
        ui.visible(activity, "document.querySelector('.assistant-panel .assistant-origin')?.textContent==='docs/Guide.md'");
        ui.visible(activity, "document.querySelector('.assistant-panel')?.dataset.ready==='true'");
        ui.evaluate(activity, "[...document.querySelectorAll('.assistant-panel button')].find(n=>n.textContent==='Dictate')?.click()");
        ui.permissionClick("While using the app");
        ui.visible(activity, "[...document.querySelectorAll('.assistant-panel button')].some(n=>n.textContent==='Finish dictation')");
        NativeAudio audio = activity.ownerWorkspace.audio;
        NotebookDeviceTest.waitFor("Native microphone did not capture frames", () -> audio.capture != null && audio.file(audio.capture.id, ".pcm").length() >= 6400);
        String id = audio.capture.id;
        ui.screenshot(activity, "owner-audio-recording");
        scenario.moveToState(Lifecycle.State.CREATED);
        NotebookDeviceTest.waitFor("Background audio must close", () -> audio.capture == null); assertEquals(0, audio.expiresAt); assertTrue(audio.file(id, ".pcm").length() >= 6400);
        scenario.moveToState(Lifecycle.State.RESUMED);
        ui.visible(activity, "[...document.querySelectorAll('.assistant-panel button')].some(n=>n.textContent==='Recover dictation' && !n.hidden)");
        ui.evaluate(activity, "[...document.querySelectorAll('.assistant-panel button')].find(n=>n.textContent==='Recover dictation')?.click()");
        ui.visible(activity, "[...document.querySelectorAll('.assistant-panel button')].some(n=>n.textContent==='Retry dictation')");
        String conversationId = ui.evaluate(activity, "document.querySelector('.assistant-panel select').value");
        ui.screenshot(activity, "owner-audio-recovered");
        String pageIdentity = java.util.UUID.randomUUID().toString();
        ui.evaluate(activity, "window.__audioPageBeforeReload=" + JSONObject.quote(pageIdentity));
        instrumentation.runOnMainSync(() -> activity.ownerWorkspace.web.reload());
        ui.visible(activity, "window.__audioPageBeforeReload!==" + JSONObject.quote(pageIdentity) + " && document.body.dataset.workspaceDiagnostics && JSON.parse(document.body.dataset.workspaceDiagnostics).phase === 'ready'");
        ui.visible(activity, "document.querySelector('#viewer')?.textContent.includes('Connected owner guide')");
        ui.evaluate(activity, "[...document.querySelectorAll('button')].find(n=>n.textContent==='Discuss')?.click()");
        ui.visible(activity, "[...document.querySelectorAll('.assistant-panel button')].some(n=>n.textContent==='Retry dictation')");
        ui.visible(activity, "document.querySelector('.assistant-panel')?.dataset.ready==='true' && document.querySelector('.assistant-panel select')?.value===" + conversationId);
        assertEquals(conversationId, ui.evaluate(activity, "document.querySelector('.assistant-panel select').value"));
        assertEquals("Dictation does not send to the agent", "true", ui.evaluate(activity, "document.querySelector('.assistant-messages').textContent.trim()===''"));
        assertTrue("Original audio remains until its text is saved", audio.file(id, ".pcm").isFile());
        ui.evaluate(activity, "[...document.querySelectorAll('.assistant-panel button')].find(n=>n.textContent==='Discard dictation')?.click()");
        ui.visible(activity, "[...document.querySelectorAll('.assistant-panel button')].some(n=>n.textContent==='Voice' && !n.disabled)");
        ui.evaluate(activity, "[...document.querySelectorAll('.assistant-panel button')].find(n=>n.textContent==='Voice')?.click()");
        ui.visible(activity, "document.querySelector('.assistant-panel')?.dataset.voiceState==='listening'");
        NotebookDeviceTest.waitFor("Voice must use the actual native microphone", () -> audio.capture != null && audio.file(audio.capture.id, ".pcm").length() >= 6400);
        scenario.moveToState(Lifecycle.State.CREATED); NotebookDeviceTest.waitFor("Background Voice must close", () -> audio.capture == null);
        scenario.moveToState(Lifecycle.State.RESUMED);
        ui.visible(activity, "document.querySelector('.assistant-panel')?.dataset.voiceState==='off'");
        assertNull("Returning to the app must not restart Voice", audio.capture);
      } catch (Throwable failure) {
        System.out.println("Owner audio state: " + ui.evaluate(activity, "JSON.stringify({status:document.querySelector('#status')?.textContent,assistant:document.querySelector('.assistant-panel')?.textContent,dirty:state.dirty,hash:state.savedHash,selected:state.selected,external:state.externalChange?.source})"));
        ui.screenshot(activity, "owner-audio-failure"); throw failure;
      }
    }
  }
}
