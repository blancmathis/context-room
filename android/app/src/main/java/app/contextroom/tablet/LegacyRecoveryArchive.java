package app.contextroom.tablet;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.*;
import org.json.*;

/** Reads the retained old database only. SQLite opens a disposable copy;
 * preferences, credentials and the original operation queue are never opened. */
final class LegacyRecoveryArchive {
  static final long LIMIT = 512L * 1024 * 1024;
  static final int ROW_LIMIT = 32 * 1024 * 1024;
  static final String NAME = "context-room-lisiere-recovery.zip";
  static final String TYPE = "application/vnd.context-room.lisiere-android-export+json";
  final Context context;
  LegacyRecoveryArchive(Context context) { this.context = context.getApplicationContext(); }

  static boolean available(Context context) {
    return "fr.lisiere.android".equals(context.getPackageName()) && context.getDatabasePath("workspace.sqlite").exists();
  }
  static void require(boolean value, String message) throws IOException { if (!value) throw new IOException(message); }
  static String hex(byte[] bytes) { StringBuilder value = new StringBuilder(); for (byte item : bytes) value.append(String.format(Locale.ROOT, "%02x", item & 255)); return value.toString(); }
  static MessageDigest digest() throws Exception { return MessageDigest.getInstance("SHA-256"); }
  static StructStat regular(File file) throws Exception {
    StructStat value = Os.lstat(file.getAbsolutePath());
    require(OsConstants.S_ISREG(value.st_mode) && value.st_nlink == 1 && value.st_uid == android.os.Process.myUid(), "Un fichier original est lié ou ne possède pas l’identité attendue.");
    return value;
  }
  static void directory(File file) throws Exception {
    require(file.mkdir(), "Le dossier de récupération existe déjà ou ne peut pas être créé."); Os.chmod(file.getAbsolutePath(), 0700);
  }
  static JSONObject copyChecked(File source, File destination, long maximum) throws Exception {
    StructStat before = regular(source); require(before.st_size >= 0 && before.st_size <= maximum, "Un fichier dépasse la limite de récupération.");
    MessageDigest sha = digest(); long count = 0;
    try (FileInputStream input = new FileInputStream(Os.open(source.getAbsolutePath(), OsConstants.O_RDONLY | OsConstants.O_NOFOLLOW, 0))) {
      StructStat opened = Os.fstat(input.getFD());
      require(opened.st_dev == before.st_dev && opened.st_ino == before.st_ino, "Un original a changé pendant son ouverture.");
      FileOutputStream output = null;
      try {
        if (destination != null) { require(destination.createNewFile(), "La copie de récupération existe déjà."); Os.chmod(destination.getAbsolutePath(), 0600); output = new FileOutputStream(destination); }
        byte[] buffer = new byte[64 * 1024]; int size;
        while ((size = input.read(buffer)) != -1) {
          count += size; require(count <= maximum, "Un fichier a grandi pendant sa récupération.");
          sha.update(buffer, 0, size); if (output != null) output.write(buffer, 0, size);
        }
        if (output != null) output.getFD().sync();
      } finally { if (output != null) output.close(); }
      StructStat after = Os.fstat(input.getFD()), visible = regular(source);
      require(count == before.st_size && after.st_size == before.st_size && after.st_mtime == before.st_mtime && after.st_ctime == before.st_ctime
        && after.st_dev == visible.st_dev && after.st_ino == visible.st_ino, "Un original a changé pendant sa récupération.");
    }
    return new JSONObject().put("bytes", count).put("sha256", hex(sha.digest()));
  }
  SortedMap<String, File> originals() throws Exception {
    require(available(context), "Aucune ancienne base Lisière n’est accessible dans cette installation.");
    File database = context.getDatabasePath("workspace.sqlite");
    SortedMap<String, File> files = new TreeMap<>(); files.put("workspace/workspace.sqlite", database);
    // Android can retain a clean PERSIST journal after closing a database.
    // Preserve either journal; only the disposable validation copy is opened.
    for (String suffix : new String[]{"-wal", "-journal"}) {
      File journal = new File(database + suffix); if (journal.exists()) files.put("workspace/workspace.sqlite" + suffix, journal);
    }
    File recordings = new File(context.getFilesDir(), "dictation");
    if (recordings.exists()) {
      StructStat folder = Os.lstat(recordings.getAbsolutePath());
      require(OsConstants.S_ISDIR(folder.st_mode) && folder.st_uid == android.os.Process.myUid(), "Le dossier des enregistrements est lié ou indisponible.");
      File[] entries = recordings.listFiles(); require(entries != null && entries.length <= 20000, "Le dossier des enregistrements dépasse la limite de récupération.");
      for (File file : entries) {
        require(file.getName().matches("[a-f0-9]{64}\\.pcm"), "Un enregistrement inconnu demande une vérification avant export.");
        StructStat info = regular(file); require(info.st_size <= 16000 * 2 * 120 && info.st_size % 2 == 0, "Un enregistrement ne correspond pas au format PCM original.");
        files.put("recordings/" + file.getName(), file);
      }
    }
    return files;
  }
  File prepare() throws Exception {
    SortedMap<String, File> sources = originals();
    File store = new File(context.getFilesDir(), "lisiere-recovery");
    if (!store.exists()) directory(store);
    StructStat storeInfo = Os.lstat(store.getAbsolutePath());
    require(OsConstants.S_ISDIR(storeInfo.st_mode) && storeInfo.st_uid == android.os.Process.myUid(), "Le stockage de récupération est lié ou indisponible.");
    File stage = new File(store, "export-" + UUID.randomUUID()); directory(stage);
    File workspace = new File(stage, "workspace"), recordings = new File(stage, "recordings"), derived = new File(stage, "derived"), validation = new File(stage, "database-check");
    for (File folder : new File[]{workspace, recordings, derived, validation}) directory(folder);
    JSONArray entries = new JSONArray(); long total = 0;
    for (Map.Entry<String, File> source : sources.entrySet()) {
      JSONObject entry = copyChecked(source.getValue(), new File(stage, source.getKey()), LIMIT - total).put("path", source.getKey());
      total += entry.getLong("bytes"); entries.put(entry);
    }
    require(originals().keySet().equals(sources.keySet()), "La liste des originaux a changé. Préparez un nouvel export.");
    // Check the whole source set again, including bytes whose size did not change.
    for (int n = 0; n < entries.length(); n++) {
      JSONObject entry = entries.getJSONObject(n), after = copyChecked(sources.get(entry.getString("path")), null, LIMIT);
      require(after.getLong("bytes") == entry.getLong("bytes") && after.getString("sha256").equals(entry.getString("sha256")), "Un original a changé. Cette préparation reste incomplète.");
    }
    for (String name : new String[]{"workspace.sqlite", "workspace.sqlite-wal", "workspace.sqlite-journal"}) {
      File source = new File(workspace, name); if (source.exists()) copyChecked(source, new File(validation, name), LIMIT);
    }
    File wire = new File(derived, "outbox-args.jsonl");
    JSONObject queue = writeQueue(new File(validation, "workspace.sqlite"), wire, LIMIT - total);
    JSONObject wireEntry = copyChecked(wire, null, LIMIT - total).put("path", "derived/outbox-args.jsonl"); entries.put(wireEntry); total += wireEntry.getLong("bytes");
    require(total <= LIMIT, "L’export complet dépasse 512 Mio. Les originaux et la préparation restent conservés.");
    JSONObject manifest = new JSONObject().put("version", 1).put("mediaType", TYPE).put("sourcePackage", context.getPackageName())
      .put("exporterVersionCode", context.getPackageManager().getPackageInfo(context.getPackageName(), 0).getLongVersionCode())
      .put("accepted", false).put("sourceUnchanged", true).put("files", entries).put("queue", queue)
      .put("recordings", new JSONObject().put("encoding", "pcm-s16le").put("sampleRate", 16000).put("channels", 1).put("context", "unassigned"));
    byte[] manifestBytes = (manifest.toString() + "\n").getBytes(StandardCharsets.UTF_8);
    File archive = new File(stage, NAME);
    require(archive.createNewFile(), "L’archive existe déjà."); Os.chmod(archive.getAbsolutePath(), 0600);
    try (FileOutputStream output = new FileOutputStream(archive); ZipOutputStream zip = new ZipOutputStream(output)) {
      byte[] buffer = new byte[64 * 1024];
      for (int n = 0; n < entries.length(); n++) {
        JSONObject entry = entries.getJSONObject(n); ZipEntry item = new ZipEntry(entry.getString("path")); item.setTime(0); zip.putNextEntry(item);
        try (FileInputStream input = new FileInputStream(new File(stage, item.getName()))) { int size; while ((size = input.read(buffer)) != -1) zip.write(buffer, 0, size); }
        zip.closeEntry();
      }
      ZipEntry complete = new ZipEntry("manifest.json"); complete.setTime(0); zip.putNextEntry(complete); zip.write(manifestBytes); zip.closeEntry();
      zip.finish(); output.getFD().sync();
    }
    JSONObject completed = copyChecked(archive, null, LIMIT + 8 * 1024 * 1024).put("path", stage.getName() + "/" + NAME);
    require(context.getSharedPreferences("context-room-lisiere-recovery", Context.MODE_PRIVATE).edit().putString("completed", completed.toString()).commit(), "Le reçu de récupération n’a pas été conservé.");
    return archive;
  }
  File completed() throws Exception {
    String saved = context.getSharedPreferences("context-room-lisiere-recovery", Context.MODE_PRIVATE).getString("completed", null); if (saved == null) return null;
    JSONObject receipt = new JSONObject(saved); String relative = receipt.getString("path");
    require(relative.matches("export-[a-f0-9-]{36}/" + NAME.replace(".", "\\.")), "Le reçu de récupération est invalide.");
    File file = new File(new File(context.getFilesDir(), "lisiere-recovery"), relative);
    require(file.getCanonicalFile().toPath().startsWith(context.getFilesDir().getCanonicalFile().toPath()), "L’archive conservée a changé de destination.");
    JSONObject actual = copyChecked(file, null, LIMIT + 8 * 1024 * 1024);
    require(actual.getLong("bytes") == receipt.getLong("bytes") && actual.getString("sha256").equals(receipt.getString("sha256")), "L’archive conservée a changé. Gardez-la pour réconciliation.");
    return file;
  }

