package app.contextroom.tablet;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import android.app.Instrumentation;
import android.os.*;
import android.view.MotionEvent;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public final class OwnerWorkspaceTest {
  final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
  final NotebookDeviceTest drawing = new NotebookDeviceTest();
  String evaluate(MainActivity activity, String source) throws Exception {
    AtomicReference<String> result = new AtomicReference<>(); CountDownLatch complete = new CountDownLatch(1);
    instrumentation.runOnMainSync(() -> activity.ownerWorkspace.web.evaluateJavascript(source, value -> { result.set(value); complete.countDown(); }));
    assertTrue("Owner WebView did not answer", complete.await(10, TimeUnit.SECONDS)); return result.get();
  }
  void visible(MainActivity activity, String condition) throws Exception { NotebookDeviceTest.waitFor("Owner UI: " + condition, () -> "true".equals(evaluate(activity, "Boolean(" + condition + ")"))); }
  void click(MainActivity activity, String selector) throws Exception {
    visible(activity, "document.querySelector(" + JSONObject.quote(selector) + ")");
    evaluate(activity, "document.querySelector(" + JSONObject.quote(selector) + ").click()");
  }
  void screenshot(MainActivity activity, String name) throws Exception {
    if (name.equals("owner-shared-review")) {
      CountDownLatch painted = new CountDownLatch(1);
      instrumentation.runOnMainSync(() -> activity.ownerWorkspace.web.postVisualStateCallback(SystemClock.uptimeMillis(), new android.webkit.WebView.VisualStateCallback() {
        @Override public void onComplete(long requestId) { painted.countDown(); }
      }));
      assertTrue("Owner WebView did not commit its rendered state", painted.await(10, TimeUnit.SECONDS));
    }
    instrumentation.waitForIdleSync(); SystemClock.sleep(180);
    android.graphics.Bitmap bitmap = instrumentation.getUiAutomation().takeScreenshot(); assertNotNull(bitmap);
    try (OutputStream output = new FileOutputStream(new File(activity.getFilesDir(), name + ".png"))) { assertTrue(bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output)); }
  }
  android.view.accessibility.AccessibilityNodeInfo findText(android.view.accessibility.AccessibilityNodeInfo node, String text) {
    if (node == null) return null;
    if (text.equalsIgnoreCase(String.valueOf(node.getText())) || text.equalsIgnoreCase(String.valueOf(node.getContentDescription()))) return node;
    if (text.endsWith(".png") && String.valueOf(node.getContentDescription()).startsWith(text + ", ")) return node;
    for (int n = 0; n < node.getChildCount(); n++) { android.view.accessibility.AccessibilityNodeInfo found = findText(node.getChild(n), text); if (found != null) return found; }
    return null;
  }
  void systemClick(String text) throws Exception {
    systemClick(text, "com.android.documentsui", "com.google.android.documentsui");
  }
  void permissionClick(String text) throws Exception {
    systemClick(text, "com.android.permissioncontroller", "com.google.android.permissioncontroller");
  }
  void systemClick(String text, String... allowedPackages) throws Exception {
    AtomicReference<android.view.accessibility.AccessibilityNodeInfo> found = new AtomicReference<>();
    try { NotebookDeviceTest.waitFor("Android file picker: " + text, () -> {
      android.view.accessibility.AccessibilityNodeInfo root = instrumentation.getUiAutomation().getRootInActiveWindow();
      // The owner's document toolbar also has Save. Wait for the system picker
      // before locating its action, including while download chunks are arriving.
      String packageName = root == null ? "" : String.valueOf(root.getPackageName());
      if (!java.util.Arrays.asList(allowedPackages).contains(packageName)) return false;
      found.set(findText(root, text)); return found.get() != null && found.get().isEnabled() && found.get().isVisibleToUser();
    }); }
    catch (AssertionError error) { System.out.println("Picker content: " + pickerContent(instrumentation.getUiAutomation().getRootInActiveWindow())); throw error; }
    android.view.accessibility.AccessibilityNodeInfo node = found.get();
    if (node.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK)) return;
    while (node != null && !node.isClickable()) node = node.getParent();
    if (node != null) { assertTrue(node.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK)); return; }
    // DocumentsUI exposes its grid item label and bounds but delegates touch
    // handling to RecyclerView instead of marking an ancestor clickable.
    android.graphics.Rect bounds = new android.graphics.Rect(); found.get().getBoundsInScreen(bounds);
    assertTrue("No visible file picker bounds for " + text, bounds.width() > 0 && bounds.height() > 0 && found.get().isEnabled());
    System.out.println("Picker target " + text + ": " + bounds + ", actions " + found.get().getActionList());
    long at = SystemClock.uptimeMillis();
    for (int action : new int[]{MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP}) {
      MotionEvent event = MotionEvent.obtain(at, SystemClock.uptimeMillis(), action, bounds.exactCenterX(), bounds.exactCenterY(), 0);
      event.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN); assertTrue(instrumentation.getUiAutomation().injectInputEvent(event, true)); event.recycle();
      if (action == MotionEvent.ACTION_DOWN) SystemClock.sleep(80);
    }
  }
  String pickerContent(android.view.accessibility.AccessibilityNodeInfo node) {
    if (node == null) return "";
    StringBuilder text = new StringBuilder();
    if (node.getText() != null) text.append(node.getText()).append(" | ");
    if (node.getContentDescription() != null) text.append(node.getContentDescription()).append(" | ");
    for (int n = 0; n < node.getChildCount() && text.length() < 4000; n++) text.append(pickerContent(node.getChild(n)));
    return text.toString();
  }
  /** This helper is exclusively for retained legacy-journal regression scenarios. */
  void openLegacyRecoveryNotebook(MainActivity activity, JSONObject ticket) throws Exception {
    evaluate(activity, "ContextRoomNativeOwner.openNotebook({projectId:" + JSONObject.quote(ticket.getString("testProjectId")) + ",path:'docs/Owner.crnb'})");
  }
  void sharedWebPen(MainActivity activity) throws Exception {
    String bounds = evaluate(activity, "(()=>{const r=document.querySelector('canvas.notebook-canvas').getBoundingClientRect();return JSON.stringify([r.left+75,r.top+60,innerWidth])})()");
    JSONArray point = new JSONArray(new JSONArray("[" + bounds + "]").getString(0));
    int[] location = new int[2]; AtomicInteger pixels = new AtomicInteger();
    instrumentation.runOnMainSync(() -> { activity.ownerWorkspace.web.getLocationOnScreen(location); pixels.set(activity.ownerWorkspace.web.getWidth()); });
    float scale = (float)(pixels.get() / point.getDouble(2));
    long down = SystemClock.uptimeMillis();
    int[] actions = { MotionEvent.ACTION_DOWN, MotionEvent.ACTION_MOVE, MotionEvent.ACTION_UP };
    float[] pressures = { .25f, .75f, .5f };
    for (int n = 0; n < actions.length; n++) {
      MotionEvent.PointerProperties properties = new MotionEvent.PointerProperties(); properties.id = 0; properties.toolType = MotionEvent.TOOL_TYPE_STYLUS;
      MotionEvent.PointerCoords coordinates = new MotionEvent.PointerCoords();
      coordinates.x = location[0] + ((float)point.getDouble(0) + n * 55) * scale;
      coordinates.y = location[1] + ((float)point.getDouble(1) + n * 18) * scale;
      coordinates.pressure = pressures[n]; coordinates.size = .1f;
      MotionEvent event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), actions[n], 1,
        new MotionEvent.PointerProperties[]{properties}, new MotionEvent.PointerCoords[]{coordinates},
        0, 0, 1, 1, 0, 0, android.view.InputDevice.SOURCE_STYLUS, 0);
      assertTrue("The common WebView must receive the stylus sample", instrumentation.getUiAutomation().injectInputEvent(event, true)); event.recycle();
      SystemClock.sleep(40);
    }
  }
  @Test public void ownerHubDocumentsAndSharedDrawingStayConnected() throws Exception {
    JSONObject ticket = drawing.fixture();
    try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
      MainActivity activity = drawing.activity(scenario);
      NotebookDeviceTest.waitFor("Notebook engine unavailable", () -> drawing.onUi(activity, () -> activity.engineReady));
      instrumentation.runOnMainSync(() -> activity.pair(ticket));
      NotebookDeviceTest.waitFor("Owner surface did not open", () -> drawing.onUi(activity, () -> activity.showingOwner && activity.ownerWorkspace != null));
      try {
        visible(activity, "document.querySelector('body')?.dataset.workspaceDiagnostics && JSON.parse(document.body.dataset.workspaceDiagnostics).phase === 'ready'");
        assertEquals("Credential must remain native", "true", evaluate(activity, "typeof window.ContextRoomOwnerCredential === 'undefined'"));
        click(activity, "[data-global-explorer-mode='computer']");
        visible(activity, "[...document.querySelectorAll('[data-computer-explorer-file]')].some(n => n.textContent.includes('Idea.md'))");
        assertEquals("Computer stays inside its configured root", "true", evaluate(activity, "[...document.querySelectorAll('[data-computer-explorer-file]')].every(n => n.textContent.includes('Idea.md'))"));
        click(activity, "[data-global-explorer-mode='projects']");
        // The fixture is registered in the actual Hub. Open its existing project.
        evaluate(activity, "[...document.querySelectorAll('a.global-project-row')].find(n => n.textContent.includes('Owner integration project'))?.click()");
        visible(activity, "document.querySelector('[data-global-project-folder=\"docs\"]')");
        evaluate(activity, "(()=>{const n=document.querySelector('#globalProjectSearch');n.value='Guide';n.dispatchEvent(new Event('input',{bubbles:true}))})()");
        visible(activity, "document.querySelector('[data-global-project-file=\"docs/Guide.md\"]') && !document.querySelector('[data-global-project-file=\"docs/Diagram.html\"]')");
        evaluate(activity, "(()=>{const n=document.querySelector('#globalProjectSearch');n.value='';n.dispatchEvent(new Event('input',{bubbles:true}))})()");
        visible(activity, "document.querySelector('[data-global-project-folder=\"docs\"]')");
        evaluate(activity, "(()=>{const n=document.querySelector('[data-global-project-folder=\"docs\"]');if(n.getAttribute('aria-expanded')!=='true')n.click()})()");
        click(activity, "[data-global-project-file='docs/Guide.md']");
        visible(activity, "document.querySelector('#workspaceTitle')?.textContent.includes('Guide.md')");
        visible(activity, "document.querySelector('#viewer')?.textContent.includes('Connected owner guide')");
        click(activity, "[data-global-project-file='docs/Diagram.html']");
        visible(activity, "document.querySelector('#workspaceTitle')?.textContent.includes('Diagram.html')");
        visible(activity, "[...document.querySelectorAll('iframe')].some(frame => frame.contentDocument?.body?.textContent.includes('Rendered owner diagram'))");
        assertEquals("Document scripts must stay inert", "true", evaluate(activity, "typeof window.UNTRUSTED_DOCUMENT_EXECUTED === 'undefined'"));
        screenshot(activity, "owner-rendered-document");
        // Even a synthetic same-origin frame with scripting enabled cannot use
        // the native owner bridge. Production document frames disallow scripts.
        String probe = "<script>try{ContextRoomOwnerTransport.onmessage=()=>parent.FRAME_ANSWERED=true;ContextRoomOwnerTransport.postMessage(JSON.stringify({id:'00000000-0000-0000-0000-000000000001',action:'notebook.open',value:{projectId:'" + ticket.getString("testProjectId") + "',path:'docs/Owner.crnb'}}))}catch(e){}</script>";
        evaluate(activity, "(()=>{const f=document.createElement('iframe');f.id='owner-test-frame';f.srcdoc=" + JSONObject.quote(probe) + ";document.body.append(f)})()");
        SystemClock.sleep(500);
        assertTrue("Subframe cannot open native resources", drawing.onUi(activity, () -> activity.showingOwner && activity.ink == null));
        assertEquals("Subframe receives no privileged reply", "true", evaluate(activity, "typeof window.FRAME_ANSWERED === 'undefined'"));
        evaluate(activity, "document.querySelector('#owner-test-frame').remove()");
        evaluate(activity, "document.addEventListener('context-room-notebook-opened',event=>window.sharedNotebook=event.detail)");
        click(activity, "[data-global-project-file='docs/Owner.crnb']");
        visible(activity, "[...document.querySelectorAll('.local-proposal-review button')].some(n=>n.textContent==='Open working notebook')");
        evaluate(activity, "[...document.querySelectorAll('.local-proposal-review button')].find(n=>n.textContent==='Open working notebook').click()");
        visible(activity, "document.querySelector('.notebook-dialog canvas')");
        assertTrue("The normal notebook must not instantiate the legacy native canvas", drawing.onUi(activity, () -> activity.ink == null && activity.showingOwner));
        assertEquals("No parallel native tool route in the normal editor", "true", evaluate(activity, "![...document.querySelectorAll('.notebook-dialog button')].some(n=>n.textContent==='Draw with the native pen')"));
        sharedWebPen(activity);
        visible(activity, "window.sharedNotebook?.surface.document.objects.length===1 && document.querySelector('.notebook-dialog')?.dataset.saveState==='confirmed'");
        assertEquals("Web pressure samples are retained", "true", evaluate(activity, "[.25,.75].every(p=>window.sharedNotebook.surface.document.objects[0].points.some(point=>point[2]===p))"));
        screenshot(activity, "owner-shared-drawing");
        assertEquals("Owner permission stays explicit", true, activity.connection.isOwner());
        screenshot(activity, "owner-retained-workspace");
        android.content.ContentResolver resolver = activity.getContentResolver();
        android.content.ContentValues values = new android.content.ContentValues();
        String importedName = "CR-" + (System.currentTimeMillis() % 1000000) + ".png";
        values.put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, importedName);
        values.put(android.provider.MediaStore.MediaColumns.MIME_TYPE, "image/png");
        values.put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, "Download");
        values.put(android.provider.MediaStore.MediaColumns.IS_PENDING, 1);
        android.net.Uri imported = resolver.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        assertNotNull(imported);
        try {
          android.graphics.Bitmap bitmap = android.graphics.Bitmap.createBitmap(96, 64, android.graphics.Bitmap.Config.ARGB_8888); bitmap.eraseColor(android.graphics.Color.DKGRAY);
          try (OutputStream output = resolver.openOutputStream(imported)) { assertTrue(bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output)); }
          android.content.ContentValues published = new android.content.ContentValues(); published.put(android.provider.MediaStore.MediaColumns.IS_PENDING, 0); assertEquals(1, resolver.update(imported, published, null, null));
          evaluate(activity, "[...document.querySelectorAll('.notebook-dialog button')].find(n=>n.textContent==='Image').click()");
          systemClick("Show roots"); systemClick("Downloads");
          screenshot(activity, "owner-image-picker");
          systemClick(importedName);
          visible(activity, "document.querySelector('.notebook-state [role=status]')?.textContent.includes('2 objects')");
          visible(activity, "document.querySelector('.notebook-dialog')?.dataset.saveState === 'confirmed'");
          screenshot(activity, "owner-imported-image");
        } finally { resolver.delete(imported, null, null); }
        evaluate(activity, "[...document.querySelectorAll('.notebook-dialog button')].find(n=>n.textContent==='Export').click()");
        systemClick("SAVE");
        NotebookDeviceTest.waitFor("Android export was not completed", () -> drawing.onUi(activity, () -> activity.status.getText().toString().contains("Fichier exporté")));
        assertEquals("Export must retain the editable scene", "true", evaluate(activity, "document.querySelector('.notebook-state [role=status]')?.textContent.includes('2 objects')"));
        screenshot(activity, "owner-exported-notebook");
        evaluate(activity, "[...document.querySelectorAll('.notebook-dialog button')].find(n=>n.textContent==='Close notebook').click()");
        visible(activity, "!document.querySelector('.notebook-dialog')");
        // A real click in the synthetic human UI accepts the already displayed
        // frozen file; the later native stroke must remain working-only.
        evaluate(activity, "[...document.querySelectorAll('.local-proposal-review button')].find(n=>n.textContent==='Accept file').click()");
        visible(activity, "!document.querySelector('.local-proposal-review')");
        screenshot(activity, "owner-human-file-decision");
        click(activity, "#brandHome");
        click(activity, "#settingsButton");
        click(activity, "#settings-tab-preferences");
        visible(activity, "document.querySelector('#settings-section-appearance')?.hidden === false");
        evaluate(activity, "(()=>{const n=document.querySelector('#settings-group-connected-devices');if(!n.open)n.querySelector('summary').click()})()");
        click(activity, "[data-owner-device-settings]");
        visible(activity, "document.querySelector('.connected-devices-dialog')?.textContent.includes('Create new pairing codes from Context Room on the Mac')");
        assertEquals("Remote owners cannot silently pair another owner", "true", evaluate(activity, "![...document.querySelectorAll('.connected-devices-dialog button')].some(n=>n.textContent==='Create owner pairing code')"));
        screenshot(activity, "owner-settings");
        String reviewPath = ticket.getString("testSharedPath");
        assertFalse("Exercise the exact URL returned by the Mac without a trailing slash", reviewPath.endsWith("/"));
        instrumentation.runOnMainSync(() -> activity.ownerWorkspace.web.loadUrl(activity.ownerWorkspace.origin + reviewPath + "?view=file&file=projects%2Fdrawing%2Fdocs%2FShared.crnb"));
        visible(activity, "location.pathname === " + JSONObject.quote(reviewPath) + " && document.body?.dataset.workspaceDiagnostics && JSON.parse(document.body.dataset.workspaceDiagnostics).phase === 'ready'");
        visible(activity, "Boolean(document.querySelector('.notebook-review-render [data-object-id=shared-shape] rect'))");
        visible(activity, "[...document.querySelectorAll('.notebook-review-origins')].some(n=>n.textContent.includes('Frozen scene r1 · 1 objects'))");
        visible(activity, "(()=>{const n=document.querySelector('.notebook-review-render');return n.checkVisibility({visibilityProperty:true,opacityProperty:true}) && n.getBoundingClientRect().height>200})()");
        System.out.println("Shared rendered scene: " + evaluate(activity, "JSON.stringify({preview:document.querySelector('.notebook-review-render').getBoundingClientRect().toJSON(),origins:document.querySelector('.notebook-review-origins').innerText})"));
        assertEquals("Owner transport must survive the exact review route", "true", evaluate(activity, "Boolean(window.ContextRoomNativeOwner)"));
        screenshot(activity, "owner-shared-review");
      } catch (Throwable error) {
        System.out.println("Owner acceptance failed: " + error);
        try { screenshot(activity, "owner-failure"); } catch (Throwable capture) { error.addSuppressed(capture); }
        if (activity.ownerWorkspace != null) System.out.println("Owner UI failure: " + evaluate(activity, "JSON.stringify({url:location.pathname+location.search,ready:document.body?.dataset.workspaceDiagnostics,title:document.querySelector('#workspaceTitle')?.textContent,body:document.body?.innerText?.slice(0,5000)})"));
        if (!drawing.onUi(activity, () -> activity.resumed)) instrumentation.getUiAutomation().performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK);
        throw error;
      }
    }
  }
}
