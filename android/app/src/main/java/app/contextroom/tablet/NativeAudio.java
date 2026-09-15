package app.contextroom.tablet;

import android.Manifest;
import android.content.*;
import android.content.pm.PackageManager;
import android.media.*;
import android.media.audiofx.*;
import android.os.*;
import android.util.Base64;
import android.webkit.ValueCallback;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Consumer;
import org.json.*;

/** Foreground PCM capture and exact PCM playback. Neither path calls an agent.
 * Unacknowledged recordings remain private and bound to their original conversation. */
final class NativeAudio {
  static final int RATE = 16000, MAX_BYTES = RATE * 2 * 120;
  final Context context;
  final Handler main = new Handler(Looper.getMainLooper());
  final ExecutorService inputWorker = Executors.newSingleThreadExecutor(), outputWorker = Executors.newSingleThreadExecutor();
  final Consumer<JSONObject> events;
  final File directory;
  final AudioManager manager;
  volatile boolean closed, foreground = true;
  volatile String epoch = "", scope = "", conversation = "", client = "";
  volatile long expiresAt;
  volatile Capture capture;
  volatile Playback playback;
  AudioFocusRequest focus;
  final Runnable watchdog = new Runnable() { public void run() { if (closed) return; if (expiresAt > 0 && System.currentTimeMillis() >= expiresAt) stop(); main.postDelayed(this, 150); } };

