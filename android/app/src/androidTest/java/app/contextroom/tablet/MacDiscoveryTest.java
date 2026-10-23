package app.contextroom.tablet;

import android.content.Context;
import android.content.ContextWrapper;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Logic only: the emulator NAT carries no real mDNS, so the Bonjour search itself needs the BOOX. */
@RunWith(AndroidJUnit4.class)
public final class MacDiscoveryTest {
  static final String PIN = "ab".repeat(32);
  static Map<String, byte[]> txt(String version, String fingerprint) {
    Map<String, byte[]> result = new HashMap<>();
    if (version != null) result.put("version", version.getBytes(StandardCharsets.UTF_8));
    if (fingerprint != null) result.put("fingerprint", fingerprint.getBytes(StandardCharsets.UTF_8));
    return result;
  }

  @Test public void rejectsServiceWithOtherFingerprintOrVersion() {
    assertTrue(MacDiscovery.accepts(txt("1", PIN), PIN, 4318));
    assertFalse(MacDiscovery.accepts(txt("2", PIN), PIN, 4318));
    assertFalse(MacDiscovery.accepts(txt("1", "cd".repeat(32)), PIN, 4318));
    assertFalse(MacDiscovery.accepts(txt("1", null), PIN, 4318));
    assertFalse(MacDiscovery.accepts(txt("1", PIN), PIN, 0));
    assertFalse(MacDiscovery.accepts(null, PIN, 4318));
  }

  @Test public void ordersIpv4FirstAndCapsCandidates() throws Exception {
    List<InetAddress> addresses = new ArrayList<>();
    addresses.add(InetAddress.getByName("2001:db8::7")); addresses.add(InetAddress.getByName("fe80::1")); addresses.add(InetAddress.getByName("127.0.0.1"));
    for (int n = 1; n <= 40; n++) addresses.add(InetAddress.getByName("192.168.1." + n));
    List<String> urls = MacDiscovery.candidates(addresses, 4318, "https://192.168.1.2:4318");
    assertEquals(MacDiscovery.MAX_ADDRESSES, urls.size());
    assertEquals("https://192.168.1.1:4318", urls.get(0));
    assertFalse(urls.contains("https://192.168.1.2:4318"));
    for (String url : urls) assertFalse(url.contains("fe80") || url.contains("127.0.0.1"));
    List<String> few = MacDiscovery.candidates(Arrays.asList(InetAddress.getByName("2001:db8::7"), InetAddress.getByName("10.0.0.5")), 4318, "");
    assertEquals(Arrays.asList("https://10.0.0.5:4318", "https://[2001:db8:0:0:0:0:0:7]:4318"), few);
  }

  private CredentialVault vault() {
    Context target = InstrumentationRegistry.getInstrumentation().getTargetContext();
    File dir = new File(target.getCacheDir(), "mac-discovery-" + System.nanoTime()); dir.mkdirs();
    return new CredentialVault(new ContextWrapper(target) { @Override public File getNoBackupFilesDir() { return dir; } });
  }
  private JSONObject saved(String url) throws Exception {
    return InkView.json("url", url, "fingerprint", PIN, "serverId", "synthetic-server", "token", "A".repeat(43), "device", InkView.json("id", "synthetic-device"));
  }

  @Test public void adoptionKeepsPinAndHistory() throws Exception {
    CredentialVault vault = vault(); vault.save(saved("https://192.168.1.10:4318"));
    JSONObject moved = vault.adoptAddress("synthetic-server", PIN, "A".repeat(43), "synthetic-device", "https://192.168.1.10:4318", "https://192.168.1.20:4318");
    assertNotNull(moved);
    JSONObject now = vault.read();
    assertEquals("https://192.168.1.20:4318", now.getString("url"));
    assertEquals("https://192.168.1.10:4318", now.getString("pairedUrl"));
    assertEquals(PIN, now.getString("fingerprint")); assertEquals("A".repeat(43), now.getString("token"));
    for (int n = 0; n < 20; n++) {
      String from = vault.read().getString("url");
      assertNotNull(vault.adoptAddress("synthetic-server", PIN, "A".repeat(43), "synthetic-device", from, "https://10.0.0." + (n + 1) + ":4318"));
    }
    JSONObject last = vault.read();
    assertEquals(16, last.getJSONArray("previousUrls").length());
    assertEquals("https://192.168.1.10:4318", last.getString("pairedUrl"));
    new DeviceConnection(last);
  }

  @Test public void adoptionRefusesChangedCredential() throws Exception {
    CredentialVault vault = vault(); vault.save(saved("https://192.168.1.10:4318"));
    String url = "https://192.168.1.10:4318", to = "https://192.168.1.20:4318";
    assertNull(vault.adoptAddress("synthetic-server", PIN, "B".repeat(43), "synthetic-device", url, to));
    assertNull(vault.adoptAddress("synthetic-server", "cd".repeat(32), "A".repeat(43), "synthetic-device", url, to));
    assertNull(vault.adoptAddress("other-server", PIN, "A".repeat(43), "synthetic-device", url, to));
    assertNull(vault.adoptAddress("synthetic-server", PIN, "A".repeat(43), "other-device", url, to));
    assertNull(vault.adoptAddress("synthetic-server", PIN, "A".repeat(43), "synthetic-device", "https://192.168.1.99:4318", to));
    assertEquals(url, vault.read().getString("url"));
  }
}
