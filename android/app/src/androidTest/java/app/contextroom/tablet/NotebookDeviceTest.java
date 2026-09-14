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
    pointer(activity, action, x, y, pressure, down, MotionEvent.TOOL_TYPE_STYLUS);
  }
  void pointer(MainActivity activity, int action, float x, float y, float pressure, long down, int tool) {
    instrumentation.runOnMainSync(() -> {
      MotionEvent.PointerProperties property = new MotionEvent.PointerProperties(); property.id = 0; property.toolType = tool;
      MotionEvent.PointerCoords coords = new MotionEvent.PointerCoords(); coords.x = x; coords.y = y; coords.pressure = pressure; coords.size = .1f;
      MotionEvent event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, 1, new MotionEvent.PointerProperties[]{property}, new MotionEvent.PointerCoords[]{coords}, 0, 0, 1, 1, 0, 0, InputDevice.SOURCE_STYLUS, 0);
      activity.ink.onTouchEvent(event); event.recycle();
    });
  }

  @Test public void nativeViewFollowingAndPresentation() throws Exception {
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      MainActivity activity = activity(scenario);
      waitFor("Saved connection did not open", () -> onUi(activity, () -> activity.engineReady && activity.connection != null));
      open(activity, activity.connection);
      waitFor("Native view is not ready", () -> onUi(activity, () -> !activity.navigationBusy()));
      assertTrue(onUi(activity, () -> activity.views.mode.equals("independent")));
      AtomicReference<String> before = new AtomicReference<>();
      instrumentation.runOnMainSync(() -> before.set(activity.ink.viewportBounds().toString()));
      navigationStage(activity, "viewIndependent"); ownerObserved(activity, "viewSourceReady");
      SystemClock.sleep(1500);
      assertTrue("Sharing from the Mac cannot enable following", onUi(activity, () -> before.get().equals(activity.ink.viewportBounds().toString()) && activity.views.receipt == null));
      instrumentation.runOnMainSync(() -> activity.followViewButton.performClick());
      navigationStage(activity, "viewFollowing");
      waitFor("The native canvas did not acknowledge the shared viewport", () -> onUi(activity, () -> activity.views.receipt != null));
      ownerObserved(activity, "viewApplied"); screenshot(activity, "notebook-following");
      long down = SystemClock.uptimeMillis();
      pointer(activity, MotionEvent.ACTION_DOWN, 100, 100, .5f, down, MotionEvent.TOOL_TYPE_FINGER);
      assertTrue("Finger contact must stop following synchronously", onUi(activity, () -> activity.views.mode.equals("independent") && activity.views.pending == null));
      pointer(activity, MotionEvent.ACTION_MOVE, 140, 110, .5f, down, MotionEvent.TOOL_TYPE_FINGER);
      pointer(activity, MotionEvent.ACTION_UP, 140, 110, .5f, down, MotionEvent.TOOL_TYPE_FINGER);
      instrumentation.runOnMainSync(() -> before.set(activity.ink.viewportBounds().toString()));
      navigationStage(activity, "viewStopped"); ownerObserved(activity, "viewSourceChanged"); SystemClock.sleep(1500);
      assertTrue("A later Mac frame cannot restart following", onUi(activity, () -> before.get().equals(activity.ink.viewportBounds().toString())));
      AtomicInteger height = new AtomicInteger();
      instrumentation.runOnMainSync(() -> { height.set(activity.ink.getHeight()); activity.presentationButton.performClick(); });
      waitFor("Fullscreen presentation did not expand the native canvas", () -> onUi(activity, () -> activity.presentation && activity.ink.getHeight() > height.get() && activity.drawingTools.getVisibility() == View.GONE));
      screenshot(activity, "notebook-presentation");
      instrumentation.runOnMainSync(activity::onBackPressed);
      assertTrue("Back leaves presentation without closing the notebook", onUi(activity, () -> !activity.presentation && activity.currentScope != null));
      instrumentation.runOnMainSync(() -> activity.shareViewButton.performClick()); navigationStage(activity, "tabletSharing"); ownerObserved(activity, "tabletViewReceived");
      assertTrue("Receipt-free sharing cannot claim a Mac display", onUi(activity, () -> activity.views.mode.equals("share") && activity.viewStatus.getText().toString().contains("non confirmé")));
      scenario.moveToState(androidx.lifecycle.Lifecycle.State.STARTED);
      scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED);
      assertTrue("View following and sharing are never silently restored", onUi(activity, () -> activity.views.mode.equals("independent")));
    }
  }

  @Test public void nativeOpeningRejectsQueuedPreviousScene() throws Exception {
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      MainActivity activity = activity(scenario);
      waitFor("Saved connection did not open", () -> onUi(activity, () -> activity.engineReady && activity.connection != null));
      open(activity, activity.connection); waitFor("Initial notebook did not settle", () -> onUi(activity, () -> !activity.navigationBusy()));
      instrumentation.runOnMainSync(() -> {
        JSONObject stale = InkView.copy(activity.lastScene), oldScope = InkView.copy(activity.currentScope); String previous = activity.openingId;
        try { stale.put("version", Long.MAX_VALUE); } catch (JSONException error) { throw new IllegalStateException(error); }
        activity.openNotebook(InkView.json("projectId", activity.openingProject, "path", "docs/Second.crnb"));
        // Model JavaScript events already queued on Android's main thread before
        // the new engine open call has run. Cache versions belong to their scopes.
        activity.engineEvent(stale);
        activity.engineEvent(InkView.json("type", "opened", "openId", previous, "path", "docs/Tablet.crnb", "scope", oldScope));
        assertNull("A previous scene cannot populate the new canvas", activity.lastScene);
        assertNull("A previous opening cannot select the old scope", activity.currentScope);
        assertEquals(-1, activity.sceneVersion);
      });
      waitFor("The new exact notebook did not render", () -> onUi(activity, () -> !activity.navigationBusy() && activity.currentScope != null
        && "android-second".equals(activity.currentScope.optString("resourceId")) && "android-second".equals(activity.lastScene.optString("resourceId"))));
    }
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

  void navigationStage(MainActivity activity, String stage) throws Exception {
    android.util.AtomicFile file = new android.util.AtomicFile(new File(activity.getFilesDir(), "navigation-stage.json"));
    FileOutputStream output = file.startWrite();
    try { output.write(InkView.json("serverId", activity.connection.serverId, "stage", stage).toString().getBytes(StandardCharsets.UTF_8)); file.finishWrite(output); }
    catch (Exception error) { file.failWrite(output); throw error; }
  }
  void ownerObserved(MainActivity activity, String stage) throws Exception {
    waitFor("Fixture owner did not observe " + stage, () -> {
      try (InputStream file = new FileInputStream("/data/local/tmp/context-room-navigation-owner.json")) {
        JSONObject observed = new JSONObject(new String(file.readAllBytes(), StandardCharsets.UTF_8));
        return activity.connection.serverId.equals(observed.optString("serverId")) && stage.equals(observed.optString("stage"));
      } catch (FileNotFoundException error) { return false; }
    });
  }
  android.widget.Button findButton(View view, String text) {
    if (view instanceof android.widget.Button && text.contentEquals(((android.widget.Button)view).getText())) return (android.widget.Button)view;
    if (view instanceof ViewGroup) for (int n = 0; n < ((ViewGroup)view).getChildCount(); n++) {
      android.widget.Button found = findButton(((ViewGroup)view).getChildAt(n), text); if (found != null) return found;
    }
    return null;
  }

  @Test public void remoteOpeningPreservesInkAndHumanControl() throws Exception {
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      MainActivity activity = activity(scenario);
      waitFor("Saved connection did not open", () -> onUi(activity, () -> activity.engineReady && activity.connection != null));
      DeviceConnection connection = activity.connection; open(activity, connection);
      try {
      waitFor("Initial scene did not settle", () -> onUi(activity, () -> !activity.navigationBusy() && activity.lastScene != null));
      InkView first = activity.ink;
      long down = SystemClock.uptimeMillis();
      pen(activity, MotionEvent.ACTION_DOWN, 70, 80, .3f, down);
      SystemClock.sleep(380); pen(activity, MotionEvent.ACTION_MOVE, 140, 110, .7f, down);
      navigationStage(activity, "drawingFirst");
      waitFor("Remote opening was not deferred during a held pen", () -> onUi(activity, () -> activity.navigation.deferred));
      assertTrue(onUi(activity, () -> activity.ink == first && first.drawing));
      ownerObserved(activity, "deferredFirst");
      pen(activity, MotionEvent.ACTION_MOVE, 200, 140, .8f, down);
      pen(activity, MotionEvent.ACTION_UP, 240, 170, .4f, down);
      waitFor("Second notebook did not render and receive its native acknowledgement", () -> onUi(activity, () -> activity.currentScope != null
        && "android-second".equals(activity.currentScope.optString("resourceId")) && activity.navigation.command == null && !activity.navigationBusy()));
      JSONArray firstObjects = scene(connection).getJSONObject("document").getJSONArray("objects");
      assertEquals("All first-notebook gestures must remain in their original notebook", 12, firstObjects.length());
      assertTrue("The held gesture must retain the samples reached after the remote request", firstObjects.getJSONObject(11).getJSONArray("points").length() >= 4);
      navigationStage(activity, "secondDisplayed"); ownerObserved(activity, "appliedFirst");

      InkView second = activity.ink;
      down = SystemClock.uptimeMillis(); pen(activity, MotionEvent.ACTION_DOWN, 90, 330, .3f, down);
      SystemClock.sleep(380); pen(activity, MotionEvent.ACTION_MOVE, 150, 365, .8f, down);
      navigationStage(activity, "drawingSecond");
      waitFor("Return navigation did not wait for the second gesture", () -> onUi(activity, () -> activity.navigation.deferred));
      ownerObserved(activity, "deferredSecond");
      // A real native toolbar action reclaims the view before the queued opening.
      instrumentation.runOnMainSync(() -> { android.widget.Button pen = findButton(activity.screen, "Stylo"); assertNotNull(pen); pen.performClick(); });
      pen(activity, MotionEvent.ACTION_UP, 210, 390, .5f, down);
      waitFor("Human cancellation did not settle", () -> onUi(activity, () -> activity.navigation.command == null && activity.pendingNative == 0 && activity.lastScene.optInt("pending") == 0));
      assertTrue("A human action must keep the chosen notebook", onUi(activity, () -> activity.ink == second && "android-second".equals(activity.currentScope.optString("resourceId"))));
      navigationStage(activity, "cancelledSecond"); ownerObserved(activity, "cancelledSecond");
      screenshot(activity, "notebook-remote-open");
      } catch (Throwable error) {
        instrumentation.runOnMainSync(() -> System.out.println("Navigation failure state: " + InkView.json("scope", activity.currentScope,
          "sceneScope", activity.lastScene == null ? null : activity.lastScene.optJSONObject("scope"), "sceneVersion", activity.sceneVersion, "openingId", activity.openingId,
          "status", activity.status.getText().toString(), "busy", activity.navigationBusy(), "opening", activity.navigation.opening,
          "command", activity.navigation.command, "receipt", activity.navigation.receipt, "deadlineRemaining", activity.navigation.deadline - SystemClock.elapsedRealtime(),
          "attached", activity.ink != null && activity.ink.isAttachedToWindow(), "shown", activity.ink != null && activity.ink.isShown(), "focused", activity.hasWindowFocus())));
        try { screenshot(activity, "notebook-navigation-failure"); } catch (Exception capture) { error.addSuppressed(capture); }
        throw error;
      }
    }
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
      boolean navigationRefused = false;
      try { connection.request("", "/device/navigation/receipt", "POST", "{}"); } catch (IOException expected) { navigationRefused = true; }
      assertTrue("The generic WebView transport cannot claim native display receipts", navigationRefused);
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
