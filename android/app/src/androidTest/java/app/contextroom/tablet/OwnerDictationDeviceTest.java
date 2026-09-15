package app.contextroom.tablet;

import android.app.Instrumentation;
import android.os.SystemClock;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Real native capture/recovery/Whisper transport. Recognition input is explicitly seeded test PCM. */
@RunWith(AndroidJUnit4.class)
public final class OwnerDictationDeviceTest {
  final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
  final OwnerWorkspaceTest ui = new OwnerWorkspaceTest();
  final OwnerAgentDeviceTest controls = new OwnerAgentDeviceTest();
  String text(MainActivity activity) throws Exception { return (String) new JSONTokener(ui.evaluate(activity, "document.querySelector('.assistant-panel textarea').value")).nextValue(); }
  String captureAndSeed(MainActivity activity, byte[] pcm) throws Exception {
    ui.evaluate(activity, "document.querySelector('[data-file-dictate]').click()");
    NativeAudio audio = activity.ownerWorkspace.audio;
    if (activity.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED) ui.systemClick("While using the app");
    NotebookDeviceTest.waitFor("Direct microphone capture did not start", () -> audio.capture != null && audio.file(audio.capture.id, ".pcm").length() >= 6400);
    String id = audio.capture.id;
    controls.button(activity, "Stop audio");
    NotebookDeviceTest.waitFor("Microphone must close before seeding test PCM", () -> audio.capture == null);
    // Only this newly captured synthetic-fixture recording is replaced. The
    // native recording identity and original-source metadata stay unchanged.
    try (FileOutputStream output = new FileOutputStream(audio.file(id, ".pcm"))) { output.write(pcm); output.getFD().sync(); }
    ui.evaluate(activity, "document.querySelector('.assistant-panel button[aria-label=\"Close dictation\"]').click()");
    ui.visible(activity, "!document.querySelector('.assistant-panel')");
    ui.evaluate(activity, "document.querySelector('[data-file-conversation]').click()");
    controls.button(activity, "Recover dictation");
    ui.visible(activity, "[...document.querySelectorAll('.assistant-panel button')].some(n=>n.textContent==='Retry dictation')");
    return id;
  }
  @Test public void realWhisperRecoversTheOriginalNativeRecordingAndRetainsItsReviewedDraft() throws Exception {
    Assume.assumeTrue("Explicit real speech acceptance only", "true".equals(InstrumentationRegistry.getArguments().getString("realSpeech")));
    String sample = InstrumentationRegistry.getArguments().getString("sample");
    if (sample == null || !sample.startsWith("/data/local/tmp/context-room-synthetic-")) throw new IOException("A synthetic PCM fixture is required");
    byte[] pcm = Files.readAllBytes(new File(sample).toPath());
    assertTrue(pcm.length > 0 && pcm.length <= NativeAudio.MAX_BYTES && pcm.length % 2 == 0);
    JSONObject ticket = ui.drawing.fixture();
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      MainActivity activity = ui.drawing.activity(scenario);
      NotebookDeviceTest.waitFor("Notebook engine unavailable", () -> ui.drawing.onUi(activity, () -> activity.engineReady));
      instrumentation.runOnMainSync(() -> activity.pair(ticket));
      NotebookDeviceTest.waitFor("Owner workspace unavailable", () -> ui.drawing.onUi(activity, () -> activity.showingOwner && activity.ownerWorkspace != null));
      try {
        ui.visible(activity, "document.body.dataset.workspaceDiagnostics && JSON.parse(document.body.dataset.workspaceDiagnostics).phase==='ready'");
        ui.evaluate(activity, "[...document.querySelectorAll('a.global-project-row')].find(n=>n.textContent.includes('Owner integration project'))?.click()");
        ui.visible(activity, "document.querySelector('[data-global-project-folder=\"docs\"]')");
        ui.evaluate(activity, "(()=>{const n=document.querySelector('[data-global-project-folder=\"docs\"]');if(n.getAttribute('aria-expanded')!=='true')n.click()})()");
        ui.click(activity, "[data-global-project-file='docs/Guide.md']");
        ui.visible(activity, "document.querySelector('#viewer')?.textContent.includes('Connected owner guide')");
        ui.visible(activity, "document.querySelector('[data-file-dictate]') && !document.querySelector('[data-file-dictate]').disabled");
        NativeAudio audio = activity.ownerWorkspace.audio;
        String id = captureAndSeed(activity, pcm);
        long started = SystemClock.elapsedRealtime(); controls.button(activity, "Retry dictation");
        controls.waitFor("Real Whisper did not return the original source transcript", 90000,
          () -> "true".equals(ui.evaluate(activity, "document.querySelector('.assistant-panel textarea')?.value.toLowerCase().includes('carnet')")));
        long recognizedMs = SystemClock.elapsedRealtime() - started; String transcript = text(activity);
        NotebookDeviceTest.waitFor("Original recording must only be removed after its transcript is saved", () -> !audio.file(id, ".pcm").exists() && !audio.file(id, ".json").exists());
        assertEquals("true", ui.evaluate(activity, "document.querySelector('.assistant-messages').textContent.trim()===''"));
        ui.screenshot(activity, "native-recognized-original-dictation");
        ui.evaluate(activity, "window.oldDictationPage=true"); instrumentation.runOnMainSync(() -> activity.ownerWorkspace.web.reload());
        ui.visible(activity, "!window.oldDictationPage && Boolean(state.projectId && state.ownerMutationNonce)");
        ui.visible(activity, "document.querySelector('#viewer')?.textContent.includes('Connected owner guide')");
        ui.visible(activity, "document.querySelector('[data-file-conversation]') && !document.querySelector('[data-file-conversation]').disabled");
        ui.evaluate(activity, "document.querySelector('[data-file-conversation]').click()");
        ui.visible(activity, "document.querySelector('.assistant-panel')?.dataset.ready==='true'"); assertEquals(transcript, text(activity));
        String silentId = captureAndSeed(activity, new byte[NativeAudio.MAX_BYTES]);
        controls.button(activity, "Retry dictation");
        controls.waitFor("The advertised maximum-size native recording did not finish", 90000,
          () -> "true".equals(ui.evaluate(activity, "document.querySelector('.assistant-info')?.textContent.includes('No speech detected')")));
        assertEquals("Silence cannot add characters to the original draft", transcript, text(activity));
        assertFalse(audio.file(silentId, ".pcm").exists());
        assertEquals("true", ui.evaluate(activity, "document.querySelector('.assistant-messages').textContent.trim()===''"));
        ui.screenshot(activity, "native-dictation-reload-and-maximum");
        JSONObject proof = InkView.json("transcript", transcript, "recognitionMs", recognizedMs, "samplePcmBytes", pcm.length,
          "maximumPcmBytes", NativeAudio.MAX_BYTES, "actualNativeCaptureBeforeSyntheticSubstitution", true,
          "recognitionInput", "synthetic PCM substituted in this fixture's stopped native recording", "reviewedDraftReloaded", true,
          "originalRecordingAcknowledged", true, "silentMaximumPreservedDraft", true, "agentMessages", 0);
        try (FileOutputStream output = new FileOutputStream(new File(activity.getFilesDir(), "native-dictation-proof.json"))) { output.write(proof.toString(2).getBytes(StandardCharsets.UTF_8)); }
      } catch (Throwable failure) {
        System.out.println("Native recognition failure: " + ui.evaluate(activity, "JSON.stringify({body:document.body.innerText.slice(-6000),audio:document.querySelector('.assistant-audio-state')?.textContent})"));
        ui.screenshot(activity, "native-dictation-failure"); throw failure;
      }
    }
  }
}
