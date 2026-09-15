package app.contextroom.tablet;

import android.content.Context;
import android.util.AtomicFile;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.json.*;

/** Small write-ahead queue between pen input and the shared IndexedDB client.
 * The head leaves only after the matching operation and watermark commit together. */
final class NativeCommandJournal {
  final AtomicFile file;
  final JSONObject scope;
  JSONObject state;
  NativeCommandJournal(Context context, JSONObject scope) throws Exception {
    this.scope = InkView.copy(scope);
    String key = scope.getString("serverId") + "\n" + scope.getString("accountId") + "\n" + scope.getString("deviceId") + "\n" + scope.getString("resourceId");
    File directory = new File(context.getNoBackupFilesDir(), "notebook-journals-v1");
    if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Le journal local ne peut pas être créé.");
    file = new AtomicFile(new File(directory, DeviceConnection.sha256(key.getBytes(StandardCharsets.UTF_8)) + ".json"));
    if (file.getBaseFile().exists()) {
      if (file.getBaseFile().length() > DeviceConnection.MAX_BYTES) throw new IOException("Le journal local dépasse la limite. Exportez-le avant de continuer.");
      state = new JSONObject(new String(file.readFully(), StandardCharsets.UTF_8));
      if (state.optInt("schemaVersion") != 1 || !InkView.sameJson(state.optJSONObject("scope"), scope)) throw new IOException("Le journal appartient à un autre carnet.");
    } else state = InkView.json("schemaVersion", 1, "scope", scope, "channel", UUID.randomUUID().toString(), "next", 1, "commands", new JSONArray());
  }
  private void persist(JSONObject next) throws Exception {
    byte[] bytes = next.toString().getBytes(StandardCharsets.UTF_8);
    if (bytes.length > DeviceConnection.MAX_BYTES) throw new IOException("Le journal local est plein. Le geste reste affiché ; exportez la récupération.");
    FileOutputStream output = null;
    try { output = file.startWrite(); output.write(bytes); file.finishWrite(output); state = next; }
    catch (Exception error) { if (output != null) file.failWrite(output); throw error; }
  }
  synchronized JSONObject append(JSONObject action) throws Exception {
    JSONObject next = InkView.copy(state), command = InkView.copy(action);
    long sequence = next.getLong("next");
    if (sequence >= 9007199254740991L) throw new IOException("Le journal a atteint sa limite de séquence.");
    command.put("id", UUID.randomUUID().toString()).put("channel", next.getString("channel")).put("sequence", sequence).put("scope", scope);
    next.getJSONArray("commands").put(command); next.put("next", sequence + 1); persist(next);
    return command;
  }
  synchronized JSONObject head() { return state.optJSONArray("commands").optJSONObject(0); }
  synchronized void acknowledge(String id) throws Exception {
    JSONObject head = head();
    if (head == null || !id.equals(head.optString("id"))) throw new IOException("Accusé local hors séquence. Le journal est conservé.");
    JSONObject next = InkView.copy(state); next.getJSONArray("commands").remove(0); persist(next);
  }
  synchronized JSONObject recovery() { return InkView.copy(state); }
}
