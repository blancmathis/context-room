package app.contextroom.tablet;

import static org.junit.Assert.*;
import org.junit.Test;

public final class OwnerLinkStatusTest {
  @Test public void theErrorClearsOnceWhenTheLinkWorksAgain() {
    OwnerLinkStatus status = new OwnerLinkStatus();
    assertFalse("nothing to clear without an error", status.succeeded());
    status.failed();
    assertTrue(status.succeeded());
    assertFalse("only the first success clears it", status.succeeded());
  }

  @Test public void aNewFailureShowsAgain() {
    OwnerLinkStatus status = new OwnerLinkStatus();
    status.failed(); status.succeeded(); status.failed();
    assertTrue(status.succeeded());
  }

  @Test public void anOlderRequestThatSucceedsLateKeepsTheNewerError() {
    OwnerLinkStatus status = new OwnerLinkStatus();
    long older = status.begin(), newer = status.begin();
    status.failed(newer);
    assertFalse("the older success must not hide the newer error", status.succeeded(older));
    assertTrue("a request started after the error clears it", status.succeeded(status.begin()));
  }

  @Test public void aNewerSuccessClearsAnOlderError() {
    OwnerLinkStatus status = new OwnerLinkStatus();
    long older = status.begin(), newer = status.begin();
    status.failed(older);
    assertTrue(status.succeeded(newer));
  }
}
