package app.contextroom.tablet;

import static org.junit.Assert.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;

/** D1 (BOOX, 2026-11-04): after sleep and wake, "Mac unreachable" stayed although the Mac answered again. */
public final class MacReachTest {
  final AtomicInteger lost = new AtomicInteger(), back = new AtomicInteger();
  MacReach reach() { MacReach reach = new MacReach(); reach.unreachable = lost::incrementAndGet; reach.reachable = back::incrementAndGet; return reach; }

  @Test public void theFirstContactAfterWakeReportsTheRecoveryOnce() {
    MacReach reach = reach();
    reach.failed(reach.begin());
    assertEquals(1, lost.get()); assertTrue(reach.lastFailed);
    reach.reached(reach.begin());
    assertEquals("the first answer after the failure clears the banner", 1, back.get()); assertFalse(reach.lastFailed);
    reach.reached(reach.begin());
    assertEquals("only once", 1, back.get());
  }

  @Test public void aContactStartedBeforeTheFailureReportsNothing() {
    MacReach reach = reach();
    long before = reach.begin();
    reach.failed(reach.begin());
    reach.reached(before);
    assertEquals("a late old answer must not hide the newer error", 0, back.get());
    reach.reached(reach.begin());
    assertEquals(1, back.get());
  }

  @Test public void nothingToReportWithoutAFailure() {
    MacReach reach = reach();
    reach.reached(reach.begin());
    assertEquals(0, back.get());
  }
}
