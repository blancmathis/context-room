package app.contextroom.tablet;

/** Android Back in the owner workspace closes the open dialog first (a notebook, a sheet), then the Conversation panel,
 * as Escape does on the Mac. Only without one does Back go back in page history. */
final class OwnerBack {
  private OwnerBack() {}
  enum Action { CONSUMED, HISTORY, OUTSIDE }
  /** Sends `cancel` to the top open dialog so its own handler runs (the notebook saves and closes). */
  static final String CLOSE_TOP_DIALOG = "(function(){var all=document.querySelectorAll('dialog[open]');var d=all[all.length-1];"
    + "if(d){if(d.dispatchEvent(new Event('cancel',{cancelable:true})))d.close();return true;}"
    + "var p=document.querySelector('.assistant-panel:not([hidden]):not(.assistant-minimized)');"
    + "var b=p?p.querySelector('header [data-assistant-close]'):null;"
    + "if(!b)return false;b.click();return true;})()";
  static boolean closedDialog(String evaluateResult) { return "true".equals(evaluateResult); }
  /** What Back does once the page answered the script above. */
  static Action afterDialog(String evaluateResult, boolean canGoBack) {
    if (closedDialog(evaluateResult)) return Action.CONSUMED;
    return canGoBack ? Action.HISTORY : Action.OUTSIDE;
  }
}
