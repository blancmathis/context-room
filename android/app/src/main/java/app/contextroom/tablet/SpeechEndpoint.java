package app.contextroom.tablet;

/** Local energy endpoint, not speech recognition. At 16 kHz, PCM16 mono. */
final class SpeechEndpoint {
  double noise = 90, voiced, quiet, elapsed;
  boolean started, ended;
  String push(byte[] pcm, int length) {
    if (ended || length < 2) return null;
    double energy = 0;
    for (int i = 0; i + 1 < length; i += 2) { int sample = (short) ((pcm[i] & 255) | (pcm[i + 1] << 8)); energy += (double) sample * sample; }
    double rms = Math.sqrt(energy / (length / 2)), ms = length / 32.0;
    elapsed += ms; String event = null;
    if (rms > Math.max(240, noise * 3)) {
      voiced += ms; quiet = 0;
      if (!started && voiced >= 120) { started = true; event = "speech-start"; }
    } else { if (!started) { noise = noise * .95 + rms * .05; voiced = 0; } quiet += ms; }
    if (started && quiet >= 1200 || !started && elapsed >= 15000 || elapsed >= 120000) { ended = true; return "speech-end"; }
    return event;
  }
}
