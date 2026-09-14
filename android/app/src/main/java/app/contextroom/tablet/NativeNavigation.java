package app.contextroom.tablet;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import java.util.UUID;
import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;
import org.json.*;

/** Foreground native navigation. A network command never counts as a rendered canvas. */
final class NativeNavigation {
  interface Host {
    boolean navigationBusy();
    void remoteOpen(JSONObject target);
    void navigationNotice(String message);
    JSONObject viewState();
    void receiveView(JSONObject data, JSONObject sent);
    void viewFailure();
  }
  final Handler main = new Handler(Looper.getMainLooper());
  final Executor network;
  final Host host;
  DeviceConnection connection;
  String session = UUID.randomUUID().toString();
  JSONObject command, receipt;
  long deadline;
  int generation;
  boolean foreground, closed, running, opening, deferred;
  final Runnable tick = this::poll;

  NativeNavigation(Executor network, Host host) { this.network = network; this.host = host; }
  void connect(DeviceConnection selected) {
    if (connection == selected) return;
    generation++; connection = selected; session = UUID.randomUUID().toString();
    command = null; receipt = null; opening = false; deferred = false; running = false;
    schedule(0);
  }
  void foreground(boolean value) { foreground = value; if (value) schedule(0); else main.removeCallbacks(tick); }
  void close() { closed = true; generation++; main.removeCallbacks(tick); }
  void schedule(long delay) {
    main.removeCallbacks(tick);
    if (!closed && foreground && connection != null && !running) main.postDelayed(tick, delay);
  }
  String operation(JSONObject value) { return value == null ? "" : value.optString("operationId"); }

  void poll() {
    if (closed || !foreground || connection == null || running) return;
    final DeviceConnection selected = connection; final int run = generation;
    final JSONObject sent = receipt;
    final JSONObject body = sent == null ? InkView.json("protocolVersion", 1, "clientSessionId", session, "busy", host.navigationBusy(), "view", host.viewState()) : sent;
    running = true;
    try {
      network.execute(() -> {
        JSONObject answer = null;
        try { answer = selected.navigation(sent == null ? "poll" : "receipt", body); } catch (Exception ignored) { /* Retry the same receipt; edits have their own durable journal. */ }
        final JSONObject result = answer;
        main.post(() -> {
          if (closed || run != generation || selected != connection) return;
          running = false;
          if (result != null) {
            int status = result.optInt("status"); JSONObject data = result.optJSONObject("body");
            if (sent != null) {
              if (status >= 200 && status < 300 || status >= 400 && status < 500 && status != 429) {
                if (receipt == sent) receipt = null;
                if (operation(command).equals(operation(sent)) && (!sent.optString("status").equals("deferred") || status >= 400)) clearCommand();
              }
            } else if (status == 200 && data != null && data.optInt("protocolVersion") == 1 && selected.serverId.equals(data.optString("serverId"))
                && selected.session.optJSONObject("device").optString("id").equals(data.optString("deviceId")) && session.equals(data.optString("clientSessionId"))) {
              receive(data);
              host.receiveView(data.optJSONObject("view"), body.optJSONObject("view"));
            } else if (status == 401 || status == 403 || status == 409) { clearCommand(); host.viewFailure(); }
          }
          schedule(receipt != null && result != null ? 0 : result == null ? 3000 : 1200);
        });
      });
    } catch (RejectedExecutionException error) { running = false; schedule(1500); }
  }

  void clearCommand() { command = null; opening = false; deferred = false; }
  void receive(JSONObject data) {
    JSONObject next = data.optJSONObject("command");
    if (next == null) { clearCommand(); return; }
    if (!next.optString("action").equals("open") || !session.equals(next.optString("clientSessionId")) || next.optJSONObject("target") == null) return;
    if (!operation(next).equals(operation(command))) {
      clearCommand(); command = next;
      // Compare server times to avoid depending on a tablet's wall-clock offset.
      deadline = SystemClock.elapsedRealtime() + Math.max(0, Math.min(30000, next.optLong("expiresAt") - data.optLong("serverTime")));
    }
    if (SystemClock.elapsedRealtime() >= deadline) { clearCommand(); return; }
    if (!foreground || receipt != null || opening) return;
    if (host.navigationBusy()) {
      if (!deferred) { deferred = true; report("deferred", null); host.navigationNotice("Ouverture demandée depuis le Mac · en attente de la fin du geste ou de la saisie."); }
      return;
    }
    opening = true;
    host.remoteOpen(InkView.copy(command.optJSONObject("target")));
  }
  void report(String status, JSONObject target) {
    if (command == null) return;
    receipt = InkView.json("protocolVersion", 1, "clientSessionId", session, "operationId", operation(command), "status", status);
    if (target != null) { try { receipt.put("target", target); } catch (JSONException impossible) { throw new IllegalStateException(impossible); } }
    schedule(0);
  }
  void interaction() {
    if (command != null && (receipt == null || receipt.optString("status").equals("deferred"))) { report("cancelled", null); host.navigationNotice("Vous avez repris la main sur la tablette."); }
  }
  void unavailable() { if (opening && receipt == null) report("unavailable", null); }
  void rendered(JSONObject scene) {
    if (!foreground || !opening || command == null || receipt != null || scene == null || scene.optBoolean("offline") || SystemClock.elapsedRealtime() >= deadline) return;
    JSONObject target = command.optJSONObject("target");
    for (String key : new String[]{"projectId", "resourceId", "path", "locationRevision"}) if (!String.valueOf(target.opt(key)).equals(String.valueOf(scene.opt(key)))) return;
    if (scene.optLong("sceneRevision", -1) < target.optLong("sceneRevision")) return;
    JSONObject applied = InkView.copy(target);
    try { applied.put("sceneRevision", scene.getLong("sceneRevision")); } catch (JSONException error) { return; }
    report("applied", applied);
  }
}
