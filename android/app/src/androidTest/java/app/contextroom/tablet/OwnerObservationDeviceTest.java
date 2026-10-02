package app.contextroom.tablet;

import android.app.Instrumentation;
import android.os.SystemClock;
import android.view.MotionEvent;
import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.nio.charset.StandardCharsets;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** A real model must identify a native unfinished shape absent from the canonical scene. */
@RunWith(AndroidJUnit4.class)
public final class OwnerObservationDeviceTest {
  final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
  final OwnerAgentDeviceTest agent = new OwnerAgentDeviceTest();
  final OwnerWorkspaceTest ui = agent.ui;
  @Test public void realAgentSeesOnlyTheExplicitOriginalNativePreview() throws Exception {
    Assume.assumeTrue("Explicit real-agent acceptance only", "true".equals(InstrumentationRegistry.getArguments().getString("realAgent")));
    JSONObject ticket = ui.drawing.fixture();
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      MainActivity activity = ui.drawing.activity(scenario);
      NotebookDeviceTest.waitFor("Notebook engine unavailable", () -> ui.drawing.onUi(activity, () -> activity.engineReady));
      instrumentation.runOnMainSync(() -> activity.pair(ticket));
      NotebookDeviceTest.waitFor("Owner workspace unavailable", () -> ui.drawing.onUi(activity, () -> activity.showingOwner && activity.ownerWorkspace != null));
      try {
        ui.visible(activity, "document.body.dataset.workspaceDiagnostics && JSON.parse(document.body.dataset.workspaceDiagnostics).phase==='ready'");
        ui.evaluate(activity, "window.openContextRoomNotebook('docs/Owner.crnb',{projectId:" + JSONObject.quote(ticket.getString("testProjectId")) + "}).then(n=>window.observationNotebook=n)");
        ui.visible(activity, "window.observationNotebook && document.querySelector('.notebook-dialog')?.dataset.saveState==='confirmed'");
        // Preserve this historical native-recovery scenario; it is not common-web performance proof.
        ui.openLegacyRecoveryNotebook(activity, ticket);
        NotebookDeviceTest.waitFor("Native pen unavailable", () -> ui.drawing.onUi(activity, () -> activity.conversationButton != null && activity.conversationButton.isEnabled()));
        instrumentation.runOnMainSync(() -> activity.conversationButton.performClick());
        ui.visible(activity, "document.querySelector('.assistant-panel')?.dataset.ready==='true' && document.querySelector('.assistant-panel')?.dataset.observation==='off'");
        ui.evaluate(activity, "(()=>{const original=window.fetch;window.previewCount=0;window.lastPreview=null;window.fetch=async(...args)=>{const result=await original(...args);if(String(args[0]).endsWith('/observation/frame')&&result.ok){window.previewCount++;window.lastPreview=JSON.parse(args[1].body).frame;}return result;}})()");
        agent.button(activity, "Share live source");
        ui.visible(activity, "document.querySelector('.assistant-panel')?.dataset.observation==='live' && window.previewCount>0");
        ui.evaluate(activity, "window.blankPreview=window.lastPreview.image");
        instrumentation.runOnMainSync(() -> activity.ink.tool = "ellipse");
        long down = SystemClock.uptimeMillis();
        ui.drawing.pen(activity, MotionEvent.ACTION_DOWN, 100, 120, .5f, down);
        ui.drawing.pen(activity, MotionEvent.ACTION_MOVE, 460, 270, .5f, down);
        ui.visible(activity, "window.lastPreview && window.lastPreview.image!==window.blankPreview");
        assertTrue("The actual shape gesture must remain unfinished", ui.drawing.onUi(activity, () -> activity.ink.drawing && activity.lastScene.optJSONArray("objects").length() == 0));
        ui.evaluate(activity, "ContextRoomNativeOwner.observation({projectId:'different-project',source:{kind:'notebook',path:'docs/Owner.crnb'}}).then(()=>window.foreignPreview='allowed',()=>window.foreignPreview='refused')");
        ui.visible(activity, "window.foreignPreview==='refused'");
        long started = SystemClock.elapsedRealtime();
        agent.send(activity, "Lis la scène originale et son aperçu explicitement partagé. Quelle forme géométrique vois-tu dans cet aperçu ? Réponds en un seul mot français. Ne dessine rien et ne propose aucune modification.");
        agent.waitFor("The real observation turn did not complete", 180000, () -> "\"completed\"".equals(agent.operation(activity)));
        String answer = ui.evaluate(activity, "[...document.querySelectorAll('.assistant-messages article')].at(-1).querySelector('p').textContent");
        assertTrue("The answer must identify the visible ellipse: " + answer, answer.toLowerCase(java.util.Locale.ROOT).matches(".*(ellipse|ovale).*"));
        assertTrue("Observation must not commit the human gesture", ui.drawing.onUi(activity, () -> activity.ink.drawing && activity.lastScene.optJSONArray("objects").length() == 0));
        ui.screenshot(activity, "native-original-observation");
        JSONObject proof = InkView.json("answer", answer, "turnMs", SystemClock.elapsedRealtime() - started,
          "conversationId", activity.nativeConversationState.optString("conversationId"), "unfinishedShapeAbsentFromScene", true, "foreignSourceRefused", true);
        ui.drawing.pen(activity, MotionEvent.ACTION_UP, 460, 270, .5f, down);
        NotebookDeviceTest.waitFor("The later human commit did not settle", () -> ui.drawing.onUi(activity, () -> activity.lastScene.optJSONArray("objects").length() == 1 && activity.pendingNative == 0));
        scenario.moveToState(Lifecycle.State.CREATED); SystemClock.sleep(1000); scenario.moveToState(Lifecycle.State.RESUMED);
        ui.visible(activity, "document.querySelector('.assistant-panel')?.dataset.observation==='off'");
        proof.put("backgroundStopsSharingWithoutAutomaticResume", true);
        instrumentation.getUiAutomation().waitForIdle(1000, 5000);
        ui.screenshot(activity, "native-observation-stopped");
        try (FileOutputStream output = new FileOutputStream(new File(activity.getFilesDir(), "native-observation-proof.json"))) { output.write(proof.toString(2).getBytes(StandardCharsets.UTF_8)); }
      } catch (Throwable failure) {
        System.out.println("Native observation failure: " + ui.evaluate(activity, "JSON.stringify({body:document.body.innerText.slice(-6000),observation:document.querySelector('.assistant-panel')?.dataset.observation,frames:window.previewCount})"));
        ui.screenshot(activity, "native-observation-failure"); throw failure;
      }
    }
  }
}
