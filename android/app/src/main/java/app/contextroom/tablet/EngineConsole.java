package app.contextroom.tablet;

/** Decides which WebView console errors mean the packaged notebook engine failed.
 * BOOX firmware injects a javascript: URL that appends an e-ink <style> to every page; the
 * engine CSP blocks it and Chromium logs that block as an error. It is not an engine fault. */
final class EngineConsole {
  private EngineConsole() {}
  static boolean engineFault(boolean error, String message, String sourceId) {
    if (!error) return false;
    // The engine never styles its page, so a blocked inline style is always someone else's.
    // Chromium words it "Applying inline style violates…"; older WebViews say "Refused to apply inline style…".
    if (message != null && (message.startsWith("Applying inline style violates the following Content Security Policy directive")
        || message.startsWith("Refused to apply inline style because it violates the following Content Security Policy directive"))) return false;
    // A missing source can be the engine itself (evaluateJavascript, a rejected promise): keep it visible.
    if (sourceId == null || sourceId.isEmpty()) return true;
    // Only the packaged engine page and modules can fail the engine; injected scripts have another source.
    return sourceId.startsWith(NotebookEngine.ORIGIN + "/assets/");
  }
  /** What logcat may keep about an ignored error: where it came from, never its text. */
  static String ignored(String sourceId) {
    if (sourceId == null || sourceId.isEmpty()) return "Ignored console error (no source)";
    int colon = sourceId.indexOf(':');
    return "Ignored console error from " + (colon > 0 ? sourceId.substring(0, colon + 1) : "unknown source");
  }
}
