package app.contextroom.tablet;

/** Whether the paired Mac answers, seen by every channel of one connection (owner interface, notebook engine,
 * navigation, rediscovery, wake probe). A contact that starts after a network failure and gets an answer reports
 * the recovery once, so an error shown for one channel clears on the first contact that works, whichever channel it is.
 * A contact that started before the failure and answers late reports nothing. */
final class MacReach {
  private final OwnerLinkStatus link = new OwnerLinkStatus();
  /** Called off the main thread when the Mac could not be reached at all. */
  volatile Runnable unreachable;
  /** Called off the main thread on the first answer after a failure. */
  volatile Runnable reachable;
  volatile boolean lastFailed;

  long begin() { return link.begin(); }
  void failed(long contact) { lastFailed = true; link.failed(contact); run(unreachable); }
  void reached(long contact) { lastFailed = false; if (link.succeeded(contact)) run(reachable); }
  private static void run(Runnable hook) { if (hook != null) hook.run(); }
}
