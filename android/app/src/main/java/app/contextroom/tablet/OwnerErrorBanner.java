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
  /** True when the link recovered and the error, with its "Connexions" button, must go. */
  boolean recovered(boolean owner, boolean conversation) {
    if (!showing || (!owner && !conversation)) return false;
    showing = false; return true;
  }
  boolean hasPairingButton() { return pairingButton; }
  void clearPairingButton() { pairingButton = false; }
  /** The screen was rebuilt: nothing is shown any more. */
  void reset() { showing = false; pairingButton = false; }
}
