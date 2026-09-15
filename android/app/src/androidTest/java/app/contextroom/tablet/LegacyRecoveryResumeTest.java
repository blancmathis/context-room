package app.contextroom.tablet;

import android.accessibilityservice.AccessibilityService;
import android.app.Instrumentation;
import android.view.accessibility.AccessibilityNodeInfo;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public final class LegacyRecoveryResumeTest {
  boolean ui(Instrumentation instrumentation, BooleanSupplier condition) {
    AtomicBoolean result = new AtomicBoolean(); instrumentation.runOnMainSync(() -> result.set(condition.getAsBoolean())); return result.get();
  }
  @Test public void preparedCopySurvivesRecreationAndPickerCancellation() throws Exception {
    org.junit.Assume.assumeTrue("Explicit owned recovery fixture required", "verify".equals(InstrumentationRegistry.getArguments().getString("legacyRecoveryFixture")));
    Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
    assertEquals("fr.lisiere.android", instrumentation.getTargetContext().getPackageName());
    LegacyRecoveryArchive archive = new LegacyRecoveryArchive(instrumentation.getTargetContext());
    File before = archive.completed(); assertNotNull("Run the owned native export first", before);
    String hash = LegacyRecoveryArchive.copyChecked(before, null, LegacyRecoveryArchive.LIMIT).getString("sha256");
    AtomicReference<LegacyRecoveryActivity> activity = new AtomicReference<>();
    try (ActivityScenario<LegacyRecoveryActivity> scenario = ActivityScenario.launch(LegacyRecoveryActivity.class)) {
      scenario.onActivity(activity::set);
      NotebookDeviceTest.waitFor("Retained copy is not available", () -> ui(instrumentation, () -> activity.get().save.isEnabled()));
      LegacyRecoveryActivity first = activity.get();
      scenario.recreate(); scenario.onActivity(activity::set); assertNotSame(first, activity.get());
      NotebookDeviceTest.waitFor("Recreated activity lost the retained copy", () -> ui(instrumentation, () -> activity.get().save.isEnabled()));
      scenario.onActivity(value -> value.save.performClick());
      NotebookDeviceTest.waitFor("Android's destination picker did not open", () -> {
        AccessibilityNodeInfo root = instrumentation.getUiAutomation().getRootInActiveWindow();
        if (root == null) return false;
        String name = String.valueOf(root.getPackageName());
        return name.equals("com.android.documentsui") || name.equals("com.google.android.documentsui");
      });
      assertTrue(instrumentation.getUiAutomation().performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK));
      NotebookDeviceTest.waitFor("Picker cancellation was not preserved", () -> ui(instrumentation, () -> activity.get().notice.getText().toString().contains("Enregistrement annulé.") && activity.get().save.isEnabled()));
      new LegacyRecoveryTest().capture(instrumentation, activity.get(), "legacy-recovery-cancelled");
      scenario.recreate(); scenario.onActivity(activity::set);
      NotebookDeviceTest.waitFor("Cancelled export cannot resume", () -> ui(instrumentation, () -> activity.get().save.isEnabled()));
      assertEquals(hash, activity.get().preparedHash);
    }
    assertEquals(before, archive.completed());
    assertEquals(hash, LegacyRecoveryArchive.copyChecked(before, null, LegacyRecoveryArchive.LIMIT).getString("sha256"));
  }
}
