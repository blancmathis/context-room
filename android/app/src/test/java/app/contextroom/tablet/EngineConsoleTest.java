package app.contextroom.tablet;

import static org.junit.Assert.*;
import org.junit.Test;

public final class EngineConsoleTest {
  static final String ENGINE = "https://appassets.androidplatform.net/assets/engine.mjs";
  // Logged by BOOX Note Air5 C (firmware 4.2, WebView 146) at every engine start.
  static final String BOOX_STYLE = "Applying inline style violates the following Content Security Policy directive 'default-src 'none''. Either the 'unsafe-inline' keyword, a hash ('sha256-iUeU3VeCZC09nvCwgcgZEwFGpImzFhCwqXxAvvFBEPw='), or a nonce ('nonce-...') is required to enable inline execution. Note also that 'style-src' was not explicitly set, so 'default-src' is used as a fallback. The action has been blocked.";

  @Test public void booxInjectedStyleIsNotAnEngineFault() {
    assertFalse(EngineConsole.engineFault(true, BOOX_STYLE, ""));
    assertFalse(EngineConsole.engineFault(true, BOOX_STYLE, null));
    assertFalse(EngineConsole.engineFault(true, BOOX_STYLE, "https://appassets.androidplatform.net/assets/engine.html"));
  }

  @Test public void injectedScriptErrorsAreNotEngineFaults() {
    assertFalse(EngineConsole.engineFault(true, "Uncaught TypeError: x is undefined", "javascript:(function(){})()"));
  }

  @Test public void packagedEngineErrorsStayVisible() {
    assertTrue(EngineConsole.engineFault(true, "Uncaught SyntaxError: Unexpected token '?'", ENGINE));
    assertTrue(EngineConsole.engineFault(true, "Failed to load resource: the server responded with a status of 403 ()", "https://appassets.androidplatform.net/assets/core/notebook_client.mjs"));
    assertTrue(EngineConsole.engineFault(true, "Refused to load the script because it violates the following Content Security Policy directive", "https://appassets.androidplatform.net/assets/engine.html"));
    assertFalse(EngineConsole.engineFault(false, "Uncaught SyntaxError", ENGINE));
  }
}
