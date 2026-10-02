package app.contextroom.tablet;

import android.app.Instrumentation;
import android.os.SystemClock;
import android.view.MotionEvent;
import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Actual foreground microphone and native stylus, with one retained owner workspace. */
@RunWith(AndroidJUnit4.class)
public final class OwnerNotebookConversationDeviceTest {
  final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
  final OwnerWorkspaceTest ui = new OwnerWorkspaceTest();
  @Test public void voiceAndNativePenShareTheOriginalNotebookAndRetainTheOwnerWorkspace() throws Exception {
    JSONObject ticket = ui.drawing.fixture();
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      MainActivity activity = ui.drawing.activity(scenario);
      NotebookDeviceTest.waitFor("Notebook engine unavailable", () -> ui.drawing.onUi(activity, () -> activity.engineReady));
      instrumentation.runOnMainSync(() -> activity.pair(ticket));
      NotebookDeviceTest.waitFor("Owner workspace did not open", () -> ui.drawing.onUi(activity, () -> activity.showingOwner && activity.ownerWorkspace != null));
      try {
        ui.visible(activity, "document.body.dataset.workspaceDiagnostics && JSON.parse(document.body.dataset.workspaceDiagnostics).phase==='ready'");
        ui.evaluate(activity, "window.openContextRoomNotebook('docs/Owner.crnb',{projectId:" + JSONObject.quote(ticket.getString("testProjectId")) + "}).then(n=>window.nativeConversationNotebook=n)");
        ui.visible(activity, "window.nativeConversationNotebook && document.querySelector('.notebook-dialog')?.dataset.saveState==='confirmed'");
        // Preserve this historical native-recovery scenario; it is not common-web performance proof.
        ui.openLegacyRecoveryNotebook(activity, ticket);
        NotebookDeviceTest.waitFor("Native pen was not ready", () -> ui.drawing.onUi(activity, () -> activity.ink != null && activity.journal != null && activity.conversationButton != null && activity.conversationButton.isEnabled()));
        instrumentation.runOnMainSync(() -> activity.voiceButton.performClick());
        ui.permissionClick("While using the app");
        ui.visible(activity, "document.body.classList.contains('context-room-native-conversation') && document.querySelector('.assistant-panel')?.dataset.ready==='true'");
        NotebookDeviceTest.waitFor("The native notebook binding was not confirmed", () -> ui.drawing.onUi(activity, () -> activity.nativeConversationState != null));
        assertTrue(ui.drawing.onUi(activity, () -> activity.nativeConversationState.optJSONObject("source").optString("resourceId").equals(activity.lastScene.optString("resourceId"))));
        ui.visible(activity, "document.querySelector('.assistant-panel')?.dataset.voiceState==='listening'");
        NativeAudio audio = activity.ownerWorkspace.audio;
        NotebookDeviceTest.waitFor("Voice did not open the native microphone", () -> audio.capture != null && audio.file(audio.capture.id, ".pcm").length() >= 6400);
        long down = SystemClock.uptimeMillis();
        ui.drawing.pen(activity, MotionEvent.ACTION_DOWN, 140, 100, .5f, down);
        ui.drawing.pen(activity, MotionEvent.ACTION_MOVE, 240, 145, .8f, down);
        ui.drawing.pen(activity, MotionEvent.ACTION_UP, 300, 175, .6f, down);
        NotebookDeviceTest.waitFor("Native ink was not acknowledged while listening", () -> ui.drawing.onUi(activity, () -> activity.pendingNative == 0 && activity.lastScene.optJSONArray("objects").length() == 1 && activity.lastScene.optInt("pending") == 0));
        assertNotNull("Native capture must stay open while the stylus writes", audio.capture);
        assertTrue("Remote navigation must preserve the active conversation", ui.drawing.onUi(activity, activity::navigationBusy));
        ui.screenshot(activity, "native-voice-and-pen");
        scenario.moveToState(Lifecycle.State.CREATED); NotebookDeviceTest.waitFor("Background Voice must close", () -> audio.capture == null);
        scenario.moveToState(Lifecycle.State.RESUMED); ui.visible(activity, "document.querySelector('.assistant-panel')?.dataset.voiceState==='off'");
        instrumentation.runOnMainSync(() -> activity.dictateButton.performClick());
        ui.visible(activity, "document.querySelector('.assistant-panel')?.dataset.mode==='dictate' && document.querySelector('.assistant-panel')?.dataset.capturing==='true'");
        NotebookDeviceTest.waitFor("Direct native dictation did not capture", () -> audio.capture != null && audio.file(audio.capture.id, ".pcm").length() >= 6400);
        ui.screenshot(activity, "native-direct-dictation");
        ui.evaluate(activity, "document.querySelector('.assistant-panel button[aria-label=\"Close dictation\"]').click()");
        NotebookDeviceTest.waitFor("Closing direct dictation must return to the native pen and stop the microphone", () -> ui.drawing.onUi(activity, () -> !activity.showingConversation && activity.ink != null) && audio.capture == null);
        instrumentation.runOnMainSync(() -> activity.conversationButton.performClick());
        ui.visible(activity, "document.querySelector('.assistant-panel')?.dataset.ready==='true' && document.querySelector('.assistant-panel')?.dataset.mode==='text'");
        ui.evaluate(activity, "(()=>{const n=document.querySelector('.assistant-panel textarea');n.value='Keep this original notebook draft.';n.dispatchEvent(new Event('input',{bubbles:true}))})()");
        NotebookDeviceTest.waitFor("Original draft state not retained", () -> ui.drawing.onUi(activity, () -> activity.nativeConversationState != null && activity.nativeConversationState.optBoolean("hasDraft")));
        instrumentation.runOnMainSync(activity::onBackPressed);
        assertTrue(ui.drawing.onUi(activity, () -> !activity.showingConversation && activity.ink != null));
        instrumentation.runOnMainSync(activity::onBackPressed);
        NotebookDeviceTest.waitFor("The owner workspace was not retained", () -> ui.drawing.onUi(activity, () -> activity.showingOwner && activity.ink == null));
        ui.visible(activity, "document.querySelector('.notebook-dialog[open]') && document.querySelector('.notebook-state [role=status]')?.textContent.includes('1 objects')");
        assertEquals("true", ui.evaluate(activity, "document.querySelector('.assistant-panel textarea')?.value==='Keep this original notebook draft.'"));
        assertEquals("No agent call without a spoken phrase or explicit send", "true", ui.evaluate(activity, "document.querySelector('.assistant-messages').textContent.trim()===''"));
        ui.screenshot(activity, "native-conversation-retained-owner");
      } catch (Throwable failure) {
        System.out.println("Native conversation failure: " + ui.evaluate(activity, "JSON.stringify({body:document.body.innerText.slice(-5000),dialogs:[...document.querySelectorAll('dialog')].map(n=>[n.className,n.open])})"));
        ui.screenshot(activity, "native-conversation-failure"); throw failure;
      }
    }
  }
}
