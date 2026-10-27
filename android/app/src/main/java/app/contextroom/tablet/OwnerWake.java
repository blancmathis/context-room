package app.contextroom.tablet;

/** On wake the WebView hands focus back to the first text field and the e-ink keyboard opens without a tap.
 * Drop focus from a text field on wake; the next tap opens the keyboard on purpose. */
final class OwnerWake {
  private OwnerWake() {}
  static final String DROP_TEXT_FOCUS = "(function(){var a=document.activeElement;"
    + "if(a&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA'||a.isContentEditable)){a.blur();return true;}return false;})()";
  /** The app starts its own activities (file picker, microphone permission) right before the pause they cause. */
  static final long APP_ACTIVITY_WINDOW_MS = 3000;

  /** Tells a real wake (screen off, home, another app) from the return of an activity the app started itself. */
  static final class Tracker {
    private long appStartedAt = Long.MIN_VALUE;
    private boolean paused, pausedForApp;
    synchronized void appStartedActivity(long now) { appStartedAt = now; }
    synchronized void paused(long now) {
      paused = true; pausedForApp = appStartedAt != Long.MIN_VALUE && now - appStartedAt <= APP_ACTIVITY_WINDOW_MS; appStartedAt = Long.MIN_VALUE;
    }
    /** True when focus must drop: the app comes back from a pause it did not cause. */
    synchronized boolean resumed() {
      boolean wake = paused && !pausedForApp; paused = false; pausedForApp = false; return wake;
    }
  }
}
