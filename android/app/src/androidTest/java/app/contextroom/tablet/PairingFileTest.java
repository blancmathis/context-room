package app.contextroom.tablet;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** The pairing file saved on the Mac is read with the same bound as the pasted code. */
@RunWith(AndroidJUnit4.class)
public final class PairingFileTest {
  private static ByteArrayInputStream stream(String text) { return new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8)); }

  @Test public void readsTheTicketSavedOnTheMac() throws Exception {
    JSONObject ticket = PairingFile.parse(stream("{\"protocolVersion\":1,\"pairingId\":\"p\",\"token\":\"t\",\"url\":\"https://192.168.1.2:4401\",\"fingerprint\":\"ab\",\"grants\":[]}"));
    assertEquals("p", ticket.getString("pairingId")); assertEquals("https://192.168.1.2:4401", ticket.getString("url"));
  }

  @Test public void refusesOversizedTextAndNonTicketFiles() {
    assertRefused("{\"pairingId\":\"p\",\"token\":\"" + "x".repeat(PairingFile.MAX_BYTES) + "\"}", "trop gros");
    assertRefused("not json", "fichier d’appairage");
    assertRefused("{\"hello\":1}", "fichier d’appairage");
    assertRefused("", "fichier d’appairage");
  }
  private static void assertRefused(String text, String message) {
    try { PairingFile.parse(stream(text)); fail("accepted"); } catch (IOException error) { assertTrue(error.getMessage(), error.getMessage().contains(message)); }
  }
}
