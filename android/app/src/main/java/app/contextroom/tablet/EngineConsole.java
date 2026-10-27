package app.contextroom.tablet;

/** Decides which WebView console errors mean the packaged notebook engine failed.
 * BOOX firmware injects a javascript: URL that appends an e-ink <style> to every page; the
 * engine CSP blocks it and Chromium logs that block as an error. It is not an engine fault. */
final class EngineConsole {
  private EngineConsole() {}
  static boolean engineFault(boolean error, String message, String sourceId) {
    if (!error) return false;
    // Only the packaged engine page and modules can fail the engine; injected scripts have no such source.
    if (sourceId == null || !sourceId.startsWith(NotebookEngine.ORIGIN + "/assets/")) return false;
    // The engine never styles its page, so a blocked inline style is always someone else's.
    return message == null || !message.startsWith("Applying inline style violates the following Content Security Policy directive");
  }
}
