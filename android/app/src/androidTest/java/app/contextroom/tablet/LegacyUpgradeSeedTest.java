package app.contextroom.tablet;

import android.content.*;
import android.database.sqlite.SQLiteDatabase;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Runs against the original signed APK, before the Context Room upgrade.
 * Refuses any existing database; the host also requires a dedicated emulator. */
@RunWith(AndroidJUnit4.class)
public final class LegacyUpgradeSeedTest {
  static SQLiteDatabase retained;
  static String sha(byte[] bytes) throws Exception { StringBuilder result = new StringBuilder(); for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) result.append(String.format(Locale.ROOT,"%02x", b & 255)); return result.toString(); }
  static void string(DataOutputStream out, String value) throws Exception { out.writeInt(value.length()); for (int n = 0; n < value.length(); n++) out.writeChar(value.charAt(n)); }
  static void encode(DataOutputStream out, Object value) throws Exception {
    if (value == JSONObject.NULL) out.writeByte(0);
    else if (value instanceof JSONObject) {
      JSONObject object = (JSONObject) value; out.writeByte(1); out.writeInt(object.length());
      Iterator<String> keys = object.keys(); while (keys.hasNext()) { String key = keys.next(); string(out, key); encode(out, object.get(key)); }
    } else if (value instanceof JSONArray) { JSONArray values = (JSONArray) value; out.writeByte(2); out.writeInt(values.length()); for (int n = 0; n < values.length(); n++) encode(out, values.get(n)); }
    else if (value instanceof String) { out.writeByte(3); string(out, (String) value); }
    else if (value instanceof Boolean) out.writeByte((Boolean) value ? 4 : 5);
    else if (value instanceof Float) { out.writeByte(7); out.writeFloat((Float) value); }
    else if (value instanceof Double) { out.writeByte(8); out.writeDouble((Double) value); }
    else if (value instanceof Number) { out.writeByte(6); out.writeLong(((Number) value).longValue()); }
    else throw new IllegalArgumentException("Unsupported synthetic input");
  }
  static void cache(String key, String value) { ContentValues row = new ContentValues(); row.put("key", key); row.put("value", value); retained.insertOrThrow("cache", null, row); }
  @Test public void seedOnlyAnEmptyOriginalApplication() throws Exception {
    org.junit.Assume.assumeTrue("Explicit owned upgrade fixture required", "seed".equals(InstrumentationRegistry.getArguments().getString("legacyRecoveryFixture")));
    Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    assertEquals("fr.lisiere.android", context.getPackageName());
    assertEquals(95, context.getPackageManager().getPackageInfo(context.getPackageName(), 0).getLongVersionCode());
    File database = context.getDatabasePath("workspace.sqlite"); assertFalse("Never overwrite an existing legacy database", database.exists());
    database.getParentFile().mkdirs(); retained = SQLiteDatabase.openOrCreateDatabase(database, null);
    assertTrue(retained.enableWriteAheadLogging());
    try (android.database.Cursor result = retained.rawQuery("PRAGMA wal_autocheckpoint=0", null)) { assertTrue(result.moveToFirst()); }
    retained.setVersion(1);
    retained.execSQL("CREATE TABLE cache(key TEXT PRIMARY KEY,value TEXT)");
    retained.execSQL("CREATE TABLE outbox(seq INTEGER PRIMARY KEY,id TEXT UNIQUE,operation TEXT,args TEXT,error TEXT)");
    retained.execSQL("CREATE TABLE board_headers(board TEXT PRIMARY KEY,value TEXT)");
    retained.execSQL("CREATE TABLE board_objects(board TEXT,id TEXT,value BLOB,PRIMARY KEY(board,id))");
    cache("draftdoc:legacy-project:docs/Idea.md", "Synthetic original tablet draft 🖊️");
    cache("dirtydraft:legacy-project:docs/Idea.md", new JSONObject().put("project","legacy-project").put("path","docs/Idea.md").put("version",17).put("content","Synthetic original tablet draft 🖊️").toString());
    cache("draftclock:legacy-project:docs/Idea.md", "9007199254740993");
    JSONObject object = new JSONObject().put("id","shape").put("type","rect").put("revision",4).put("x",1f/3).put("y",10000000d).put("w",120).put("h",80);
    JSONObject args = new JSONObject().put("board","legacy-board").put("operationId","original-pending-operation")
      .put("operations",new JSONArray().put(new JSONObject().put("id","shape").put("expectedRevision",4).put("value",object)));
    char[] large = new char[2 * 1024 * 1024 + 73]; Arrays.fill(large, 'R'); args.put("retainedOriginalNote", new String(large));
    ByteArrayOutputStream raw = new ByteArrayOutputStream(); DataOutputStream out = new DataOutputStream(raw); out.writeInt(0x4c534a31); encode(out, args); out.flush();
    ContentValues pending = new ContentValues(); pending.put("seq", 9007199254740993L); pending.put("id","original-pending-operation"); pending.put("operation","board.mutate"); pending.put("args",raw.toByteArray());
    retained.insertOrThrow("outbox", null, pending);
    pending = new ContentValues(); pending.put("seq", 9007199254740994L); pending.put("id","offline-created-board"); pending.put("operation","board.create"); pending.put("args",new JSONObject().put("id","offline-created-board").put("title","Offline creation").toString()); retained.insertOrThrow("outbox",null,pending);
    pending = new ContentValues(); pending.put("seq",9007199254740995L); pending.put("id","original-unreadable-operation"); pending.put("operation","board.mutate"); pending.put("args",new byte[]{76,83,74,57,1}); retained.insertOrThrow("outbox",null,pending);
    ContentValues header = new ContentValues(); header.put("board","legacy-board"); header.put("value",new JSONObject().put("id","legacy-board").put("title","Original tablet notebook").put("project","legacy-project").put("revision",7).toString()); retained.insertOrThrow("board_headers",null,header);
    ContentValues item = new ContentValues(); item.put("board","legacy-board"); item.put("id","shape"); item.put("value",object.toString()); retained.insertOrThrow("board_objects",null,item);
    assertTrue(context.getSharedPreferences("workspace",Context.MODE_PRIVATE).edit().putString("credentials","synthetic-excluded-authentication-preference").commit());
    File directory = new File(context.getFilesDir(),"dictation"); assertTrue(directory.mkdir());
    char[] name = new char[64]; Arrays.fill(name,'a'); File recording = new File(directory,new String(name)+".pcm");
    try (FileOutputStream stream = new FileOutputStream(recording)) { stream.write(new byte[]{0,0,1,0,-1,127,0,-128}); stream.getFD().sync(); }
    JSONObject proof = new JSONObject().put("originalVersionCode",95).put("rawArgsSha256",sha(raw.toByteArray()))
      .put("androidArgsSha256",sha(args.toString().getBytes(StandardCharsets.UTF_8))).put("sequence","9007199254740993")
      .put("recording",recording.getName()).put("database","workspace.sqlite");
    try (FileOutputStream stream = context.openFileOutput("recovery-upgrade-fixture.json",Context.MODE_PRIVATE)) { stream.write(proof.toString().getBytes(StandardCharsets.UTF_8)); stream.getFD().sync(); }
    // Retain the connection so process replacement exercises committed WAL data.
    assertTrue(retained.isOpen());
  }
}
