package app.contextroom.tablet;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.cert.*;
import java.util.*;
import javax.net.ssl.*;
import org.json.*;

/** Native-only, certificate-pinned transport. No credential enters the WebView. */
final class DeviceConnection {
  static final int MAX_BYTES = 30 * 1024 * 1024;
  static final Set<String> READS = new HashSet<>(Arrays.asList("/device/session", "/api/notebooks", "/api/notebooks/capabilities", "/api/notebooks/scene", "/api/notebooks/receipt", "/api/notebooks/export"));
  static final Set<String> WRITES = new HashSet<>(Arrays.asList("/api/notebooks/open", "/api/notebooks/mutate", "/api/notebooks/batch", "/api/notebooks/undo", "/api/notebooks/asset"));
  final URI endpoint;
  final String fingerprint, serverId, credential;
  final JSONObject session;
  final SSLSocketFactory sockets;

  DeviceConnection(JSONObject saved) throws Exception {
    endpoint = endpoint(saved.getString("url"));
    fingerprint = saved.getString("fingerprint").replace(":", "").toLowerCase(Locale.ROOT);
    if (!fingerprint.matches("[a-f0-9]{64}")) throw new IOException("Empreinte de certificat invalide.");
    serverId = saved.getString("serverId");
    credential = saved.optString("token");
    if (!credential.isEmpty() && !credential.matches("[A-Za-z0-9_-]{43}")) throw new IOException("Identifiant de connexion invalide.");
    session = saved.optJSONObject("device") == null ? null : InkView.json("serverId", serverId, "device", saved.getJSONObject("device"));
    SSLContext context = SSLContext.getInstance("TLS");
    context.init(null, new TrustManager[] {new X509TrustManager() {
      public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
      public void checkClientTrusted(X509Certificate[] chain, String auth) throws CertificateException { throw new CertificateException("Server-only connection"); }
      public void checkServerTrusted(X509Certificate[] chain, String auth) throws CertificateException {
        if (chain == null || chain.length == 0) throw new CertificateException("Missing pinned certificate");
        chain[0].checkValidity();
        try { if (!MessageDigest.isEqual(hexBytes(fingerprint), MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded()))) throw new CertificateException("The Mac certificate changed"); }
        catch (GeneralSecurityException error) { throw new CertificateException("Pinned certificate verification failed", error); }
      }
    }}, new SecureRandom());
    sockets = context.getSocketFactory();
  }

  static URI endpoint(String value) throws Exception {
    URI uri = new URI(value);
    if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null
        || !(uri.getPath().isEmpty() || uri.getPath().equals("/")) || uri.getPort() < 1 || uri.getPort() > 65535)
      throw new IOException("Collez une connexion HTTPS complète créée sur le Mac.");
    return new URI("https", null, uri.getHost(), uri.getPort(), null, null, null);
  }

  static byte[] hexBytes(String value) {
    byte[] result = new byte[value.length()/2];
    for (int n = 0; n < result.length; n++) result[n] = (byte)Integer.parseInt(value.substring(n*2,n*2+2),16);
    return result;
  }
  static String sha256(byte[] value) throws Exception {
    StringBuilder result = new StringBuilder();
    for (byte b : MessageDigest.getInstance("SHA-256").digest(value)) result.append(String.format(Locale.ROOT, "%02x", b & 255));
    return result.toString();
  }

  boolean permittedProject(String project) {
    if (isOwner()) return project != null && project.matches("[a-f0-9]{24}");
    if (session == null) return false;
    JSONArray grants = session.optJSONObject("device").optJSONArray("grants");
    for (int n = 0; grants != null && n < grants.length(); n++) if (project.equals(grants.optJSONObject(n).optString("projectId"))) return true;
    return false;
  }

  boolean isOwner() {
    JSONArray grants = session == null ? null : session.optJSONObject("device").optJSONArray("grants");
    for (int n = 0; grants != null && n < grants.length(); n++) {
      JSONObject grant = grants.optJSONObject(n);
      if (grant != null && "owner".equals(grant.optString("mode")) && serverId.equals(grant.optString("serverId"))) return true;
    }
    return false;
  }

  JSONObject owner(String action, JSONObject request) throws Exception {
    if (!isOwner() || credential.isEmpty() || !Arrays.asList("request", "events").contains(action)) throw new IOException("Cette connexion n’autorise pas l’interface complète.");
    JSONObject response = exchange("/device/owner/" + action, "POST", request.toString(), "", true, 42 * 1024 * 1024);
    if (response.getInt("status") != 200) throw new IOException(response.getJSONObject("body").optString("error", "Connexion propriétaire indisponible."));
    return response.getJSONObject("body");
  }

  JSONObject request(String project, String path, String method, String body) throws Exception {
    String route = path.split("\\?", 2)[0];
    URI relative = new URI(path);
    if (!path.startsWith("/") || path.startsWith("//") || relative.isAbsolute() || relative.getFragment() != null || !route.equals(relative.getPath()) || route.contains("%") || route.contains("\\") || !relative.normalize().equals(relative))
      throw new IOException("Chemin de connexion interdit.");
    if (!(method.equals("GET") && READS.contains(route) || method.equals("POST") && WRITES.contains(route))) throw new IOException("Opération hors de la permission de dessin.");
    if (!route.equals("/device/session") && !permittedProject(project)) throw new IOException("Projet hors de cette connexion.");
    if (credential.isEmpty()) throw new IOException("La tablette n’est pas connectée.");
    return exchange(path, method, body, project, true);
  }

  JSONObject exchange(String path, String method, String body, String project, boolean authenticated) throws Exception {
    return exchange(path, method, body, project, authenticated, MAX_BYTES);
  }
  JSONObject exchange(String path, String method, String body, String project, boolean authenticated, int maximum) throws Exception {
    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
    if (bytes.length > maximum) throw new IOException("La requête dépasse la taille autorisée. Le journal est conservé.");
    HttpsURLConnection connection = (HttpsURLConnection) endpoint.resolve(path).toURL().openConnection();
    connection.setSSLSocketFactory(sockets);
    // The exact leaf certificate, transferred by the local owner, is the authority.
    connection.setHostnameVerifier((host, tls) -> {
      try { return fingerprint.equals(sha256(tls.getPeerCertificates()[0].getEncoded())); } catch (Exception error) { return false; }
    });
    connection.setInstanceFollowRedirects(false);
    connection.setConnectTimeout(5000); connection.setReadTimeout(10000);
    connection.setRequestMethod(method);
    connection.setRequestProperty("Accept", "application/json");
    if (authenticated) {
      connection.setRequestProperty("Authorization", "Bearer " + credential);
      connection.setRequestProperty("x-context-room-device-protocol", "1");
      if (!project.isEmpty()) connection.setRequestProperty("x-context-room-device-project", project);
    }
    try {
      if (method.equals("POST")) {
        connection.setRequestProperty("Content-Type", "application/json");
        connection.setDoOutput(true); connection.setFixedLengthStreamingMode(bytes.length);
        try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
      }
      int status = connection.getResponseCode();
      if (status >= 300 && status < 400) throw new IOException("La connexion a demandé une redirection. Elle a été refusée.");
      if (connection.getContentLengthLong() > maximum) throw new IOException("Réponse trop grande.");
      InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
      if (stream == null) throw new IOException("Le Mac n’a pas renvoyé de réponse.");
      ByteArrayOutputStream data = new ByteArrayOutputStream();
      try (InputStream input = stream) {
        byte[] buffer = new byte[8192]; int count;
        while ((count = input.read(buffer)) != -1) { if (data.size() + count > maximum) throw new IOException("Réponse trop grande."); data.write(buffer, 0, count); }
      }
      JSONObject result = new JSONObject(data.toString(StandardCharsets.UTF_8.name()));
      return InkView.json("status", status, "body", result);
    } finally { connection.disconnect(); }
  }

  // Called only by native foreground navigation, never by the JavaScript bridge.
  JSONObject navigation(String action, JSONObject body) throws Exception {
    if (!Arrays.asList("poll", "receipt").contains(action) || credential.isEmpty() || session == null) throw new IOException("Navigation hors de cette connexion.");
    return exchange("/device/navigation/" + action, "POST", body.toString(), "", true);
  }

  static JSONObject pair(JSONObject ticket) throws Exception {
    if (ticket.optInt("protocolVersion") != 1 || ticket.optLong("expiresAt") <= System.currentTimeMillis()) throw new IOException("Ce code a expiré. Créez-en un autre sur le Mac.");
    DeviceConnection pending = new DeviceConnection(InkView.json("url", ticket.getString("url"), "fingerprint", ticket.getString("fingerprint"), "serverId", ticket.getString("serverId")));
    JSONObject answer = pending.exchange("/device/pair", "POST", InkView.json("protocolVersion", 1, "pairingId", ticket.getString("pairingId"), "token", ticket.getString("token")).toString(), "", false);
    JSONObject body = answer.getJSONObject("body");
    if (answer.getInt("status") != 201) throw new IOException(body.optString("error", "Le code de connexion a été refusé."));
    if (body.optInt("protocolVersion") != 1 || !pending.serverId.equals(body.optString("serverId"))) throw new IOException("La réponse appartient à un autre Mac.");
    if (!InkView.sameJson(ticket.optJSONArray("grants"), body.getJSONObject("device").optJSONArray("grants"))) throw new IOException("Les permissions reçues ne correspondent pas au code choisi.");
    JSONObject saved = InkView.copy(body);
    saved.put("url", pending.endpoint.toString()).put("fingerprint", pending.fingerprint);
    new DeviceConnection(saved);
    return saved;
  }
}
