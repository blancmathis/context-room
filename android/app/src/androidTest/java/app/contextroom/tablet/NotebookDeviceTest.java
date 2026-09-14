package app.contextroom.tablet;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import android.app.Instrumentation;
import android.os.*;
import android.view.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.*;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public final class NotebookDeviceTest {
  final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
  interface Checked { boolean check() throws Exception; }
  static void waitFor(String label, Checked condition) throws Exception {
    long end = SystemClock.uptimeMillis() + 25000;
    while (SystemClock.uptimeMillis() < end) { if (condition.check()) return; SystemClock.sleep(80); }
    fail(label);
  }
  MainActivity activity(ActivityScenario<MainActivity> scenario) { AtomicReference<MainActivity> result = new AtomicReference<>(); scenario.onActivity(result::set); return result.get(); }
  JSONObject fixture() throws Exception {
    String path = InstrumentationRegistry.getArguments().getString("fixture");
    if (path == null || !path.startsWith("/data/local/tmp/context-room-")) throw new IOException("An isolated test ticket is required");
    try (InputStream input = new FileInputStream(path)) { return new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8)); }
  }
  boolean onUi(MainActivity activity, java.util.function.BooleanSupplier condition) {
    AtomicBoolean answer = new AtomicBoolean(); instrumentation.runOnMainSync(() -> answer.set(condition.getAsBoolean())); return answer.get();
  }
  void open(MainActivity activity, DeviceConnection connection) throws Exception {
    String project = connection.session.getJSONObject("device").getJSONArray("grants").getJSONObject(0).getString("projectId");
    instrumentation.runOnMainSync(() -> activity.openNotebook(InkView.json("projectId", project, "path", "docs/Tablet.crnb", "title", "Carnet de vérification")));
    waitFor("Native notebook did not open", () -> onUi(activity, () -> activity.ink != null && activity.journal != null && activity.ink.isEnabled()));
  }
  JSONObject scene(DeviceConnection connection) throws Exception {
    String project = connection.session.getJSONObject("device").getJSONArray("grants").getJSONObject(0).getString("projectId");
    JSONObject response = connection.request(project, "/api/notebooks/scene?resourceId=android-acceptance", "GET", "");
    assertEquals("Canonical scene response", 200, response.getInt("status")); return response.getJSONObject("body");
  }
  void pen(MainActivity activity, int action, float x, float y, float pressure, long down) {
    instrumentation.runOnMainSync(() -> {
      MotionEvent.PointerProperties property = new MotionEvent.PointerProperties(); property.id = 0; property.toolType = MotionEvent.TOOL_TYPE_STYLUS;
      MotionEvent.PointerCoords coords = new MotionEvent.PointerCoords(); coords.x = x; coords.y = y; coords.pressure = pressure; coords.size = .1f;
      MotionEvent event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, 1, new MotionEvent.PointerProperties[]{property}, new MotionEvent.PointerCoords[]{coords}, 0, 0, 1, 1, 0, 0, InputDevice.SOURCE_STYLUS, 0);
      activity.ink.onTouchEvent(event); event.recycle();
    });
  }

  void screenshot(MainActivity activity, String name) throws Exception {
    instrumentation.waitForIdleSync(); SystemClock.sleep(180);
    android.graphics.Bitmap screenshot = instrumentation.getUiAutomation().takeScreenshot();
    assertNotNull("Rendered Android capture", screenshot);
    try (OutputStream stream = new FileOutputStream(new File(activity.getFilesDir(), name + ".png"))) { assertTrue(screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, stream)); }
    if (!name.contains("failure")) {
      AtomicReference<android.graphics.Rect> box = new AtomicReference<>(), stroke = new AtomicReference<>();
      instrumentation.runOnMainSync(() -> {
        int[] location = new int[2]; activity.ink.getLocationOnScreen(location);
        for (JSONObject object : activity.ink.objects.values()) {
          if (!object.optString("id").equals("mac-box") && !object.optString("type").equals("ink")) continue;
          android.graphics.RectF bounds = activity.ink.bounds(object);
          android.graphics.Rect pixels = new android.graphics.Rect((int)(location[0] + activity.ink.offsetX + bounds.left * activity.ink.scale)-4,
              (int)(location[1] + activity.ink.offsetY + bounds.top * activity.ink.scale)-4,
              (int)(location[0] + activity.ink.offsetX + bounds.right * activity.ink.scale)+4,
              (int)(location[1] + activity.ink.offsetY + bounds.bottom * activity.ink.scale)+4);
          if (object.optString("id").equals("mac-box")) box.set(pixels); else if (stroke.get() == null) stroke.set(pixels);
        }
      });
      assertTrue("The Mac rectangle must be visible, not merely present in the data", darkPixels(screenshot, box.get()) > 400);
      assertTrue("The native ink must be visible after durable recovery", darkPixels(screenshot, stroke.get()) > 30);
    }
    screenshot.recycle();
  }
  int darkPixels(android.graphics.Bitmap image, android.graphics.Rect area) {
    if (area == null) return 0; int found = 0;
    for (int y = Math.max(0,area.top); y < Math.min(image.getHeight(),area.bottom); y++)
      for (int x = Math.max(0,area.left); x < Math.min(image.getWidth(),area.right); x++) {
        int pixel = image.getPixel(x,y); if (android.graphics.Color.red(pixel) < 220 && android.graphics.Color.green(pixel) < 220 && android.graphics.Color.blue(pixel) < 220) found++;
      }
    return found;
  }

  @Test public void pairedNativeInkAndOfflineQueue() throws Exception {
    JSONObject ticket = fixture();
    JSONObject wrong = InkView.copy(ticket); wrong.put("fingerprint", "0".repeat(64));
    boolean rejected = false; try { DeviceConnection.pair(wrong); } catch (javax.net.ssl.SSLException expected) { rejected = true; }
    assertTrue("Mismatched Mac certificate must fail before pairing", rejected);
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      MainActivity activity = activity(scenario);
      waitFor("Packaged engine did not start", () -> onUi(activity, () -> activity.engineReady));
      instrumentation.runOnMainSync(() -> activity.pair(ticket));
      waitFor("Pairing did not produce a native credential", () -> onUi(activity, () -> activity.connection != null && activity.connection.serverId.equals(ticket.optString("serverId"))));
      DeviceConnection connection = activity.connection;
      assertFalse("Only the native session may contain the credential", connection.session.toString().contains(connection.credential));
      open(activity, connection);
      waitFor("Mac drawing did not appear", () -> onUi(activity, () -> activity.ink.objects.containsKey("mac-box")));
      int before = scene(connection).getJSONObject("document").getJSONArray("objects").length();
      long down = SystemClock.uptimeMillis();
      pen(activity, MotionEvent.ACTION_DOWN, 90, 160, .25f, down);
      SystemClock.sleep(380);
      pen(activity, MotionEvent.ACTION_MOVE, 170, 200, .8f, down);
      waitFor("Reached ink must reach the Mac while the pen is still down", () -> {
        JSONArray objects = scene(connection).getJSONObject("document").getJSONArray("objects");
        for (int n = 0; n < objects.length(); n++) { JSONObject o = objects.getJSONObject(n); if (o.optString("type").equals("ink") && o.getJSONArray("points").length() >= 2) return true; }
        return false;
      });
      assertTrue(onUi(activity, () -> activity.ink.drawing));
      pen(activity, MotionEvent.ACTION_UP, 210, 240, .6f, down);
      waitFor("Final pen lift did not settle", () -> onUi(activity, () -> activity.pendingNative == 0 && activity.lastScene.optInt("pending") == 0));
      JSONObject confirmed = scene(connection);
      assertEquals(before + 1, confirmed.getJSONObject("document").getJSONArray("objects").length());
      JSONObject stroke = confirmed.getJSONObject("document").getJSONArray("objects").getJSONObject(before);
      assertEquals("human", stroke.getJSONObject("createdBy").getString("kind"));
      assertEquals("device-" + connection.session.getJSONObject("device").getString("id"), stroke.getJSONObject("createdBy").getString("id"));
      assertFalse(confirmed.getBoolean("accepted"));
      // A real failed TCP connection exercises the packaged client's durable offline path.
      JSONObject saved = activity.vault.read(); saved.put("url", "https://127.0.0.1:9"); DeviceConnection offline = new DeviceConnection(saved);
      instrumentation.runOnMainSync(() -> activity.engine.connection = offline);
      for (int n = 0; n < 8; n++) {
        long start = SystemClock.uptimeMillis();
        pen(activity, MotionEvent.ACTION_DOWN, 90 + n * 22, 330, .4f, start);
        pen(activity, MotionEvent.ACTION_UP, 100 + n * 22, 390, .9f, start);
      }
      waitFor("Offline gestures were not durably acknowledged locally", () -> onUi(activity, () -> activity.pendingNative == 0 && activity.lastScene.optInt("pending") >= 8 && activity.lastScene.optBoolean("offline")));
      assertEquals("Offline ink must not be reported as canonical", before + 1, scene(connection).getJSONObject("document").getJSONArray("objects").length());
      assertTrue("Native queue must be acknowledged by durable IDB", onUi(activity, () -> activity.journal.head() == null));
      assertTrue(onUi(activity, () -> activity.status.getText().toString().contains("tablette")));
      screenshot(activity, "notebook-offline");
      assertNotNull(activity.vault.read());
    }
  }

  @Test public void restartReplaysOfflineExactlyOnce() throws Exception {
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      MainActivity activity = activity(scenario);
      waitFor("Saved pairing was not recovered", () -> onUi(activity, () -> activity.engineReady && activity.connection != null));
      DeviceConnection connection = activity.connection; open(activity, connection);
      try { waitFor("Recovered outbox did not reach the Mac", () -> onUi(activity, () -> activity.pendingNative == 0 && activity.lastScene.optInt("pending") == 0 && !activity.lastScene.optBoolean("offline"))); }
      catch (AssertionError failure) {
        AtomicReference<String> details = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> details.set("pending=" + activity.pendingNative + " conflicts=" + activity.lastScene.opt("conflictDetails") + " connection=" + activity.lastScene.opt("connectionError") + " status=" + activity.status.getText()));
        screenshot(activity, "notebook-recovery-failure"); throw new AssertionError(failure.getMessage() + ": " + details.get(), failure);
      }
      assertEquals("Two Mac objects, one streamed stroke and eight recovered strokes", 11, scene(connection).getJSONObject("document").getJSONArray("objects").length());
      instrumentation.runOnMainSync(() -> activity.engine.call("refresh")); SystemClock.sleep(1700);
      assertEquals("Refreshing must not duplicate replayed gestures", 11, scene(connection).getJSONObject("document").getJSONArray("objects").length());
      instrumentation.runOnMainSync(() -> activity.enqueue(InkView.json("action", "undo")));
      waitFor("Selective undo did not settle", () -> scene(connection).getJSONObject("document").getJSONArray("objects").length() == 10);
      instrumentation.runOnMainSync(() -> activity.enqueue(InkView.json("action", "redo")));
      waitFor("Selective redo did not settle", () -> scene(connection).getJSONObject("document").getJSONArray("objects").length() == 11);
      waitFor("The tablet must display the final canonical receipt", () -> onUi(activity, () -> activity.pendingNative == 0 && activity.lastScene.optInt("pending") == 0));
      screenshot(activity, "notebook-recovered");
    }
  }

  @Test public void nativeStorageBoundary() throws Exception {
    for (String url : new String[]{"http://127.0.0.1:4000", "https://user:secret@127.0.0.1:4000", "https://127.0.0.1:4000/docs", "https://127.0.0.1:4000/?other=1", "https://127.0.0.1:4000/#fragment"}) {
      boolean refused = false; try { DeviceConnection.endpoint(url); } catch (Exception expected) { refused = true; }
      assertTrue("Only an exact HTTPS device origin is admitted", refused);
    }
    android.content.Context base = instrumentation.getTargetContext();
    File directory = new File(base.getCacheDir(), "native-storage-" + java.util.UUID.randomUUID()); assertTrue(directory.mkdirs());
    android.content.Context isolated = new android.content.ContextWrapper(base) { @Override public File getNoBackupFilesDir() { return directory; } };
    JSONObject scope = InkView.json("serverId", "synthetic-server", "accountId", "synthetic-account", "deviceId", "synthetic-device", "resourceId", "synthetic-notebook");
    NativeCommandJournal journal = new NativeCommandJournal(isolated, scope);
    JSONObject first = journal.append(InkView.json("action", "undo"));
    NativeCommandJournal restarted = new NativeCommandJournal(isolated, scope);
    assertTrue(InkView.sameJson(first, restarted.head()));
    boolean refused = false; try { restarted.acknowledge("different-command"); } catch (IOException expected) { refused = true; }
    assertTrue("An unrelated receipt must not clear the journal", refused);
    assertNotNull(restarted.head()); restarted.acknowledge(first.getString("id"));
    assertNull(new NativeCommandJournal(isolated, scope).head());
    JSONObject credential = InkView.json("serverId", "synthetic-server", "token", "A".repeat(43), "device", InkView.json("id", "synthetic-device"));
    CredentialVault vault = new CredentialVault(isolated); vault.save(credential);
    assertTrue(InkView.sameJson(credential, new CredentialVault(isolated).read()));
    assertFalse("Credential must not occur as plaintext in its durable file", new String(vault.file.readFully(), StandardCharsets.UTF_8).contains(credential.getString("token")));
    JSONObject second = InkView.copy(credential); second.put("device", InkView.json("id", "second-device")); vault.save(second);
    assertEquals("Pairing another notebook must retain the older credential", 2, vault.list().length());
    byte[] damaged = vault.file.readFully(); damaged[damaged.length-1] ^= 1;
    try (OutputStream file = new FileOutputStream(vault.file.getBaseFile())) { file.write(damaged); }
    refused = false; try { vault.read(); } catch (Exception expected) { refused = true; }
    assertTrue("Tampered credential storage must fail closed", refused);
  }
}
