package app.contextroom.tablet;

import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import org.json.JSONObject;

/**
 * Finds the paired Mac again after its address changed. Bonjour is only a hint: a candidate is
 * adopted after the pinned TLS certificate answers as the same Mac. The pin never changes here.
 * It runs only after a network failure or when the app returns to the foreground, never in the
 * background, and needs no permission beyond INTERNET.
 */
final class MacDiscovery {
  static final String TYPE = "_contextroom._tcp.";
  static final long WINDOW_MS = 12_000, FIRST_BACKOFF_MS = 30_000, MAX_BACKOFF_MS = 120_000, PROBE_BUDGET_MS = 45_000;
  static final int MAX_SERVICES = 32, MAX_ADDRESSES = 32;

  interface Host {
    DeviceConnection connection();
    /** Main thread: the connection now uses the rediscovered address. */
    void found(DeviceConnection connection, String url);
  }

  private final NsdManager nsd;
  private final CredentialVault vault;
  private final Host host;
  private final Handler main = new Handler(Looper.getMainLooper());
  private final ExecutorService probe = Executors.newSingleThreadExecutor();
  private final List<NsdManager.ServiceInfoCallback> callbacks = new ArrayList<>();
  private final ArrayDeque<NsdServiceInfo> queue = new ArrayDeque<>();
  private NsdManager.DiscoveryListener listener;
  private boolean foreground, resolving, closed;
  private int run, services;
  private long nextAllowed, backoff;
  private DeviceConnection searching;

  MacDiscovery(android.content.Context context, CredentialVault vault, Host host) {
    this.nsd = (NsdManager) context.getSystemService(android.content.Context.NSD_SERVICE); this.vault = vault; this.host = host;
  }

  /** TXT filter: same protocol version and the pinned fingerprint, on a valid port. */
  static boolean accepts(Map<String, byte[]> attributes, String fingerprint, int port) {
    if (attributes == null || port < 1 || port > 65535) return false;
    byte[] version = attributes.get("version"), print = attributes.get("fingerprint");
    return version != null && print != null && "1".equals(new String(version, StandardCharsets.UTF_8))
        && fingerprint.equalsIgnoreCase(new String(print, StandardCharsets.UTF_8));
  }

  /** Candidate base URLs: IPv4 first, scoped or link-local IPv6 dropped, capped, never the current one. */
  static List<String> candidates(List<InetAddress> addresses, int port, String current) {
    List<String> v4 = new ArrayList<>(), v6 = new ArrayList<>();
    for (InetAddress address : addresses) {
      if (address.isAnyLocalAddress() || address.isLoopbackAddress() || address.isMulticastAddress() || address.isLinkLocalAddress()) continue;
      String text = address.getHostAddress(); int scope = text.indexOf('%'); if (scope >= 0) text = text.substring(0, scope);
      String url = address instanceof Inet6Address ? "https://[" + text + "]:" + port : "https://" + text + ":" + port;
      List<String> target = address instanceof Inet6Address ? v6 : v4;
      if (!url.equals(current) && !v4.contains(url) && !v6.contains(url)) target.add(url);
    }
    v4.addAll(v6);
    return v4.size() > MAX_ADDRESSES ? new ArrayList<>(v4.subList(0, MAX_ADDRESSES)) : v4;
  }

  /** Any thread. Called when the Mac could not be reached. */
  void failed() { main.post(this::start); }

  /** Main thread. The app is visible again: forget the backoff and search if the last call failed. */
  void foreground(boolean visible) {
    foreground = visible;
    if (!visible) { stop(); return; }
    backoff = 0; nextAllowed = 0;
    DeviceConnection current = host.connection();
    if (current != null && current.lastFailed) start();
  }

  void close() { closed = true; stop(); probe.shutdownNow(); }

  private void start() {
    DeviceConnection current = host.connection();
    if (closed || !foreground || nsd == null || current == null || searching != null || System.currentTimeMillis() < nextAllowed) return;
    searching = current; services = 0; run++;
    final int thisRun = run;
    listener = new NsdManager.DiscoveryListener() {
      public void onStartDiscoveryFailed(String type, int code) { main.post(() -> finish(thisRun, false)); }
      public void onStopDiscoveryFailed(String type, int code) {}
      public void onDiscoveryStarted(String type) {}
      public void onDiscoveryStopped(String type) {}
      public void onServiceLost(NsdServiceInfo info) {}
      public void onServiceFound(NsdServiceInfo info) { main.post(() -> resolve(thisRun, info)); }
    };
    try { nsd.discoverServices(TYPE, NsdManager.PROTOCOL_DNS_SD, listener); }
    catch (RuntimeException error) { finish(thisRun, false); return; }
    main.postDelayed(() -> finish(thisRun, false), WINDOW_MS);
  }

