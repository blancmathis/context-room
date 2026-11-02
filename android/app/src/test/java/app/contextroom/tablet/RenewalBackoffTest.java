package app.contextroom.tablet;

import static org.junit.Assert.*;
import org.junit.Test;

public final class RenewalBackoffTest {
  @Test public void theFirstTwoRenewalsAreImmediate() {
    RenewalBackoff backoff = new RenewalBackoff();
    assertEquals(0, backoff.next(1000)); assertEquals(0, backoff.next(2000));
  }

  @Test public void aRapidRunBacksOffUpToThirtySeconds() {
    RenewalBackoff backoff = new RenewalBackoff();
    long now = 0; backoff.next(now); backoff.next(now += 1000);
    long[] expected = {1000, 2000, 4000, 8000, 16000, 30000, 30000};
    for (long delay : expected) assertEquals(delay, backoff.next(now += 1));
  }

  @Test public void aQuietPeriodStartsOver() {
    RenewalBackoff backoff = new RenewalBackoff();
    backoff.next(0); backoff.next(1000); assertEquals(1000, backoff.next(2000));
    assertEquals(0, backoff.next(100000));
  }
}
