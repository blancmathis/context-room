package app.contextroom.tablet;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONException;
import org.json.JSONObject;

/** Reads the pairing file saved on the Mac (BOOXDrop path for a tablet without a camera). Bounded like the pasted code. */
final class PairingFile {
  static final int MAX_BYTES = 8192;

  /** The ticket JSON; {@code DeviceConnection.pair} still checks every field. Throws a message fit for the screen. */
  static JSONObject parse(InputStream stream) throws IOException {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream(); byte[] chunk = new byte[1024]; int read;
    while ((read = stream.read(chunk)) > 0) {
      bytes.write(chunk, 0, read);
      if (bytes.size() > MAX_BYTES) throw new IOException("Ce fichier est trop gros pour être un fichier d’appairage.");
    }
    try {
      JSONObject ticket = new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
      if (!ticket.has("pairingId") || !ticket.has("token")) throw new JSONException("missing");
      return ticket;
    } catch (JSONException error) { throw new IOException("Ce fichier n’est pas un fichier d’appairage Context Room. Enregistrez-le de nouveau depuis le Mac."); }
  }
  private PairingFile() {}
}
