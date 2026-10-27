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

  @Test public void theScriptLetsTheDialogHandleCancelFirst() {
    assertTrue(OwnerBack.CLOSE_TOP_DIALOG.contains("dialog[open]"));
    assertTrue(OwnerBack.CLOSE_TOP_DIALOG.contains("new Event('cancel',{cancelable:true})"));
  }
}
