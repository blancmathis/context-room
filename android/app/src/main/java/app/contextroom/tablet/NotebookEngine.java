package app.contextroom.tablet;

import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.webkit.*;
import androidx.webkit.WebViewAssetLoader;
import java.io.ByteArrayInputStream;
import java.util.*;
import java.util.concurrent.*;
import org.json.*;

/** Only the packaged notebook engine has a native bridge. Documents never load here. */
final class NotebookEngine {
  interface Listener { void event(JSONObject event); }
  static final String ORIGIN = "https://appassets.androidplatform.net";
  static final Set<String> ASSETS = new HashSet<>(Arrays.asList("/assets/engine.html", "/assets/engine.mjs", "/assets/compat.mjs",
      "/assets/core/notebook_client.mjs", "/assets/core/notebook_protocol.mjs", "/assets/core/notebook_gestures.mjs", "/assets/core/notebook_native.mjs"));
  final WebView web;
  final Handler main = new Handler(Looper.getMainLooper());
  final Listener listener;
  final ThreadPoolExecutor network = new ThreadPoolExecutor(2, 2, 0, TimeUnit.SECONDS, new ArrayBlockingQueue<>(16));
  volatile DeviceConnection connection;
  volatile boolean closed;

  NotebookEngine(Context context, Listener listener) {
    this.listener = listener;
    web = new WebView(context);
    WebSettings settings = web.getSettings();
    settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
    settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
    settings.setAllowFileAccessFromFileURLs(false); settings.setAllowUniversalAccessFromFileURLs(false);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    settings.setJavaScriptCanOpenWindowsAutomatically(false); settings.setSupportMultipleWindows(false);
    settings.setGeolocationEnabled(false); settings.setMediaPlaybackRequiresUserGesture(true);
    CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
    WebViewAssetLoader assets = new WebViewAssetLoader.Builder().addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(context)).build();
    web.setWebViewClient(new WebViewClient() {
      @Override public WebResourceResponse shouldInterceptRequest(WebView source, WebResourceRequest request) {
        Uri uri = request.getUrl();
        if (!request.getMethod().equals("GET") || !"https".equals(uri.getScheme()) || !"appassets.androidplatform.net".equals(uri.getHost()) || uri.getPort() != -1
            || uri.getQuery() != null || uri.getFragment() != null || !ASSETS.contains(uri.getPath())) return denied();
        WebResourceResponse response = assets.shouldInterceptRequest(uri);
        if (response == null) return denied();
        if (uri.getPath().endsWith(".mjs")) response.setMimeType("text/javascript");
        response.setResponseHeaders(Collections.singletonMap("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"));
        return response;
      }
      @Override public boolean shouldOverrideUrlLoading(WebView source, WebResourceRequest request) { return !request.getUrl().toString().equals(ORIGIN + "/assets/engine.html"); }
      @Override public void onReceivedSslError(WebView source, SslErrorHandler handler, android.net.http.SslError error) { handler.cancel(); }
      @Override public void onReceivedError(WebView source, WebResourceRequest request, WebResourceError error) {
        if (request.isForMainFrame()) listener.event(InkView.json("type", "engineStopped", "message", "Le moteur de dessin n’a pas pu s’ouvrir. Le journal est conservé."));
      }
      @Override public boolean onRenderProcessGone(WebView source, RenderProcessGoneDetail detail) {
        closed = true;
        listener.event(InkView.json("type", "engineStopped", "message", "Le moteur local s’est arrêté. Le journal est conservé ; rouvrez Context Room pour reprendre."));
        return true;
      }
    });
    web.setWebChromeClient(new WebChromeClient() {
      @Override public boolean onConsoleMessage(ConsoleMessage message) {
        if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR) listener.event(InkView.json("type", "error", "message", "Le moteur local a rencontré une erreur. Vérifiez la version d’Android System WebView ; le journal des gestes est conservé."));
        return true;
      }
    });
    web.addJavascriptInterface(new Events(), "NativeEvents");
    web.addJavascriptInterface(new Transport(), "NativeTransport");
    web.loadUrl(ORIGIN + "/assets/engine.html");
  }
  static WebResourceResponse denied() { return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", Collections.emptyMap(), new ByteArrayInputStream(new byte[0])); }
  void call(String method, Object... args) {
    if (closed) return;
    if (!Arrays.asList("response", "catalogue", "session", "open", "command", "view", "refresh", "exportRecovery", "close").contains(method)) throw new IllegalArgumentException("Unknown engine method");
    JSONArray array = new JSONArray(); for (Object arg : args) array.put(arg);
    String json = array.toString();
    main.post(() -> { if (!closed) web.evaluateJavascript("window.ContextRoomNative." + method + ".apply(null,JSON.parse(" + JSONObject.quote(json) + "))", null); });
  }
  final class Events {
    @JavascriptInterface public void emit(String data) {
      if (closed || data == null || data.length() > 64 * 1024 * 1024) return;
      try { JSONObject event = new JSONObject(data); main.post(() -> { if (!closed) listener.event(event); }); }
      catch (JSONException error) { main.post(() -> listener.event(InkView.json("type", "error", "message", "Réponse du moteur local illisible. Le journal est conservé."))); }
    }
  }
  final class Transport {
    @JavascriptInterface public void request(String id, String project, String path, String method, String body) {
      if (closed || id == null || !id.matches("[a-f0-9-]{36}")) return;
      DeviceConnection selected = connection;
      if (selected == null) { respond(id, 503, InkView.json("code", "device_unpaired", "error", "Connectez cette tablette depuis le Mac.")); return; }
      try {
        network.execute(() -> {
          try {
            JSONObject answer = selected.request(project, path, method, body);
            // The RPC id still belongs to its original client and namespace. A
            // later connection selection must not poison that client's receipt.
            respond(id, answer.getInt("status"), answer.getJSONObject("body"));
          } catch (Exception error) {
            String code = error instanceof javax.net.ssl.SSLException ? "device_tls_identity" : "device_network";
            respond(id, 503, InkView.json("code", code, "error", code.equals("device_tls_identity") ? "L’identité sécurisée du Mac n’a pas pu être vérifiée." : "Mac indisponible. Les gestes locaux restent sur la tablette."));
          }
        });
      } catch (RejectedExecutionException error) { respond(id, 429, InkView.json("code", "device_busy", "error", "La connexion est occupée. Les gestes locaux sont conservés.")); }
    }
  }
  private void respond(String id, int status, JSONObject body) { call("response", id, status, body); }
  void close() { if (!closed) call("close"); closed = true; network.shutdownNow(); web.removeJavascriptInterface("NativeEvents"); web.removeJavascriptInterface("NativeTransport"); web.destroy(); }
}
