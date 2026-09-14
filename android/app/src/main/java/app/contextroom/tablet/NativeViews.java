package app.contextroom.tablet;

import android.os.SystemClock;
import org.json.*;

/** Foreground, opt-in camera exchange. Only the native draw callback produces a receipt. */
final class NativeViews {
  interface Host {
    JSONObject viewTarget();
    JSONArray viewBounds();
    boolean viewBusy();
    boolean frameView(JSONArray bounds);
    void viewNotice(String mode, String message);
  }
  final Host host;
  String mode = "independent", signature = "";
  long sequence, generation, deadline;
  JSONObject pending, receipt;
  NativeViews(Host host) { this.host = host; }
  void setMode(String next) {
    mode = next; generation++; pending = null; receipt = null;
    host.viewNotice(mode, next.equals("share") ? "Vue partagée · affichage distant non confirmé."
      : next.equals("follow") ? "En attente d’une vue partagée depuis le Mac." : "Vues indépendantes.");
  }
  void interaction() { if (mode.equals("follow")) setMode("independent"); }
  JSONObject body() {
    JSONObject target = host.viewTarget(); String currentMode = target == null ? "independent" : mode;
    JSONObject content = InkView.json("mode", currentMode, "target", currentMode.equals("independent") ? JSONObject.NULL : target,
      "viewport", currentMode.equals("share") ? host.viewBounds() : JSONObject.NULL);
    if (!content.toString().equals(signature)) { signature = content.toString(); sequence++; }
    try { content.put("sequence", sequence).put("clientGeneration", generation).put("receipt", currentMode.equals("follow") && receipt != null ? receipt : JSONObject.NULL); }
    catch (JSONException error) { throw new IllegalStateException(error); }
    return content;
  }
  static boolean sameTarget(JSONObject left, JSONObject right) {
    if (left == null || right == null) return false;
    for (String key : new String[]{"projectId", "resourceId", "path", "locationRevision"}) if (!String.valueOf(left.opt(key)).equals(String.valueOf(right.opt(key)))) return false;
    return true;
  }
  void receive(JSONObject data, JSONObject sent) {
    if (data == null || sent == null || sent.optLong("clientGeneration", -1) != generation || !sent.optString("mode").equals(mode)) return;
    if (mode.equals("share")) {
      JSONObject confirmed = data.optJSONObject("receipt");
      host.viewNotice(mode, confirmed != null && confirmed.optLong("sequence", -1) == sent.optLong("sequence") ? "Vue actuelle affichée sur le Mac." : "Vue partagée · affichage distant non confirmé.");
      return;
    }
    if (!mode.equals("follow")) return;
    JSONObject frame = data.optJSONObject("frame");
    if (frame == null || !sameTarget(host.viewTarget(), frame.optJSONObject("target")) || host.viewBusy()) {
      pending = null; host.viewNotice(mode, "En attente d’une vue partagée de ce carnet précis."); return;
    }
    if (receipt != null && receipt.optString("sessionId").equals(frame.optString("sessionId")) && receipt.optLong("sequence") == frame.optLong("sequence")
        && receipt.optJSONArray("viewport").toString().equals(host.viewBounds().toString())) return;
    deadline = SystemClock.elapsedRealtime() + Math.max(0, Math.min(5000, frame.optLong("expiresAt") - data.optLong("serverTime")));
    if (SystemClock.elapsedRealtime() >= deadline) return;
    pending = frame;
    if (!host.frameView(frame.optJSONArray("viewport"))) { pending = null; host.viewNotice(mode, "Ce cadrage ne peut pas être affiché à cette taille."); }
  }
  void rendered() {
    if (pending == null || !mode.equals("follow") || host.viewBusy() || SystemClock.elapsedRealtime() >= deadline || !sameTarget(host.viewTarget(), pending.optJSONObject("target"))) return;
    receipt = InkView.json("sessionId", pending.optString("sessionId"), "sequence", pending.optLong("sequence"), "target", host.viewTarget(), "viewport", host.viewBounds());
    pending = null;
    host.viewNotice(mode, "Vous suivez le Mac · un geste ou un outil arrête le suivi.");
  }
}
