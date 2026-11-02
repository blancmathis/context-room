package app.contextroom.tablet;

/** Delay before renewing a session the Hub retired: immediate at first; after 3 renewals within 30 s, 1 s, 2 s, 4 s … up to 30 s. */
final class RenewalBackoff {
  private final long[] recent = new long[3];
  private int count, streak;

  long next(long now) {
    recent[count++ % 3] = now;
    if (count < 3) return 0;
    if (now - recent[count % 3] >= 30000) { count = 0; streak = 0; recent[count++ % 3] = now; return 0; }
    long delay = Math.min(30000L, 1000L << Math.min(5, streak++));
    return delay;
  }
}
