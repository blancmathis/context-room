package app.contextroom.tablet;

/** Tracks the owner-link error shown in the header, so it can clear itself when the link works again
 * (after the tablet wakes) instead of waiting for a navigation. */
final class OwnerLinkStatus {
  private boolean showing;
  synchronized void failed() { showing = true; }
  /** True once, on the first success after a failure: the header must drop the error. */
  synchronized boolean succeeded() { boolean was = showing; showing = false; return was; }
}
