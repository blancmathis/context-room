package app.contextroom.tablet;

/** The header error and the "Connexions" button that an owner-link error adds, in owner and conversation mode. */
final class OwnerErrorBanner {
  private boolean showing, pairingButton;
  /** The error is shown in owner and conversation mode. Returns true when the "Connexions" button must be added (owner mode, once). */
  boolean error(boolean owner, boolean conversation) {
    if (!owner && !conversation) return false;
    showing = true;
    if (owner && !pairingButton) { pairingButton = true; return true; }
    return false;
  }
  /** What the header status line does once the link recovered. */
  enum Recovery { NONE, HIDE_STATUS, RESTORE_NOTEBOOK_STATUS }
  /** In owner mode the status line only carries the error, so it hides; in conversation mode it is the notebook status line, so it shows the notebook state again. */
  Recovery recovered(boolean owner, boolean conversation) {
    if (!showing || (!owner && !conversation)) return Recovery.NONE;
    showing = false; return owner ? Recovery.HIDE_STATUS : Recovery.RESTORE_NOTEBOOK_STATUS;
  }
  boolean hasPairingButton() { return pairingButton; }
  void clearPairingButton() { pairingButton = false; }
  /** The screen was rebuilt: nothing is shown any more. */
  void reset() { showing = false; pairingButton = false; }
}
