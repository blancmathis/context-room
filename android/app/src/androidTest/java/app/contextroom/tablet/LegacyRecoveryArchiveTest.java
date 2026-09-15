package app.contextroom.tablet;

import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import android.database.sqlite.SQLiteDatabase;
import android.system.Os;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.UUID;
import java.util.zip.ZipFile;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Every mutation uses a new synthetic cache directory and isolated preferences. */
@RunWith(AndroidJUnit4.class)
public final class LegacyRecoveryArchiveTest {
  File fixture;
  Context isolated;
  LegacyRecoveryArchive recovery;
  @Before public void setUp() throws Exception {
    org.junit.Assume.assumeTrue("Explicit owned recovery fixture required", "verify".equals(InstrumentationRegistry.getArguments().getString("legacyRecoveryFixture")));
    Context target = InstrumentationRegistry.getInstrumentation().getTargetContext();
    assertEquals("fr.lisiere.android", target.getPackageName());
    String identity = "recovery-contract-" + UUID.randomUUID();
    fixture = new File(target.getCacheDir(), identity); assertTrue(fixture.mkdir());
    File files = new File(fixture, "files"), databases = new File(fixture, "databases");
    assertTrue(files.mkdir()); assertTrue(databases.mkdir());
    isolated = new ContextWrapper(target) {
      @Override public Context getApplicationContext() { return this; }
      @Override public File getFilesDir() { return files; }
      @Override public File getDatabasePath(String name) { return new File(databases, name); }
      @Override public SharedPreferences getSharedPreferences(String name, int mode) { return super.getSharedPreferences(identity + "-" + name, mode); }
    };
    try (SQLiteDatabase database = SQLiteDatabase.openOrCreateDatabase(isolated.getDatabasePath("workspace.sqlite"), null)) {
      database.execSQL("CREATE TABLE cache(key TEXT PRIMARY KEY,value TEXT)");
      database.execSQL("CREATE TABLE outbox(seq INTEGER PRIMARY KEY,id TEXT,operation TEXT,args TEXT,error TEXT)");
      database.execSQL("INSERT INTO cache VALUES('draftdoc:project:Idea.md','Original synthetic draft')");
      database.execSQL("INSERT INTO outbox VALUES(1,'pending','board.create','{\"id\":\"board\"}',NULL)");
      database.setVersion(1);
    }
    recovery = new LegacyRecoveryArchive(isolated);
  }
  interface Checked { void run() throws Exception; }
  void refuses(Checked action) throws Exception {
    try { action.run(); fail("Unsafe or incomplete recovery was accepted"); }
    catch (IOException expected) { assertNotNull(expected.getMessage()); }
  }
  @Test public void completedArchiveReopensAndRejectsLaterChanges() throws Exception {
    byte[] original = Files.readAllBytes(isolated.getDatabasePath("workspace.sqlite").toPath());
    File journal = new File(isolated.getDatabasePath("workspace.sqlite") + "-journal");
    assertTrue("Exercise Android's retained clean PERSIST journal", journal.isFile());
    byte[] originalJournal = Files.readAllBytes(journal.toPath());
    assertNull(recovery.completed());
    File archive = recovery.prepare();
    assertEquals(archive, new LegacyRecoveryArchive(isolated).completed());
    try (ZipFile zip = new ZipFile(archive)) {
      JSONObject manifest = new JSONObject(new String(zip.getInputStream(zip.getEntry("manifest.json")).readAllBytes(), StandardCharsets.UTF_8));
      assertEquals(1, manifest.getJSONObject("queue").getInt("decoded"));
      assertFalse(manifest.getBoolean("accepted"));
      assertArrayEquals(originalJournal, zip.getInputStream(zip.getEntry("workspace/workspace.sqlite-journal")).readAllBytes());
    }
    assertArrayEquals(original, Files.readAllBytes(isolated.getDatabasePath("workspace.sqlite").toPath()));
    assertArrayEquals(originalJournal, Files.readAllBytes(journal.toPath()));
    try (FileOutputStream change = new FileOutputStream(archive, true)) { change.write(42); }
    refuses(recovery::completed);
    assertArrayEquals(original, Files.readAllBytes(isolated.getDatabasePath("workspace.sqlite").toPath()));
  }
  @Test public void unfinishedDatabaseAndUnknownRecordingCannotReplaceCompletedReceipt() throws Exception {
    File completed = recovery.prepare();
    try (SQLiteDatabase db = SQLiteDatabase.openDatabase(isolated.getDatabasePath("workspace.sqlite").getAbsolutePath(), null, SQLiteDatabase.OPEN_READWRITE)) { db.setVersion(99); }
    refuses(recovery::prepare); assertEquals(completed, recovery.completed());
    try (SQLiteDatabase db = SQLiteDatabase.openDatabase(isolated.getDatabasePath("workspace.sqlite").getAbsolutePath(), null, SQLiteDatabase.OPEN_READWRITE)) { db.setVersion(1); }
    File recordings = new File(isolated.getFilesDir(), "dictation"); assertTrue(recordings.mkdir());
    File unknown = new File(recordings, "unfinished.pcm"); Files.write(unknown.toPath(), new byte[]{0, 0});
    refuses(recovery::prepare); assertEquals(completed, recovery.completed()); assertTrue(unknown.isFile());
  }
  @Test public void linksAndChangedExportDestinationAreRefused() throws Exception {
    File source = new File(fixture, "source"), copy = new File(fixture, "copy"), link = new File(fixture, "link");
    Files.write(source.toPath(), new byte[]{1, 2, 3}); Files.write(copy.toPath(), new byte[]{4, 5});
    refuses(() -> LegacyRecoveryArchive.copyChecked(source, copy, 10));
    assertArrayEquals(new byte[]{4, 5}, Files.readAllBytes(copy.toPath()));
    Os.symlink(source.getAbsolutePath(), link.getAbsolutePath());
    refuses(() -> LegacyRecoveryArchive.copyChecked(link, null, 10)); assertTrue(link.delete());
    try {
      Os.link(source.getAbsolutePath(), link.getAbsolutePath());
      refuses(() -> LegacyRecoveryArchive.copyChecked(source, null, 10)); assertTrue(link.delete());
    } catch (android.system.ErrnoException denied) {
      assertTrue(denied.errno == android.system.OsConstants.EACCES || denied.errno == android.system.OsConstants.EPERM);
      assertFalse("The Android sandbox refused creation of the hard link", link.exists());
    }
    refuses(() -> LegacyRecoveryArchive.copyChecked(source, null, 2));
    isolated.getSharedPreferences("context-room-lisiere-recovery", 0).edit().putString("completed", "{\"path\":\"../../source\",\"bytes\":3,\"sha256\":\"invalid\"}").commit();
    refuses(recovery::completed);
  }
  @Test public void incompleteBinaryArgumentsStayExplicitAndBounded() throws Exception {
    File database = isolated.getDatabasePath("workspace.sqlite");
    try (SQLiteDatabase db = SQLiteDatabase.openDatabase(database.getAbsolutePath(), null, SQLiteDatabase.OPEN_READWRITE)) {
      db.execSQL("INSERT INTO outbox VALUES(2,'unknown','board.mutate',?,NULL)", new Object[]{new byte[]{0x4c, 0x53, 0x4a, 0x39, 1}});
    }
    File wire = new File(fixture, "wire.jsonl");
    JSONObject queue = LegacyRecoveryArchive.writeQueue(database, wire, 1024 * 1024);
    assertEquals(2, queue.getInt("rows")); assertEquals(1, queue.getInt("requiresReconciliation"));
    JSONObject unknown = new JSONObject(Files.readAllLines(wire.toPath()).get(1));
    assertEquals("requires-reconciliation", unknown.getString("status")); assertFalse(unknown.has("argsJson")); assertEquals(5, unknown.getInt("sourceArgsBytes"));
    refuses(() -> LegacyRecoveryArchive.writeQueue(database, new File(fixture, "too-small.jsonl"), 1));
    refuses(() -> LegacyRecoveryArchive.decode(new byte[]{0x4c, 0x53, 0x4a, 0x31, 1, 0, 0, 0, 1}));
  }
}
