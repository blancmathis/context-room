package app.contextroom.tablet;

/** Tracks the owner-link error shown in the header, so it can clear itself when the link works again
 * (after the tablet wakes) instead of waiting for a navigation.
 * Requests take a ticket when they start: a success only clears an error from a request that started before it,
 * so an older request that succeeds late never hides a newer error. */
final class OwnerLinkStatus {
  private boolean showing;
  private long issued, failedTicket;
  /** The order in which requests start. */
  synchronized long begin() { return ++issued; }
  /** An error that belongs to no request (page error, native failure): it counts as the newest. */
  synchronized void failed() { failed(begin()); }
  synchronized void failed(long ticket) { if (!showing || ticket > failedTicket) failedTicket = ticket; showing = true; }
  /** True once, on the first success after a failure: the header must drop the error. */
  synchronized boolean succeeded() { return succeeded(begin()); }
  synchronized boolean succeeded(long ticket) {
    if (!showing || ticket < failedTicket) return false;
    showing = false; return true;
  }
}
