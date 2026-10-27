package app.contextroom.tablet;

import static org.junit.Assert.*;
import org.junit.Test;

public final class OwnerWakeTest {
  @Test public void focusDropsAfterARealWake() {
    OwnerWake.Tracker wake = new OwnerWake.Tracker();
    wake.paused(1000);
    assertTrue(wake.resumed());
  }

  @Test public void theFirstResumeDropsNothing() {
    assertFalse(new OwnerWake.Tracker().resumed());
  }

  @Test public void theFilePickerAndMicrophonePermissionKeepFocus() {
    OwnerWake.Tracker wake = new OwnerWake.Tracker();
    wake.appStartedActivity(1000); wake.paused(1100);
    assertFalse("returning from an activity the app started", wake.resumed());
  }

  @Test public void aLaterRealWakeStillDrops() {
    OwnerWake.Tracker wake = new OwnerWake.Tracker();
    wake.appStartedActivity(1000); wake.paused(1100); wake.resumed();
    wake.paused(900000);
    assertTrue(wake.resumed());
  }

  @Test public void anActivityThatNeverStartedDoesNotHideALaterWake() {
    OwnerWake.Tracker wake = new OwnerWake.Tracker();
    wake.appStartedActivity(1000);
    wake.paused(1000 + OwnerWake.APP_ACTIVITY_WINDOW_MS + 1);
    assertTrue(wake.resumed());
  }
}
