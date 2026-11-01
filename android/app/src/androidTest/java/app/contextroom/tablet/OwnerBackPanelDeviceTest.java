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
  private static final String PAGE = "<body><p id=page>doc</p><aside class='assistant-panel'><header><h2>Conversation</h2>"
    + "<button hidden>Open conversation</button><button onclick=\"this.closest('aside').classList.add('assistant-minimized')\">Minimize conversation</button></header></aside></body>";

  private String run(WebView web, String script) throws Exception {
    AtomicReference<String> out = new AtomicReference<>(); CountDownLatch done = new CountDownLatch(1);
    InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> web.evaluateJavascript(script, v -> { out.set(v); done.countDown(); }));
    if (!done.await(10, TimeUnit.SECONDS)) throw new AssertionError("script timeout");
    return out.get();
  }

  @Test public void backClosesOpenConversationPanelThenFallsThroughToHistory() throws Exception {
    WebView[] holder = new WebView[1]; CountDownLatch loaded = new CountDownLatch(1);
    InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
      WebView web = new WebView(InstrumentationRegistry.getInstrumentation().getTargetContext());
      web.getSettings().setJavaScriptEnabled(true);
      web.setWebViewClient(new android.webkit.WebViewClient() { @Override public void onPageFinished(WebView v, String u) { loaded.countDown(); } });
      web.loadDataWithBaseURL("https://example.test/", PAGE, "text/html", "utf-8", null); holder[0] = web;
    });
    if (!loaded.await(15, TimeUnit.SECONDS)) throw new AssertionError("page timeout");
    WebView web = holder[0];
    assertEquals("true", run(web, OwnerBack.CLOSE_TOP_DIALOG));
    assertEquals("true", run(web, "document.querySelector('.assistant-panel').classList.contains('assistant-minimized')"));
    assertEquals("\"doc\"", run(web, "document.getElementById('page').textContent"));
    assertEquals("false", run(web, OwnerBack.CLOSE_TOP_DIALOG));
  }
}
