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
      if (bytes.size() > MAX_BYTES) throw new IOException("This file is too big to be a pairing file.");
    }
    try {
      JSONObject ticket = new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
      if (!ticket.has("pairingId") || !ticket.has("token")) throw new JSONException("missing");
      return ticket;
    } catch (JSONException error) { throw new IOException("This file is not a Context Room pairing file. Save it again from the Mac."); }
  }
  private PairingFile() {}
}