  static byte[] cell(SQLiteDatabase database, String sequence) throws Exception {
    long size;
    try (Cursor cursor = database.rawQuery("SELECT length(CAST(args AS BLOB)) FROM outbox WHERE seq=?", new String[]{sequence})) {
      require(cursor.moveToFirst() && !cursor.isNull(0), "Arguments originaux absents."); size = cursor.getLong(0);
    }
    require(size >= 0 && size <= ROW_LIMIT, "Arguments originaux trop volumineux.");
    ByteArrayOutputStream data = new ByteArrayOutputStream((int) size);
    for (long offset = 0; offset < size; offset += 64 * 1024) {
      int wanted = (int) Math.min(64 * 1024, size - offset);
      try (Cursor cursor = database.rawQuery("SELECT substr(CAST(args AS BLOB),?,?) FROM outbox WHERE seq=?", new String[]{Long.toString(offset + 1), Integer.toString(wanted), sequence})) {
        require(cursor.moveToFirst(), "Arguments originaux disparus."); byte[] part = cursor.getBlob(0); require(part.length == wanted, "Arguments originaux incomplets."); data.write(part);
      }
    }
    return data.toByteArray();
  }
  static JSONObject writeQueue(File databaseFile, File output, long maximum) throws Exception {
    require(maximum >= 0, "L’export dépasse la limite de récupération."); long bytes = 0; int rows = 0, decoded = 0;
    try (SQLiteDatabase database = SQLiteDatabase.openDatabase(databaseFile.getAbsolutePath(), null, SQLiteDatabase.OPEN_READWRITE | SQLiteDatabase.NO_LOCALIZED_COLLATORS)) {
      require(database.getVersion() <= 1, "La version de la base Lisière demande une vérification explicite.");
      try (Cursor cursor = database.rawQuery("PRAGMA quick_check", null)) { require(cursor.moveToFirst() && "ok".equals(cursor.getString(0)) && !cursor.moveToNext(), "La copie de la base est incomplète ou endommagée."); }
      require(output.createNewFile(), "La copie des arguments existe déjà."); Os.chmod(output.getAbsolutePath(), 0600);
      try (FileOutputStream stream = new FileOutputStream(output); Cursor cursor = database.rawQuery("SELECT seq,id,operation,typeof(args) FROM outbox ORDER BY seq", null)) {
        while (cursor.moveToNext()) {
          require(++rows <= 100000, "La file d’attente dépasse la limite de récupération.");
          String sequence = cursor.getString(0), id = cursor.getString(1), operation = cursor.getString(2), encoding = cursor.getString(3);
          require(sequence.matches("[0-9]{1,19}") && id != null && id.length() <= 4096 && operation != null && operation.length() <= 4096, "L’identité d’une opération demande une réconciliation.");
          JSONObject row = new JSONObject().put("seq", sequence).put("id", id).put("operation", operation).put("sourceEncoding", encoding);
          try {
            byte[] raw = cell(database, sequence); row.put("sourceArgsBytes", raw.length).put("sourceArgsSha256", hex(digest().digest(raw)));
            require("text".equals(encoding) || "blob".equals(encoding), "Encodage original inconnu.");
            JSONObject args = "blob".equals(encoding) ? decode(raw) : new JSONObject(StandardCharsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(raw)).toString());
            // Serialize on the same Android runtime as the original app. This
            // preserves Float/Double-to-JSON behavior for later receipt hashing.
            String json = args.toString(); require(json != null, "Arguments non sérialisables.");
            row.put("argsJson", json).put("status", "decoded"); decoded++;
          } catch (Exception invalid) { row.put("status", "requires-reconciliation"); }
          byte[] line = (row.toString() + "\n").getBytes(StandardCharsets.UTF_8); bytes += line.length;
          require(bytes <= maximum, "Les arguments et originaux dépassent la limite de récupération."); stream.write(line);
        }
        stream.getFD().sync();
      }
    }
    return new JSONObject().put("rows", rows).put("decoded", decoded).put("requiresReconciliation", rows - decoded).put("encoding", "android-org-json").put("delivery", "not-inferred");
  }
  static JSONObject decode(byte[] bytes) throws Exception {
    require(bytes.length >= 5 && bytes.length <= ROW_LIMIT, "Objet binaire original invalide.");
    try (DataInputStream input = new DataInputStream(new ByteArrayInputStream(bytes))) {
      require(input.readInt() == 0x4c534a31, "Version binaire originale inconnue.");
      Object value = read(input, 0, new int[]{0}); require(value instanceof JSONObject && input.available() == 0, "Objet binaire original incomplet."); return (JSONObject) value;
    }
  }
  static String text(DataInputStream input) throws Exception {
    int length = input.readInt(); require(length >= 0 && length <= input.available() / 2, "Texte binaire original incomplet.");
    StringBuilder value = new StringBuilder(length); for (int n = 0; n < length; n++) value.append(input.readChar()); return value.toString();
  }
  static Object read(DataInputStream input, int depth, int[] nodes) throws Exception {
    require(depth <= 256 && ++nodes[0] <= 2000000, "Objet binaire original trop complexe."); int type = input.readUnsignedByte();
    if (type == 0) return JSONObject.NULL;
    if (type == 3) return text(input);
    if (type == 4 || type == 5) return type == 4;
    if (type == 6) return input.readLong();
    if (type == 7) { float value = input.readFloat(); require(Float.isFinite(value), "Nombre original invalide."); return value; }
    if (type == 8) { double value = input.readDouble(); require(Double.isFinite(value), "Nombre original invalide."); return value; }
    require(type == 1 || type == 2, "Type binaire original inconnu.");
    int length = input.readInt(); require(length >= 0 && length <= input.available(), "Collection binaire originale incomplète.");
    if (type == 2) { JSONArray result = new JSONArray(); for (int n = 0; n < length; n++) result.put(read(input, depth + 1, nodes)); return result; }
    JSONObject result = new JSONObject();
    for (int n = 0; n < length; n++) { String key = text(input); require(!result.has(key), "Clé originale dupliquée."); result.put(key, read(input, depth + 1, nodes)); }
    return result;
  }
}
