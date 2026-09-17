package app.contextroom.tablet;

import android.os.SystemClock;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.webkit.WebView;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;
import static org.junit.Assert.*;

/** Instrumentation-only observation: never dispatches JS events or edits the scene. */
final class OwnerPenProbe {
  private OwnerPenProbe() {}

  static boolean focused(OwnerWorkspaceTest ui, MainActivity activity) {
    return ui.drawing.onUi(activity, () -> activity.resumed && activity.ownerWorkspace != null
      && activity.ownerWorkspace.web.isShown() && activity.ownerWorkspace.web.hasWindowFocus());
  }

  static String activeWindow(OwnerWorkspaceTest ui, MainActivity activity) {
    AccessibilityNodeInfo root = ui.instrumentation.getUiAutomation().getRootInActiveWindow();
    if (root == null) return "unavailable";
    try { return activity.getPackageName().contentEquals(String.valueOf(root.getPackageName())) ? "owner" : "other"; }
    finally { root.recycle(); }
  }

  static void painted(OwnerWorkspaceTest ui, MainActivity activity) throws Exception {
    CountDownLatch complete = new CountDownLatch(1);
    ui.instrumentation.runOnMainSync(() -> activity.ownerWorkspace.web.postVisualStateCallback(
      SystemClock.uptimeMillis(), new WebView.VisualStateCallback() {
        @Override public void onComplete(long requestId) { complete.countDown(); }
      }));
    assertTrue("The common WebView must commit its visual state before physical input", complete.await(10, TimeUnit.SECONDS));
  }

  static void save(OwnerWorkspaceTest ui, MainActivity activity, String phase) throws Exception {
    // Fixed scalar fields only, even when a failure occurs before the notebook opens.
    String encoded = ui.evaluate(activity, "JSON.stringify((()=>{const s=window.sharedNotebook?.surface,c=document.querySelector('canvas.notebook-canvas');return {objects:s?.document.objects.length??null,revision:s?.document.revision??null,saveState:document.querySelector('.notebook-dialog')?.dataset.saveState??null,events:window.__ownerPenEvents??[],canvasWidth:c?.width??0,canvasHeight:c?.height??0,renderedInk:Boolean(window.__ownerPenRendered)}})())");
    JSONObject web = new JSONObject(new JSONArray("[" + encoded + "]").getString(0));
    JSONObject proof = new JSONObject().put("phase", phase).put("ownerFocused", focused(ui, activity))
      .put("activeWindow", activeWindow(ui, activity)).put("web", web);
    try (FileOutputStream output = new FileOutputStream(new File(activity.getFilesDir(), "owner-input-proof.json"))) {
      output.write(proof.toString(2).getBytes(StandardCharsets.UTF_8));
    }
  }

