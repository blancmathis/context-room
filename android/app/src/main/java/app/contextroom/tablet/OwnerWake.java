package app.contextroom.tablet;

/** On wake the WebView hands focus back to the first text field and the e-ink keyboard opens without a tap.
 * Drop focus from a text field on wake; the next tap opens the keyboard on purpose. */
final class OwnerWake {
  private OwnerWake() {}
  static final String DROP_TEXT_FOCUS = "(function(){var a=document.activeElement;"
    + "if(a&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA'||a.isContentEditable)){a.blur();return true;}return false;})()";
}
