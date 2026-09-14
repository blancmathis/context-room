package app.contextroom.tablet;

import android.content.Context;
import android.net.Uri;
import android.os.*;
import android.webkit.*;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import org.json.*;

/** Pinned native transport for the existing owner UI. No bridge in document frames. */
final class OwnerWorkspace {
  interface Host {
    void openNotebook(JSONObject target);
    void ownerError(String message);
    void chooseOwnerFiles(ValueCallback<Uri[]> callback, String[] types, boolean multiple);
    void saveOwnerFile(byte[] bytes, String filename, String type, ValueCallback<Boolean> callback);
    void requestOwnerMicrophone(ValueCallback<Boolean> callback);
  }
  final WebView web;
  final DeviceConnection connection;
  final Host host;
  final NativeAudio audio;
  final String origin;
  final Handler main = new Handler(Looper.getMainLooper());
  final ThreadPoolExecutor network = new ThreadPoolExecutor(4, 4, 0, TimeUnit.SECONDS, new ArrayBlockingQueue<>(32));
  volatile boolean closed, foreground = true;
  volatile String runtimeOrigin = "";
  long generation;

  OwnerWorkspace(Context context, DeviceConnection connection, Host host) throws Exception {
    if (!connection.isOwner() || !connection.serverId.matches("[a-f0-9-]{36}")) throw new IOException("Une connexion propriétaire explicite est nécessaire.");
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) throw new IOException("Mettez Android System WebView à jour pour utiliser l’interface complète.");
    this.connection = connection; this.host = host;
    String device = connection.session.getJSONObject("device").getString("id");
    if (!device.matches("[a-f0-9-]{36}")) throw new IOException("Identité de tablette invalide.");
    origin = "https://owner-" + connection.serverId + "." + device + ".contextroom.invalid";
    web = new WebView(context);
    audio = new NativeAudio(context, event -> { if (!closed) web.evaluateJavascript("window.dispatchEvent(new CustomEvent('context-room-native-audio',{detail:" + event.toString() + "}))", null); });
    WebSettings settings = web.getSettings();
    settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
    settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
    settings.setAllowFileAccessFromFileURLs(false); settings.setAllowUniversalAccessFromFileURLs(false);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    settings.setJavaScriptCanOpenWindowsAutomatically(false); settings.setSupportMultipleWindows(false);
    settings.setGeolocationEnabled(false); settings.setMediaPlaybackRequiresUserGesture(true);
    settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
    CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
    WebViewCompat.addWebMessageListener(web, "ContextRoomOwnerTransport", Collections.singleton(origin), (source, message, sourceOrigin, isMainFrame, reply) -> {
      if (closed || !isMainFrame || !origin.equals(sourceOrigin.toString()) || !ownerPage(source.getUrl())) return;
      String serialized = message.getData();
      if (serialized == null || serialized.length() > 42 * 1024 * 1024) return;
      final long requestedGeneration = generation;
      String errorReplyId = null;
      try {
        JSONObject input = new JSONObject(serialized); String id = input.getString("id"), action = input.getString("action");
        if (!id.matches("[a-f0-9-]{36}")) return;
        errorReplyId = id;
        if (!foreground) { reply.postMessage(InkView.json("id", id, "error", "L’interface propriétaire est en pause.").toString()); return; }
        JSONObject value = input.getJSONObject("value");
        if (action.startsWith("audio.")) {
          ValueCallback<JSONObject> answer = result -> { if (!closed && requestedGeneration == generation) reply.postMessage((result.has("error")
            ? InkView.json("id", id, "error", result.optString("error")) : InkView.json("id", id, "result", result)).toString()); };
          if (action.equals("audio.controller")) { audio.bind(value); answer.onReceiveValue(InkView.json("bound", true)); }
          else if (action.equals("audio.permission")) host.requestOwnerMicrophone(granted -> answer.onReceiveValue(InkView.json("granted", granted)));
          else if (action.equals("audio.recording.start")) host.requestOwnerMicrophone(granted -> {
            try { if (!granted || closed || !foreground || requestedGeneration != generation) throw new IOException("Le microphone n’a pas été autorisé pour cette conversation."); audio.start(value, answer); }
            catch (Exception error) { answer.onReceiveValue(NativeAudio.error(error.getMessage())); }
          });
          else if (action.equals("audio.recording.finish")) audio.finish(value, answer);
          else if (action.equals("audio.recording.recover")) audio.recover(value, answer);
          else if (action.equals("audio.recording.acknowledge")) audio.acknowledge(value, answer);
          else if (action.equals("audio.play")) audio.play(value, answer);
          else if (action.equals("audio.stop-playback") || action.equals("audio.stop")) {
            boolean current = audio.epoch.equals(value.optString("epoch")) && audio.conversation.equals(value.optString("conversationId"));
            if (current) { if (action.equals("audio.stop")) audio.stop(); else audio.stopPlayback(); }
            answer.onReceiveValue(InkView.json("stopped", current));
          }
          else throw new IOException("Opération audio indisponible.");
          return;
        }
        if (action.equals("file.choose-images")) {
          host.chooseOwnerFiles(uris -> {
            try { network.execute(() -> {
              JSONObject answer;
              try {
                JSONArray files = new JSONArray();
                if (uris != null && uris.length > 0) {
                  Uri uri = uris[0]; android.content.ContentResolver resolver = context.getContentResolver();
                  String type = resolver.getType(uri), filename = "Image";
                  if (!Arrays.asList("image/png", "image/jpeg", "image/webp").contains(type)) throw new IOException("Format d’image indisponible.");
                  try (android.database.Cursor metadata = resolver.query(uri, new String[]{android.provider.OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                    if (metadata != null && metadata.moveToFirst()) filename = metadata.getString(0);
                  }
                  ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                  try (InputStream inputFile = resolver.openInputStream(uri)) {
                    if (inputFile == null) throw new IOException("Image indisponible.");
                    byte[] buffer = new byte[8192]; int count;
                    while ((count = inputFile.read(buffer)) != -1) { if (bytes.size() + count > 12 * 1024 * 1024) throw new IOException("Image trop volumineuse."); bytes.write(buffer, 0, count); }
                  }
                  files.put(InkView.json("name", filename == null ? "Image" : filename.substring(0, Math.min(filename.length(), 180)), "type", type,
                    "body", android.util.Base64.encodeToString(bytes.toByteArray(), android.util.Base64.NO_WRAP)));
                }
                answer = InkView.json("id", id, "result", InkView.json("files", files));
              } catch (Exception error) { answer = InkView.json("id", id, "error", "L’image n’a pas pu être ouverte. Choisissez un PNG, JPEG ou WebP de 12 Mio maximum."); }
              final String response = answer.toString();
              main.post(() -> { if (!closed && generation == requestedGeneration) reply.postMessage(response); });
            }); } catch (RejectedExecutionException error) { if (!closed) reply.postMessage(InkView.json("id", id, "error", "La connexion est occupée.").toString()); }
          }, new String[]{"image/png", "image/jpeg", "image/webp"}, false); return;
        }
        if (action.equals("file.save")) {
          String filename = value.optString("filename"), type = value.optString("type"), encoded = value.optString("body");
          if (filename.isEmpty() || filename.length() > 180 || filename.matches(".*[\\\\/\\x00-\\x1f].*") || filename.equals(".") || filename.equals("..")
            || !type.matches("[a-z]+/[a-zA-Z0-9.+_-]+") || encoded.length() > 40 * 1024 * 1024) throw new IOException("Export invalide.");
          byte[] bytes = android.util.Base64.decode(encoded, android.util.Base64.NO_WRAP);
          if (bytes.length > 30 * 1024 * 1024 || !android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP).equals(encoded)) throw new IOException("Export invalide.");
          host.saveOwnerFile(bytes, filename, type, saved -> {
            if (!closed && generation == requestedGeneration) reply.postMessage(InkView.json("id", id, "result", InkView.json("saved", saved)).toString());
          }); return;
        }
        if (action.equals("notebook.open")) {
          if (!value.optString("projectId").matches("[a-f0-9]{24}") || !value.optString("path").endsWith(".crnb") || value.optString("path").length() > 4096) throw new IOException("Carnet invalide.");
          reply.postMessage(InkView.json("id", id, "result", InkView.json("requested", true)).toString());
          host.openNotebook(value); return;
        }
        if (!Arrays.asList("request", "events").contains(action)) throw new IOException("Opération native indisponible.");
        try {
          network.execute(() -> {
            JSONObject answer;
            try {
              if (closed) throw new IOException("L’interface propriétaire est fermée.");
              answer = InkView.json("id", id, "result", connection.owner(action, value));
            } catch (Exception error) { answer = InkView.json("id", id, "error", safeError(error)); }
            final String response = answer.toString();
            main.post(() -> { if (!closed && generation == requestedGeneration) reply.postMessage(response); });
          });
        } catch (RejectedExecutionException error) { reply.postMessage(InkView.json("id", id, "error", "La connexion est occupée. Réessayez après la fin de l’opération.").toString()); }
      } catch (Exception error) { if (errorReplyId != null) reply.postMessage(InkView.json("id", errorReplyId, "error", safeError(error)).toString()); host.ownerError(safeError(error)); }
    });
    web.setWebViewClient(new WebViewClient() {
      @Override public void onPageStarted(WebView source, String url, android.graphics.Bitmap favicon) { generation++; audio.stop(); }
      @Override public WebResourceResponse shouldInterceptRequest(WebView source, WebResourceRequest request) {
        if (closed || !foreground || !sameOrigin(request.getUrl()) || !request.getMethod().equals("GET")) return NotebookEngine.denied();
        String path = request.getUrl().getEncodedPath(), query = request.getUrl().getEncodedQuery();
        if (request.isForMainFrame() && !ownerPage(request.getUrl().toString())) return NotebookEngine.denied();
        try {
          if (path.equals("/native/owner-bridge.js") && !request.isForMainFrame()) return new WebResourceResponse("text/javascript", "UTF-8", context.getAssets().open("owner-bridge.js"));
          JSONObject answer = connection.owner("request", InkView.json("version", 1, "method", "GET", "path", path + (query == null ? "" : "?" + query), "headers", new JSONObject(), "body", ""));
          int status = answer.getInt("status");
          if (status >= 300 && status < 400) throw new IOException("Redirection de l’interface refusée.");
          byte[] bytes = android.util.Base64.decode(answer.getString("body"), android.util.Base64.NO_WRAP);
          JSONObject rawHeaders = answer.getJSONObject("headers"); Map<String, String> headers = new HashMap<>();
          for (Iterator<String> keys = rawHeaders.keys(); keys.hasNext();) { String key = keys.next(); headers.put(key, rawHeaders.getString(key)); }
          headers.put("Cache-Control", "no-store");
          String type = headers.getOrDefault("content-type", "application/octet-stream").split(";", 2)[0];
          if (request.isForMainFrame() && status == 200) {
            if (!type.equals("text/html")) throw new IOException("L’interface du Mac est invalide.");
            String sourceOrigin = answer.getString("origin");
            if (!sourceOrigin.matches("http://(?:127\\.0\\.0\\.1|\\[::1\\]):[0-9]{1,5}")) throw new IOException("L’origine du Mac est invalide.");
            runtimeOrigin = sourceOrigin;
            String html = new String(bytes, StandardCharsets.UTF_8);
            if (!html.contains("<head>")) throw new IOException("L’interface du Mac est incomplète.");
            html = html.replace("<head>", "<head><meta name=\"context-room-native-origin\" content=\"" + runtimeOrigin + "\"><script src=\"/native/owner-bridge.js\"></script>");
            bytes = html.getBytes(StandardCharsets.UTF_8);
          }
          return new WebResourceResponse(type, "UTF-8", status, status >= 400 ? "Request failed" : "OK", headers, new ByteArrayInputStream(bytes));
        } catch (Exception error) {
          if (request.isForMainFrame()) main.post(() -> host.ownerError(safeError(error)));
          return new WebResourceResponse("text/plain", "UTF-8", 503, "Unavailable", Collections.emptyMap(), new ByteArrayInputStream("Mac indisponible. Revenez à la connexion pour réessayer ; les carnets locaux sont conservés.".getBytes(StandardCharsets.UTF_8)));
        }
      }
      @Override public boolean shouldOverrideUrlLoading(WebView source, WebResourceRequest request) {
        if (!request.isForMainFrame()) return !sameOrigin(request.getUrl());
        if (ownerPage(request.getUrl().toString())) return false;
        String value = request.getUrl().toString();
        if (!runtimeOrigin.isEmpty() && value.startsWith(runtimeOrigin + "/")) {
          String mapped = origin + value.substring(runtimeOrigin.length());
          if (ownerPage(mapped)) { source.loadUrl(mapped); return true; }
        }
        main.post(() -> host.ownerError("Ce lien ne fait pas partie de l’interface Context Room connectée.")); return true;
      }
      @Override public void onReceivedSslError(WebView source, SslErrorHandler handler, android.net.http.SslError error) { handler.cancel(); }
      @Override public boolean onRenderProcessGone(WebView source, RenderProcessGoneDetail detail) { closed = true; audio.close(); network.shutdownNow(); host.ownerError("L’interface s’est arrêtée. Revenez à la connexion pour la rouvrir."); return true; }
    });
    web.setWebChromeClient(new WebChromeClient() {
      @Override public boolean onConsoleMessage(ConsoleMessage message) { return true; }
      @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
      @Override public boolean onShowFileChooser(WebView source, ValueCallback<Uri[]> callback, FileChooserParams parameters) {
        // WebChromeClient does not identify the requesting frame. File access
        // uses the main-frame-only message listener instead.
        callback.onReceiveValue(null);
        return true;
      }
    });
    web.loadUrl(origin + "/?hub=1");
  }
  boolean sameOrigin(Uri uri) { return "https".equals(uri.getScheme()) && uri.getPort() == -1 && origin.equals("https://" + uri.getHost()) && uri.getUserInfo() == null; }
  boolean ownerPage(String value) {
    if (value == null) return false;
    Uri uri = Uri.parse(value);
    return sameOrigin(uri) && ("/".equals(uri.getPath()) || uri.getPath().matches("/reviews/[A-Za-z0-9_-]+/?"));
  }
  static String safeError(Exception error) {
    return error instanceof javax.net.ssl.SSLException ? "L’identité sécurisée du Mac a changé. La connexion est refusée."
      : "Connexion propriétaire indisponible. Vérifiez le Mac et l’appairage ; les changements déjà enregistrés sont conservés.";
  }
  void foreground(boolean enabled) {
    foreground = enabled;
    audio.foreground(enabled);
    if (closed) return;
    web.evaluateJavascript("window.dispatchEvent(new CustomEvent('context-room-native-active',{detail:" + enabled + "}))", null);
    if (enabled) web.onResume(); else web.onPause();
  }
  void close() { closed = true; audio.close(); network.shutdownNow(); WebViewCompat.removeWebMessageListener(web, "ContextRoomOwnerTransport"); web.destroy(); }
}
