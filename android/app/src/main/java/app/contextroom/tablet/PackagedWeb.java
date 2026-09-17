package app.contextroom.tablet;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceResponse;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.json.*;

/** Exact build assets from src/ui; no renderer, notebook tools, data or credentials here. */
final class PackagedWeb {
  final Context context;
  final JSONObject index;
  PackagedWeb(Context context) throws Exception { this.context = context; index = new JSONObject(new String(read("web/index.json", 256 * 1024), StandardCharsets.UTF_8)).getJSONObject("files"); }
  byte[] read(String asset, int maximum) throws IOException {
    try (InputStream input = context.getAssets().open(asset)) {
      ByteArrayOutputStream bytes = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int count;
      while ((count = input.read(buffer)) != -1) { if (bytes.size() + count > maximum) throw new IOException("Application embarquée trop grande."); bytes.write(buffer, 0, count); }
      return bytes.toByteArray();
    }
  }
  WebResourceResponse response(Uri uri) throws Exception {
    String key = uri.getEncodedPath() + (uri.getEncodedQuery() == null ? "" : "?" + uri.getEncodedQuery());
    JSONObject asset = index.optJSONObject(key);
    if (asset == null) return null; // A different Mac build must not receive mixed client modules.
    return new WebResourceResponse(asset.getString("type"), "UTF-8", 200, "OK", Collections.singletonMap("Cache-Control", "no-store"), new ByteArrayInputStream(read(asset.getString("asset"), 16 * 1024 * 1024)));
  }
  WebResourceResponse page(boolean drawing, String origin) throws Exception {
    String html = new String(read(drawing ? "web/draw.html" : "web/offline.html", 1024 * 1024), StandardCharsets.UTF_8);
    html = html.replace("<head>", "<head><meta name=\"context-room-native-origin\" content=\"" + origin + "\"><script src=\"/native/owner-bridge.js\"></script>");
    Map<String, String> headers = new HashMap<>(); headers.put("Cache-Control", "no-store");
    headers.put("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    return new WebResourceResponse("text/html", "UTF-8", 200, "OK", headers, new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8)));
  }
}
