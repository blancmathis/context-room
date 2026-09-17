package app.contextroom.tablet;

import android.app.Instrumentation;
import android.os.SystemClock;
import android.view.MotionEvent;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Opt-in, real Codex through the retained native owner UI. No simulated agent. */
@RunWith(AndroidJUnit4.class)
public final class OwnerAgentDeviceTest {
  final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
  final OwnerWorkspaceTest ui = new OwnerWorkspaceTest();
  void waitFor(String message, long timeout, NotebookDeviceTest.Checked condition) throws Exception {
    long deadline = SystemClock.elapsedRealtime() + timeout;
    while (SystemClock.elapsedRealtime() < deadline) { if (condition.check()) return; SystemClock.sleep(80); }
    fail(message);
  }
  void button(MainActivity activity, String label) throws Exception {
    String selector = "[...document.querySelectorAll('.assistant-panel button')].find(n=>n.textContent===" + JSONObject.quote(label) + ")";
    ui.visible(activity, selector + " && !(" + selector + ").disabled"); ui.evaluate(activity, "(" + selector + ").click()");
  }
  void send(MainActivity activity, String text) throws Exception {
    ui.evaluate(activity, "(()=>{const n=document.querySelector('.assistant-panel textarea');n.value=" + JSONObject.quote(text) + ";n.dispatchEvent(new Event('input',{bubbles:true}))})()");
    button(activity, "Send");
  }
  String operation(MainActivity activity) throws Exception { return ui.evaluate(activity, "document.querySelector('.assistant-panel')?.dataset.operationStatus"); }
  JSONObject snapshot(MainActivity activity) {
    AtomicReference<JSONObject> value = new AtomicReference<>();
    instrumentation.runOnMainSync(() -> value.set(InkView.copy(activity.lastScene))); return value.get();
  }
  void pen(MainActivity activity, float y) {
    long down = SystemClock.uptimeMillis();
    ui.drawing.pen(activity, MotionEvent.ACTION_DOWN, 140, y, .5f, down);
    ui.drawing.pen(activity, MotionEvent.ACTION_MOVE, 200, y + 25, .8f, down);
    ui.drawing.pen(activity, MotionEvent.ACTION_UP, 260, y, .5f, down);
  }
  @Test public void realProgressiveAgentStopsAndRedirectsWhileHumanInkSurvives() throws Exception {
    Assume.assumeTrue("Explicit real-agent acceptance only", "true".equals(InstrumentationRegistry.getArguments().getString("realAgent")));
    JSONObject ticket = ui.drawing.fixture();
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      MainActivity activity = ui.drawing.activity(scenario);
      NotebookDeviceTest.waitFor("Notebook engine unavailable", () -> ui.drawing.onUi(activity, () -> activity.engineReady));
      instrumentation.runOnMainSync(() -> activity.pair(ticket));
      NotebookDeviceTest.waitFor("Owner workspace unavailable", () -> ui.drawing.onUi(activity, () -> activity.showingOwner && activity.ownerWorkspace != null));
      try {
        ui.visible(activity, "document.body.dataset.workspaceDiagnostics && JSON.parse(document.body.dataset.workspaceDiagnostics).phase==='ready'");
        ui.evaluate(activity, "window.openContextRoomNotebook('docs/Owner.crnb',{projectId:" + JSONObject.quote(ticket.getString("testProjectId")) + "}).then(n=>window.nativeAgentNotebook=n)");
        ui.visible(activity, "window.nativeAgentNotebook && document.querySelector('.notebook-dialog')?.dataset.saveState==='confirmed'");
        // Preserve this historical native-recovery scenario; it is not common-web performance proof.
        ui.openLegacyRecoveryNotebook(activity, ticket);
        NotebookDeviceTest.waitFor("Native pen unavailable", () -> ui.drawing.onUi(activity, () -> activity.conversationButton != null && activity.conversationButton.isEnabled()));
        pen(activity, 100);
        NotebookDeviceTest.waitFor("First human stroke unconfirmed", () -> ui.drawing.onUi(activity, () -> activity.lastScene.optJSONArray("objects").length() == 1 && !activity.navigationBusy()));
        instrumentation.runOnMainSync(() -> activity.conversationButton.performClick());
        ui.visible(activity, "document.querySelector('.assistant-panel')?.dataset.ready==='true'");
        ui.evaluate(activity, "(()=>{const original=window.fetch;window.nativeAgentReceipts=0;window.fetch=async(...args)=>{const result=await original(...args);if(String(args[0]).includes('/api/assistant/audio/receipt')&&result.ok)window.nativeAgentReceipts++;return result;}})()");
        long started = SystemClock.elapsedRealtime();
        send(activity, "Lis la scène originale. Dessine seulement un nouveau trait d'encre horizontal avec l'action draw, id verification-agent-line, points [[80,220,0.6],[600,220,0.6]], durée 6000 ms. Conserve toute écriture humaine. Aucun autre ajout. Puis réponds en une courte phrase française.");
        waitFor("The real agent did not produce a visible progressive native tip", 180000,
          () -> ui.drawing.onUi(activity, () -> activity.ink.agentTip != null && activity.ink.agentProgress != null && !activity.ink.agentProgress.optBoolean("completed")));
        long firstUsefulMs = SystemClock.elapsedRealtime() - started;
        JSONObject during = snapshot(activity); ui.screenshot(activity, "native-real-agent-progress");
        pen(activity, 350);
        button(activity, "Stop agent");
        waitFor("The original agent turn did not stop", 30000, () -> "\"stopped\"".equals(operation(activity)));
        NotebookDeviceTest.waitFor("Concurrent human ink was not acknowledged", () -> ui.drawing.onUi(activity, () -> activity.pendingNative == 0 && activity.lastScene.optInt("pending") == 0 && activity.lastScene.optJSONArray("objects").length() == 3));
        JSONObject stopped = snapshot(activity);
        send(activity, "Conserve exactement le trait arrêté et les deux traits humains. Ajoute uniquement une petite ellipse avec id verification-agent-ellipse, x 400, y 320, width 100, height 70. Puis confirme en une courte phrase française, sans rien accepter.");
        waitFor("The redirected real turn did not complete", 180000, () -> "\"completed\"".equals(operation(activity)));
        NotebookDeviceTest.waitFor("The redirected ellipse did not reach the native canvas", () -> ui.drawing.onUi(activity, () -> activity.ink.objects.containsKey("verification-agent-ellipse") && activity.lastScene.optJSONArray("objects").length() == 4));
        instrumentation.runOnMainSync(() -> activity.undoButton.performClick());
        NotebookDeviceTest.waitFor("Selective undo did not preserve agent work", () -> ui.drawing.onUi(activity, () -> activity.lastScene.optJSONArray("objects").length() == 3 && activity.ink.objects.containsKey("verification-agent-ellipse") && activity.ink.objects.containsKey("verification-agent-line")));
        instrumentation.runOnMainSync(() -> activity.redoButton.performClick());
        NotebookDeviceTest.waitFor("Human redo did not settle", () -> ui.drawing.onUi(activity, () -> activity.lastScene.optJSONArray("objects").length() == 4 && activity.lastScene.optInt("pending") == 0));
        android.media.AudioManager manager = activity.ownerWorkspace.audio.manager;
        int volume = manager.getStreamVolume(android.media.AudioManager.STREAM_MUSIC);
        try {
          manager.setStreamVolume(android.media.AudioManager.STREAM_MUSIC, 0, 0);
          button(activity, "Read answer");
          waitFor("The exact real answer did not complete native playback", 90000, () -> "true".equals(ui.evaluate(activity, "window.nativeAgentReceipts>0")));
        } finally { manager.setStreamVolume(android.media.AudioManager.STREAM_MUSIC, volume, 0); }
        assertNull("Read answer cannot open a microphone", activity.ownerWorkspace.audio.capture);
        ui.screenshot(activity, "native-real-agent-complete");
        JSONObject proof = InkView.json("firstUsefulMs", firstUsefulMs, "totalMs", SystemClock.elapsedRealtime() - started,
          "during", during, "stopped", stopped, "final", snapshot(activity), "conversationId", activity.nativeConversationState.optString("conversationId"),
          "playbackReceipts", Integer.parseInt(ui.evaluate(activity, "window.nativeAgentReceipts")));
        try (FileOutputStream output = new FileOutputStream(new File(activity.getFilesDir(), "native-real-agent-proof.json"))) { output.write(proof.toString(2).getBytes(StandardCharsets.UTF_8)); }
      } catch (Throwable failure) {
        System.out.println("Real native agent failure: " + ui.evaluate(activity, "JSON.stringify({body:document.body.innerText.slice(-6000),operation:document.querySelector('.assistant-panel')?.dataset.operationStatus})"));
        ui.screenshot(activity, "native-real-agent-failure"); throw failure;
      }
    }
  }
}