  private void resolve(int thisRun, NsdServiceInfo info) {
    if (thisRun != run || searching == null || services >= MAX_SERVICES || info.getServiceType() == null || !info.getServiceType().startsWith("_contextroom._tcp")) return;
    services++;
    if (Build.VERSION.SDK_INT >= 34) {
      NsdManager.ServiceInfoCallback callback = new NsdManager.ServiceInfoCallback() {
        public void onServiceInfoCallbackRegistrationFailed(int code) {}
        public void onServiceUpdated(NsdServiceInfo updated) { consider(thisRun, updated, updated.getHostAddresses()); }
        public void onServiceLost() {}
        public void onServiceInfoCallbackUnregistered() {}
      };
      callbacks.add(callback);
      try { nsd.registerServiceInfoCallback(info, main::post, callback); } catch (RuntimeException error) { callbacks.remove(callback); }
    } else { queue.add(info); resolveNext(thisRun); }
  }

  @SuppressWarnings("deprecation")
  private void resolveNext(int thisRun) {
    if (resolving || queue.isEmpty() || thisRun != run) return;
    resolving = true;
    try {
      nsd.resolveService(queue.poll(), new NsdManager.ResolveListener() {
        public void onResolveFailed(NsdServiceInfo info, int code) { main.post(() -> { resolving = false; resolveNext(thisRun); }); }
        public void onServiceResolved(NsdServiceInfo info) {
          main.post(() -> { resolving = false; consider(thisRun, info, info.getHost() == null ? new ArrayList<InetAddress>() : Collections.singletonList(info.getHost())); resolveNext(thisRun); });
        }
      });
    } catch (RuntimeException error) { resolving = false; }
  }

  private void consider(int thisRun, NsdServiceInfo info, List<InetAddress> addresses) {
    DeviceConnection current = searching;
    if (thisRun != run || current == null || !accepts(info.getAttributes(), current.fingerprint, info.getPort())) return;
    final List<String> urls = candidates(addresses, info.getPort(), current.endpoint.toString());
    if (urls.isEmpty()) return;
    final long deadline = System.currentTimeMillis() + PROBE_BUDGET_MS;
    try {
      probe.execute(() -> {
        for (String url : urls) {
          if (System.currentTimeMillis() > deadline) return;
          try {
            DeviceConnection candidate = new DeviceConnection(InkView.json("url", url, "fingerprint", current.fingerprint, "serverId", current.serverId, "token", current.credential,
                "device", current.session.getJSONObject("device")));
            candidate.connectTimeout = 2000;
            // The pinned TLS check fails before any request, so a stranger never receives the token.
            if (!candidate.sameMac()) continue;
            String expected = current.endpoint.toString();
            if (vault.adoptAddress(current.serverId, current.fingerprint, current.credential, current.session.getJSONObject("device").getString("id"), expected, url) == null) return;
            main.post(() -> { if (closed || host.connection() != current) return; backoff = 0; nextAllowed = 0; finish(thisRun, true); try { current.adopt(url); host.found(current, url); } catch (Exception ignored) {} });
            return;
          } catch (Exception ignored) { /* Try the next address. */ }
        }
      });
    } catch (RejectedExecutionException ignored) {}
  }

  private void finish(int thisRun, boolean success) {
    if (thisRun != run || searching == null) return;
    stop();
    if (!success) { backoff = backoff == 0 ? FIRST_BACKOFF_MS : Math.min(backoff * 2, MAX_BACKOFF_MS); nextAllowed = System.currentTimeMillis() + backoff; }
  }

  private void stop() {
    run++; searching = null; resolving = false; queue.clear();
    if (nsd == null) return;
    if (listener != null) { try { nsd.stopServiceDiscovery(listener); } catch (RuntimeException ignored) {} listener = null; }
    if (Build.VERSION.SDK_INT >= 34) { for (NsdManager.ServiceInfoCallback callback : callbacks) { try { nsd.unregisterServiceInfoCallback(callback); } catch (RuntimeException ignored) {} } }
    callbacks.clear();
  }
}
