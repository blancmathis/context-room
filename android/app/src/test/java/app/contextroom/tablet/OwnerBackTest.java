package app.contextroom.tablet;

import static org.junit.Assert.*;
import org.junit.Test;

public final class OwnerBackTest {
  @Test public void backIsConsumedOnlyWhenADialogWasOpen() {
    assertTrue(OwnerBack.closedDialog("true"));
    assertFalse(OwnerBack.closedDialog("false"));
    assertFalse(OwnerBack.closedDialog("null"));
    assertFalse(OwnerBack.closedDialog(null));
  }

  @Test public void aPageAnswerDecidesWhatBackDoes() {
    assertEquals(OwnerBack.Action.CONSUMED, OwnerBack.afterDialog("true", true));
    assertEquals(OwnerBack.Action.CONSUMED, OwnerBack.afterDialog("true", false));
    assertEquals(OwnerBack.Action.HISTORY, OwnerBack.afterDialog("false", true));
    assertEquals(OwnerBack.Action.OUTSIDE, OwnerBack.afterDialog("false", false));
    assertEquals(OwnerBack.Action.HISTORY, OwnerBack.afterDialog("null", true));
    assertEquals(OwnerBack.Action.OUTSIDE, OwnerBack.afterDialog(null, false));
  }
}
