package app.contextroom.tablet;

import static org.junit.Assert.*;
import org.junit.Test;

public final class OwnerErrorBannerTest {
  @Test public void theErrorClearsInConversationModeToo() {
    OwnerErrorBanner banner = new OwnerErrorBanner();
    banner.error(false, true);
    assertTrue(banner.recovered(false, true));
  }

  @Test public void theConnectionsButtonIsAddedOnceInOwnerMode() {
    OwnerErrorBanner banner = new OwnerErrorBanner();
    assertTrue(banner.error(true, false));
    assertFalse(banner.error(true, false));
    assertTrue(banner.hasPairingButton());
  }

  @Test public void noButtonInConversationMode() {
    OwnerErrorBanner banner = new OwnerErrorBanner();
    assertFalse(banner.error(false, true));
  }

  @Test public void recoveryReportsTheButtonToRemoveAndAllowsANewOne() {
    OwnerErrorBanner banner = new OwnerErrorBanner();
    banner.error(true, false);
    assertTrue(banner.recovered(true, false));
    assertTrue("the button is still to remove", banner.hasPairingButton());
    banner.clearPairingButton();
    assertTrue("a new error adds the button again", banner.error(true, false));
  }

  @Test public void nothingToClearWithoutAnError() {
    assertFalse(new OwnerErrorBanner().recovered(true, false));
  }
}