  NativeAudio(Context context, Consumer<JSONObject> events) {
    this.context = context; this.events = events; directory = new File(context.getFilesDir(), "conversation-audio");
    manager = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE); main.post(watchdog);
  }
  static String identity(String value) throws IOException { if (value == null || !value.matches("[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}")) throw new IOException("Identité audio invalide."); return value; }
  static JSONObject error(String message) { return InkView.json("error", message); }
  void result(ValueCallback<JSONObject> reply, JSONObject value) { main.post(() -> reply.onReceiveValue(value)); }
  void emit(String type, String id) { main.post(() -> { if (!closed) events.accept(InkView.json("type", type, "recordingId", id)); }); }
  void bind(JSONObject value) throws Exception {
    String nextEpoch = identity(value.getString("epoch")), nextConversation = identity(value.getString("conversationId")), nextClient = identity(value.getString("clientId"));
    String nextScope = value.getString("scopeKey"); long expiry = value.getLong("expiresAt"), now = System.currentTimeMillis();
    if (closed || !foreground || nextScope.isEmpty() || nextScope.length() > 8192 || expiry <= now || expiry > now + 35000) throw new IOException("Le contrôle audio a expiré.");
    boolean same = nextEpoch.equals(epoch) && nextConversation.equals(conversation) && nextScope.equals(scope) && nextClient.equals(client);
    if (value.optBoolean("renew") && !same) throw new IOException("Une autre surface contrôle l’audio.");
    if (!same) stop();
    epoch = nextEpoch; conversation = nextConversation; client = nextClient; scope = nextScope; expiresAt = expiry;
  }
  void check(JSONObject value) throws IOException {
    if (closed || !foreground || System.currentTimeMillis() >= expiresAt || !epoch.equals(value.optString("epoch")) || !conversation.equals(value.optString("conversationId"))) throw new IOException("Cette surface ne contrôle plus l’audio.");
  }
  void ensureFocus() throws IOException {
    if (focus != null) return;
    AudioFocusRequest request = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
      .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
      .setWillPauseWhenDucked(true).setOnAudioFocusChangeListener(change -> { if (change < 0) { stop(); events.accept(InkView.json("type", "audio-interrupted")); } }, main).build();
    if (manager.requestAudioFocus(request) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) throw new IOException("L’audio est utilisé par une autre application.");
    focus = request;
  }
  File file(String id, String extension) throws IOException { return new File(directory, identity(id) + extension); }
  String scopeHash(String key, String id) throws Exception {
    byte[] digest = MessageDigest.getInstance("SHA-256").digest((key + "\n" + id).getBytes(StandardCharsets.UTF_8));
    StringBuilder result = new StringBuilder(); for (byte b : digest) result.append(String.format(Locale.ROOT, "%02x", b)); return result.toString();
  }
  JSONObject metadata(String id, String key, String originalConversation) throws Exception {
    File metadata = file(id, ".json"); if (!metadata.isFile() || metadata.length() > 12000) throw new IOException("Dictée conservée indisponible.");
    JSONObject value = new JSONObject(new String(Files.readAllBytes(metadata.toPath()), StandardCharsets.UTF_8));
    if (!scopeHash(key, originalConversation).equals(value.optString("scopeHash"))) throw new IOException("Cette dictée appartient à une autre conversation."); return value;
  }
  void recordingResult(String id, String key, String originalConversation, ValueCallback<JSONObject> reply) {
    inputWorker.execute(() -> { try {
      metadata(id, key, originalConversation); File audio = file(id, ".pcm"); long size = audio.length();
      if (!audio.isFile() || size < 2 || size > MAX_BYTES || size % 2 != 0) throw new IOException("La dictée conservée ne contient pas d’audio utilisable.");
      result(reply, InkView.json("recordingId", id, "pcm", Base64.encodeToString(Files.readAllBytes(audio.toPath()), Base64.NO_WRAP), "sampleRate", RATE));
    } catch (Exception failure) { result(reply, error(failure.getMessage())); } });
  }
  void start(JSONObject value, ValueCallback<JSONObject> reply) throws Exception {
    check(value); if (capture != null) throw new IOException("Terminez la dictée en cours.");
    if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) throw new IOException("Autorisez le microphone pour dicter.");
    ensureFocus();
    Capture next = new Capture(UUID.randomUUID().toString(), epoch, scope, conversation); capture = next;
    SpeechEndpoint endpoint = value.optBoolean("voice") ? new SpeechEndpoint() : null;
    inputWorker.execute(() -> {
      AudioRecord recorder = null; AcousticEchoCanceler echo = null; NoiseSuppressor noise = null; boolean announced = false;
      try {
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Le stockage audio est indisponible.");
        try (FileOutputStream metadata = new FileOutputStream(file(next.id, ".json"))) {
          metadata.write(InkView.json("id", next.id, "scopeHash", scopeHash(next.scope, next.conversation), "createdAt", System.currentTimeMillis(), "sampleRate", RATE).toString().getBytes(StandardCharsets.UTF_8)); metadata.getFD().sync();
        }
        int minimum = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (minimum <= 0) throw new IOException("Le microphone ne fournit pas le format requis.");
        recorder = new AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(minimum * 2, 6400));
        if (recorder.getState() != AudioRecord.STATE_INITIALIZED) throw new IOException("Microphone indisponible.");
        try { if (AcousticEchoCanceler.isAvailable()) { echo = AcousticEchoCanceler.create(recorder.getAudioSessionId()); if (echo != null) echo.setEnabled(true); } } catch (RuntimeException unavailable) { if (echo != null) echo.release(); echo = null; }
        try { if (NoiseSuppressor.isAvailable()) { noise = NoiseSuppressor.create(recorder.getAudioSessionId()); if (noise != null) noise.setEnabled(true); } } catch (RuntimeException unavailable) { if (noise != null) noise.release(); noise = null; }
        if (next.finish || !current(next.epoch)) throw new IOException("Le microphone a été arrêté.");
        recorder.startRecording(); if (recorder.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) throw new IOException("Microphone fermé.");
        result(reply, InkView.json("recordingId", next.id, "recording", true, "echoCancellation", echo != null && echo.getEnabled())); announced = true;
        try (FileOutputStream output = new FileOutputStream(file(next.id, ".pcm"))) {
          byte[] buffer = new byte[640]; int size = 0; long synced = SystemClock.elapsedRealtime();
          while (!next.finish && current(next.epoch) && size < MAX_BYTES) {
            int count = recorder.read(buffer, 0, Math.min(buffer.length, MAX_BYTES - size), AudioRecord.READ_BLOCKING);
            if (count < 0 || count % 2 != 0) throw new IOException("La lecture du microphone a été interrompue.");
            if (count == 0) continue; output.write(buffer, 0, count); size += count;
            if (SystemClock.elapsedRealtime() - synced >= 500) { output.getFD().sync(); synced = SystemClock.elapsedRealtime(); }
            if (endpoint != null) {
              String event = endpoint.push(buffer, count);
              if (event != null) { emit(event, next.id); if (event.equals("speech-end")) next.finish = true; }
            }
          }
          output.getFD().sync(); if (size >= MAX_BYTES) emit("recording-limit", next.id);
        }
      } catch (Exception failure) { if (!announced) result(reply, error(failure.getMessage())); else emit("recording-stopped", next.id); }
      finally {
        if (recorder != null) { try { recorder.stop(); } catch (RuntimeException ignored) {} recorder.release(); }
        if (echo != null) echo.release(); if (noise != null) noise.release();
        if (capture == next) capture = null;
        emit("recording-saved", next.id);
      }
    });
  }
  boolean current(String expected) { return !closed && foreground && epoch.equals(expected) && System.currentTimeMillis() < expiresAt; }
  void finish(JSONObject value, ValueCallback<JSONObject> reply) throws Exception {
    String id = identity(value.getString("recordingId")); check(value);
    Capture active = capture; if (active != null && active.id.equals(id)) active.finish = true;
    recordingResult(id, scope, conversation, reply);
  }
  void recover(JSONObject value, ValueCallback<JSONObject> reply) throws Exception {
    String key = value.getString("scopeKey"), originalConversation = identity(value.getString("conversationId"));
    if (key.length() > 8192) throw new IOException("Source audio invalide.");
    if (value.has("recordingId")) { recordingResult(identity(value.getString("recordingId")), key, originalConversation, reply); return; }
    inputWorker.execute(() -> { try {
      JSONArray items = new JSONArray(); File[] files = directory.listFiles((folder, name) -> name.endsWith(".json"));
      if (files != null) for (File candidate : files) {
        if (items.length() >= 64) break;
        String id = candidate.getName().substring(0, candidate.getName().length() - 5);
        try { JSONObject item = metadata(id, key, originalConversation); if (file(id, ".pcm").length() > 0) items.put(InkView.json("recordingId", id, "createdAt", item.optLong("createdAt"))); } catch (Exception otherScope) { /* Another conversation's private recording. */ }
      }
      result(reply, InkView.json("recordings", items));
    } catch (Exception failure) { result(reply, error(failure.getMessage())); } });
  }
  void acknowledge(JSONObject value, ValueCallback<JSONObject> reply) throws Exception {
    String id = identity(value.getString("recordingId")), key = value.getString("scopeKey"), originalConversation = identity(value.getString("conversationId"));
    if (capture != null && capture.id.equals(id)) throw new IOException("La dictée est encore ouverte.");
    inputWorker.execute(() -> { try { metadata(id, key, originalConversation); Files.deleteIfExists(file(id, ".pcm").toPath()); Files.deleteIfExists(file(id, ".json").toPath()); result(reply, InkView.json("acknowledged", true)); }
      catch (Exception failure) { result(reply, error(failure.getMessage())); } });
  }
  void play(JSONObject value, ValueCallback<JSONObject> reply) throws Exception {
    check(value); ensureFocus(); stopPlayback();
    if (value.optInt("sampleRate") != 24000) throw new IOException("Format de lecture indisponible.");
    String encoded = value.getString("pcm"); if (encoded.isEmpty() || encoded.length() > 3840000) throw new IOException("Passage vocal trop long.");
    byte[] bytes = Base64.decode(encoded, Base64.NO_WRAP);
    if (bytes.length % 2 != 0 || !Base64.encodeToString(bytes, Base64.NO_WRAP).equals(encoded)) throw new IOException("Audio invalide.");
    Playback next = new Playback(epoch); playback = next;
    outputWorker.execute(() -> {
      AudioTrack track = null;
      try {
        if (!current(next.epoch) || next.stopped) throw new IOException("Lecture interrompue.");
        int minimum = AudioTrack.getMinBufferSize(24000, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
        track = new AudioTrack.Builder().setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
          .setAudioFormat(new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(24000).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
          .setTransferMode(AudioTrack.MODE_STREAM).setBufferSizeInBytes(Math.max(minimum, 4800)).build(); next.track = track;
        if (track.getState() != AudioTrack.STATE_INITIALIZED) throw new IOException("Sortie audio indisponible."); track.play();
        for (int offset = 0; offset < bytes.length;) {
          if (next.stopped || !current(next.epoch)) throw new IOException("Lecture interrompue.");
          int count = track.write(bytes, offset, Math.min(2400, bytes.length - offset), AudioTrack.WRITE_BLOCKING);
          if (count <= 0) throw new IOException("Lecture audio interrompue."); offset += count;
        }
        long deadline = SystemClock.elapsedRealtime() + 5000;
        while ((track.getPlaybackHeadPosition() & 0xffffffffL) < bytes.length / 2) {
          if (next.stopped || !current(next.epoch) || SystemClock.elapsedRealtime() > deadline) throw new IOException("Lecture interrompue avant la fin."); SystemClock.sleep(20);
        }
        if (next.stopped || !current(next.epoch)) throw new IOException("Lecture interrompue.");
        result(reply, InkView.json("played", true, "sampleRate", 24000, "frames", bytes.length / 2));
      } catch (Exception failure) { result(reply, error(failure.getMessage())); }
      finally { if (track != null) { try { track.stop(); } catch (RuntimeException ignored) {} track.release(); } next.track = null; if (playback == next) playback = null; }
    });
  }
  void stopPlayback() { Playback current = playback; if (current != null) { current.stopped = true; AudioTrack track = current.track; if (track != null) try { track.pause(); track.stop(); track.flush(); } catch (RuntimeException ignored) {} } }
  void stop() { Capture current = capture; if (current != null) current.finish = true; stopPlayback(); expiresAt = 0; if (focus != null) { manager.abandonAudioFocusRequest(focus); focus = null; } }
  void foreground(boolean active) { foreground = active; if (!active) stop(); }
  void close() { closed = true; stop(); main.removeCallbacks(watchdog); inputWorker.shutdown(); outputWorker.shutdown(); }
  static final class Capture { final String id, epoch, scope, conversation; volatile boolean finish; Capture(String id, String epoch, String scope, String conversation) { this.id = id; this.epoch = epoch; this.scope = scope; this.conversation = conversation; } }
  static final class Playback { final String epoch; volatile boolean stopped; volatile AudioTrack track; Playback(String epoch) { this.epoch = epoch; } }
}
