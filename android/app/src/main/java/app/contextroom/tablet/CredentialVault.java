package app.contextroom.tablet;

import android.content.Context;
import android.security.keystore.*;
import android.util.AtomicFile;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
import org.json.*;

/** The pairing credential is encrypted with an app-private Android Keystore key. */
final class CredentialVault {
  static final String ALIAS = "context-room-device-v1";
  final AtomicFile file;
  CredentialVault(Context context) { file = new AtomicFile(new File(context.getNoBackupFilesDir(), "device-credential-v1")); }
  private javax.crypto.SecretKey key() throws Exception {
    KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
    if (store.containsAlias(ALIAS)) return ((KeyStore.SecretKeyEntry)store.getEntry(ALIAS, null)).getSecretKey();
    if (file.getBaseFile().exists()) throw new IOException("La clé de cette connexion est indisponible. Le cache de dessin est conservé.");
    KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
    generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build());
    return generator.generateKey();
  }
  private JSONObject readRecord() throws Exception {
    if (!file.getBaseFile().exists() && !new File(file.getBaseFile().getPath() + ".bak").exists()) return null;
    byte[] bytes = file.readFully();
    if (bytes.length < 29 || bytes.length > 128 * 1024 || bytes[0] != 1) throw new IOException("Connexion locale illisible. Le cache de dessin est conservé.");
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, bytes, 1, 12));
    cipher.updateAAD(ALIAS.getBytes(StandardCharsets.UTF_8));
    return new JSONObject(new String(cipher.doFinal(bytes, 13, bytes.length - 13), StandardCharsets.UTF_8));
  }
  synchronized JSONObject read() throws Exception {
    JSONObject record = readRecord(); if (record == null) return null;
    JSONArray connections = record.getJSONArray("connections");
    for (int n = 0; n < connections.length(); n++) { JSONObject item = connections.getJSONObject(n); if (connectionKey(item).equals(record.getString("active"))) return item; }
    throw new IOException("La connexion active est absente. Les carnets sont conservés.");
  }
  synchronized JSONArray list() throws Exception { JSONObject record = readRecord(); return record == null ? new JSONArray() : record.getJSONArray("connections"); }
  static String connectionKey(JSONObject value) throws JSONException { return value.getString("serverId") + ":" + value.getJSONObject("device").getString("id"); }
  synchronized void save(JSONObject value) throws Exception {
    JSONObject record = readRecord(); if (record == null) record = InkView.json("schemaVersion", 1, "connections", new JSONArray());
    JSONArray connections = record.getJSONArray("connections"); String id = connectionKey(value); boolean replaced = false;
    for (int n = 0; n < connections.length(); n++) if (connectionKey(connections.getJSONObject(n)).equals(id)) { connections.put(n, value); replaced = true; break; }
    if (!replaced) { if (connections.length() >= 32) throw new IOException("32 connexions sont déjà conservées. Exportez les anciens carnets avant d’en ajouter."); connections.put(value); }
    record.put("active", id);
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
    cipher.updateAAD(ALIAS.getBytes(StandardCharsets.UTF_8));
    byte[] encrypted = cipher.doFinal(record.toString().getBytes(StandardCharsets.UTF_8));
    FileOutputStream output = null;
    try { output = file.startWrite(); output.write(1); output.write(cipher.getIV()); output.write(encrypted); file.finishWrite(output); }
    catch (Exception error) { if (output != null) file.failWrite(output); throw error; }
  }
}
