package app.contextroom.tablet;

import static org.junit.Assert.assertEquals;

import android.webkit.WebView;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;

/** C-15: Back with the Conversation panel open closes the panel and keeps the page. */
public final class OwnerBackPanelDeviceTest {
  /** The real header order of assistant.mjs: Stop agent, close, then Share live source and Sketch sheet. */
  private static String page(String closeLabel) {
    return "<body><p id=page>doc</p><aside class='assistant-panel'><header><h2>Conversation</h2>"
      + "<button hidden>Open conversation</button><button hidden>Stop agent</button>"
      + "<button data-assistant-close onclick=\"this.closest('aside').classList.add('assistant-minimized')\">" + closeLabel + "</button>"
      + "<div><button onclick=\"document.body.dataset.shared='1'\">Share live source</button>"
      + "<button onclick=\"document.body.dataset.sheet='1'\">Sketch sheet</button></div></header></aside></body>";
  }

  private String run(WebView web, String script) throws Exception {
    AtomicReference<String> out = new AtomicReference<>(); CountDownLatch done = new CountDownLatch(1);
    InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> web.evaluateJavascript(script, v -> { out.set(v); done.countDown(); }));
    if (!done.await(10, TimeUnit.SECONDS)) throw new AssertionError("script timeout");
    return out.get();
  }

  @Test public void backClosesTextPanelThenFallsThroughToHistory() throws Exception { check("Minimize conversation"); }
  @Test public void backClosesDictatePanel() throws Exception { check("Close"); }
  @Test public void backClosesVoicePanel() throws Exception { check("Close"); }

  private void check(String label) throws Exception {
    WebView[] holder = new WebView[1]; CountDownLatch loaded = new CountDownLatch(1);
    InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
      WebView web = new WebView(InstrumentationRegistry.getInstrumentation().getTargetContext());
      web.getSettings().setJavaScriptEnabled(true);
      web.setWebViewClient(new android.webkit.WebViewClient() { @Override public void onPageFinished(WebView v, String u) { loaded.countDown(); } });
      web.loadDataWithBaseURL("https://example.test/", page(label), "text/html", "utf-8", null); holder[0] = web;
    });
    if (!loaded.await(15, TimeUnit.SECONDS)) throw new AssertionError("page timeout");
    WebView web = holder[0];
    assertEquals("true", run(web, OwnerBack.CLOSE_TOP_DIALOG));
    assertEquals("true", run(web, "document.querySelector('.assistant-panel').classList.contains('assistant-minimized')"));
    assertEquals("\"doc\"", run(web, "document.getElementById('page').textContent"));
    assertEquals("true", run(web, "document.body.dataset.sheet===undefined&&document.body.dataset.shared===undefined"));
    assertEquals("false", run(web, OwnerBack.CLOSE_TOP_DIALOG));
  }
}