  static void draw(OwnerWorkspaceTest ui, MainActivity activity) throws Exception {
    // A successful OS injection is not proof that this app received it. An ANR
    // window can own input while the WebView still answers evaluateJavascript.
    save(ui, activity, "before-input");
    NotebookDeviceTest.waitFor("Owner input is blocked by another native window", () ->
      focused(ui, activity) && "owner".equals(activeWindow(ui, activity)));
    ui.visible(activity, "window.sharedNotebook?.surface.document.objects.length===0 && document.querySelector('.notebook-dialog')?.dataset.saveState==='confirmed'");
    painted(ui, activity);
    ui.evaluate(activity, "(()=>{window.__ownerPenEvents=[];window.__ownerPenRendered=false;const c=document.querySelector('canvas.notebook-canvas');for(const type of ['pointerdown','pointermove','pointerup','pointercancel'])c.addEventListener(type,event=>{if(window.__ownerPenEvents.length<64)window.__ownerPenEvents.push({type:event.type,pen:event.pointerType==='pen',trusted:event.isTrusted,pressure:event.pressure})},{capture:true,passive:true})})()");
    String bounds = ui.evaluate(activity, "(()=>{const c=document.querySelector('canvas.notebook-canvas'),r=c.getBoundingClientRect(),x=r.left+75,y=r.top+60;return JSON.stringify({x,y,width:innerWidth,hit:[0,1,2].every(n=>document.elementFromPoint(x+n*55,y+n*18)===c)})})()");
    JSONObject point = new JSONObject(new JSONArray("[" + bounds + "]").getString(0));
    assertTrue("Every injected point must hit the common canvas", point.getBoolean("hit"));
    int[] location = new int[2]; AtomicInteger pixels = new AtomicInteger();
    ui.instrumentation.runOnMainSync(() -> { activity.ownerWorkspace.web.getLocationOnScreen(location); pixels.set(activity.ownerWorkspace.web.getWidth()); });
    float scale = (float)(pixels.get() / point.getDouble("width"));
    assertTrue("The WebView coordinate conversion must be finite and positive", Float.isFinite(scale) && scale > 0);
    long down = SystemClock.uptimeMillis();
    int[] actions = { MotionEvent.ACTION_DOWN, MotionEvent.ACTION_MOVE, MotionEvent.ACTION_UP };
    String[] types = { "pointerdown", "pointermove", "pointerup" };
    float[] pressures = { .25f, .75f, .5f };
    for (int n = 0; n < actions.length; n++) {
      assertTrue("The owner must retain native input focus for the entire stroke", focused(ui, activity));
      MotionEvent.PointerProperties properties = new MotionEvent.PointerProperties(); properties.id = 0; properties.toolType = MotionEvent.TOOL_TYPE_STYLUS;
      MotionEvent.PointerCoords coordinates = new MotionEvent.PointerCoords();
      coordinates.x = location[0] + ((float)point.getDouble("x") + n * 55) * scale;
      coordinates.y = location[1] + ((float)point.getDouble("y") + n * 18) * scale;
      coordinates.pressure = pressures[n]; coordinates.size = .1f;
      MotionEvent event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), actions[n], 1,
        new MotionEvent.PointerProperties[]{properties}, new MotionEvent.PointerCoords[]{coordinates},
        0, 0, 1, 1, 0, 0, InputDevice.SOURCE_STYLUS, 0);
      try { assertTrue("Android must accept the stylus injection", ui.instrumentation.getUiAutomation().injectInputEvent(event, true)); }
      finally { event.recycle(); }
      // Wait for observation, never replay an uncertain injection.
      ui.visible(activity, "window.__ownerPenEvents.some(e=>e.type==='" + types[n] + "' && e.pen && e.trusted)");
      save(ui, activity, "received-" + types[n]);
      SystemClock.sleep(40);
    }
    ui.visible(activity, "window.__ownerPenEvents.filter(e=>e.type==='pointerdown').length===1 && window.__ownerPenEvents.filter(e=>e.type==='pointerup').length===1 && !window.__ownerPenEvents.some(e=>e.type==='pointercancel') && [.25,.75].every(p=>window.__ownerPenEvents.some(e=>e.pen&&e.trusted&&e.pressure===p))");
  }

  static void confirmed(OwnerWorkspaceTest ui, MainActivity activity) throws Exception {
    // Read the existing renderer's pixels around the first retained ink point.
    // This does not repaint, replace callbacks, or manufacture a render receipt.
    ui.visible(activity, "(()=>{const s=window.sharedNotebook.surface,c=s.canvas,p=s.document.objects[0]?.points?.[0];if(!p)return false;const r=c.getBoundingClientRect(),x=Math.floor((p[0]*s.view.scale+s.view.x)*c.width/r.width),y=Math.floor((p[1]*s.view.scale+s.view.y)*c.height/r.height);if(x<2||y<2||x+2>=c.width||y+2>=c.height)return false;const bytes=c.getContext('2d').getImageData(x-2,y-2,5,5).data;return window.__ownerPenRendered=Array.from({length:25},(_,i)=>i*4).some(i=>bytes[i+3]>0&&bytes[i]<128&&bytes[i+1]<128&&bytes[i+2]<128)})()");
    painted(ui, activity);
    save(ui, activity, "confirmed");
  }
}
