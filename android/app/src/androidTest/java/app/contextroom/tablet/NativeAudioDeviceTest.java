package app.contextroom.tablet;

import android.Manifest;
import android.app.Instrumentation;
import android.os.SystemClock;
import android.util.Base64;
import android.webkit.ValueCallback;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.nio.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Actual emulator AudioRecord/AudioTrack and private recovery, not a physical microphone proof. */
@RunWith(AndroidJUnit4.class)
public final class NativeAudioDeviceTest {
  final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
  interface Request { void run(ValueCallback<JSONObject> response) throws Exception; }
  JSONObject request(Request request) throws Exception {
    AtomicReference<JSONObject> answer = new AtomicReference<>(); AtomicReference<Exception> failure = new AtomicReference<>(); CountDownLatch done = new CountDownLatch(1);
    instrumentation.runOnMainSync(() -> { try { request.run(value -> { answer.set(value); done.countDown(); }); } catch (Exception error) { failure.set(error); done.countDown(); } });
    assertTrue("Native audio did not finish", done.await(15, TimeUnit.SECONDS)); if (failure.get() != null) throw failure.get(); return answer.get();
  }
  @Test public void speechEndpointRequiresSustainedSpeechAndDetectsQuiet() {
    byte[] voiced = new byte[640], quiet = new byte[640];
    for (int i = 0; i < voiced.length; i += 2) { voiced[i] = 0; voiced[i + 1] = 12; }
    SpeechEndpoint endpoint = new SpeechEndpoint();
    for (int i = 0; i < 5; i++) assertNull(endpoint.push(voiced, voiced.length));
    assertFalse(endpoint.started); endpoint.push(quiet, quiet.length);
    for (int i = 0; i < 5; i++) assertNull(endpoint.push(voiced, voiced.length));
    assertEquals("speech-start", endpoint.push(voiced, voiced.length));
    for (int i = 0; i < 59; i++) assertNull(endpoint.push(quiet, quiet.length));
    assertEquals("speech-end", endpoint.push(quiet, quiet.length));
    SpeechEndpoint idle = new SpeechEndpoint();
    for (int i = 0; i < 749; i++) assertNull(idle.push(quiet, quiet.length));
    assertEquals("speech-end", idle.push(quiet, quiet.length)); assertFalse(idle.started);
  }
  @Test public void actualPcmAudioAndPrivateRecoveryHonorForegroundAndEpoch() throws Exception {
    instrumentation.getUiAutomation().grantRuntimePermission(instrumentation.getTargetContext().getPackageName(), Manifest.permission.RECORD_AUDIO);
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      AtomicReference<NativeAudio> reference = new AtomicReference<>();
      scenario.onActivity(activity -> reference.set(new NativeAudio(activity, event -> {}))); NativeAudio audio = reference.get();
      String conversation = UUID.randomUUID().toString(), epoch = UUID.randomUUID().toString(), scope = "synthetic-audio-origin";
      JSONObject lease = InkView.json("epoch", epoch, "conversationId", conversation, "clientId", UUID.randomUUID().toString(), "scopeKey", scope, "expiresAt", System.currentTimeMillis() + 30000);
      try {
        request(reply -> { audio.bind(lease); reply.onReceiveValue(InkView.json("bound", true)); });
        JSONObject started = request(reply -> audio.start(lease, reply)); assertFalse(started.toString(), started.has("error"));
        String id = started.getString("recordingId"); SystemClock.sleep(300);
        JSONObject recording = request(reply -> audio.finish(InkView.json("epoch", epoch, "conversationId", conversation, "recordingId", id), reply));
        assertFalse(recording.toString(), recording.has("error")); byte[] bytes = Base64.decode(recording.getString("pcm"), Base64.NO_WRAP);
        assertTrue("Real PCM frames are required", bytes.length >= 3200); assertEquals(0, bytes.length % 2); assertEquals(16000, recording.getInt("sampleRate"));
        JSONObject wrongScope = request(reply -> audio.recover(InkView.json("scopeKey", "another-origin", "conversationId", conversation, "recordingId", id), reply));
        assertTrue("Recovery cannot retarget a recording", wrongScope.has("error"));
        JSONObject recovered = request(reply -> audio.recover(InkView.json("scopeKey", scope, "conversationId", conversation, "recordingId", id), reply)); assertEquals(recording.getString("pcm"), recovered.getString("pcm"));
        ByteBuffer tone = ByteBuffer.allocate(24000).order(ByteOrder.LITTLE_ENDIAN);
        for (int n = 0; n < 12000; n++) tone.putShort((short) (Math.sin(n * 2 * Math.PI * 440 / 24000) * 1200));
        JSONObject played = request(reply -> audio.play(InkView.json("epoch", epoch, "conversationId", conversation, "sampleRate", 24000, "pcm", Base64.encodeToString(tone.array(), Base64.NO_WRAP)), reply));
        assertTrue(played.toString(), played.optBoolean("played")); assertEquals(12000, played.getInt("frames"));
        JSONObject second = request(reply -> audio.start(lease, reply)); assertFalse(second.toString(), second.has("error")); SystemClock.sleep(250);
        request(reply -> { audio.foreground(false); reply.onReceiveValue(InkView.json("stopped", true)); });
        NotebookDeviceTest.waitFor("Background microphone must close", () -> audio.capture == null); assertEquals(0, audio.expiresAt);
        JSONObject retained = request(reply -> audio.recover(InkView.json("scopeKey", scope, "conversationId", conversation, "recordingId", second.getString("recordingId")), reply));
        assertFalse(retained.toString(), retained.has("error"));
        try { request(reply -> audio.start(lease, reply)); fail("Background capture cannot restart"); } catch (java.io.IOException expected) { /* Foreground gate. */ }
        request(reply -> { audio.foreground(true); JSONObject fresh = new JSONObject(lease.toString()); fresh.put("epoch", UUID.randomUUID().toString()); fresh.put("expiresAt", System.currentTimeMillis() + 30000); audio.bind(fresh); reply.onReceiveValue(new JSONObject()); });
        try { request(reply -> audio.start(lease, reply)); fail("An old epoch cannot capture"); } catch (java.io.IOException expected) { /* Epoch gate. */ }
        for (String completed : new String[]{id, second.getString("recordingId")}) {
          JSONObject acknowledged = request(reply -> audio.acknowledge(InkView.json("scopeKey", scope, "conversationId", conversation, "recordingId", completed), reply)); assertTrue(acknowledged.toString(), acknowledged.optBoolean("acknowledged"));
        }
        JSONObject empty = request(reply -> audio.recover(InkView.json("scopeKey", scope, "conversationId", conversation), reply)); assertEquals(0, empty.getJSONArray("recordings").length());
      } finally { instrumentation.runOnMainSync(audio::close); }
    }
  }
}
