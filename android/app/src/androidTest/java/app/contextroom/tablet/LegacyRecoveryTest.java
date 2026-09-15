package app.contextroom.tablet;

import android.app.*;
import android.graphics.Bitmap;
import android.os.SystemClock;
import android.view.*;
import android.widget.Button;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public final class LegacyRecoveryTest {
  Button find(View node, String text) {
    if (node instanceof Button && text.contentEquals(((Button)node).getText())) return (Button)node;
    if (node instanceof ViewGroup) for (int n=0;n<((ViewGroup)node).getChildCount();n++) { Button found=find(((ViewGroup)node).getChildAt(n),text); if(found!=null)return found; }
    return null;
  }
  void capture(Instrumentation instrumentation, Activity activity, String name) throws Exception {
    instrumentation.waitForIdleSync(); SystemClock.sleep(180);
    Bitmap bitmap=instrumentation.getUiAutomation().takeScreenshot(); assertNotNull(bitmap);
    try(OutputStream output=new FileOutputStream(new File(activity.getFilesDir(),name+".png"))){assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG,100,output));}
  }
  @Test public void upgradedContextRoomPreservesAndExplicitlyExportsTheOriginalWorkspace() throws Exception {
    org.junit.Assume.assumeTrue("Explicit owned upgrade fixture required", "verify".equals(InstrumentationRegistry.getArguments().getString("legacyRecoveryFixture")));
    Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation(); NotebookDeviceTest helper=new NotebookDeviceTest();
    assertEquals("fr.lisiere.android",instrumentation.getTargetContext().getPackageName());
    assertEquals(96,instrumentation.getTargetContext().getPackageManager().getPackageInfo("fr.lisiere.android",0).getLongVersionCode());
    assertEquals("synthetic-excluded-authentication-preference",instrumentation.getTargetContext().getSharedPreferences("workspace",0).getString("credentials",null));
    Instrumentation.ActivityMonitor monitor=instrumentation.addMonitor(LegacyRecoveryActivity.class.getName(),null,false);
    try(ActivityScenario<MainActivity> scenario=ActivityScenario.launch(MainActivity.class)) {
      MainActivity main=helper.activity(scenario);
      NotebookDeviceTest.waitFor("Recovery entry is missing after upgrade",()->helper.onUi(main,()->find(main.root,"Récupérer Lisière")!=null));
      capture(instrumentation,main,"legacy-upgraded-entry");
      instrumentation.runOnMainSync(()->find(main.root,"Récupérer Lisière").performClick());
      LegacyRecoveryActivity activity=(LegacyRecoveryActivity)instrumentation.waitForMonitorWithTimeout(monitor,10000); assertNotNull(activity);
      try {
        NotebookDeviceTest.waitFor("Recovery preparation unavailable",()->helper.onUi(main,()->activity.prepare.isEnabled()));
        instrumentation.runOnMainSync(()->activity.prepare.performClick());
        NotebookDeviceTest.waitFor("Recovery archive did not become ready",()->helper.onUi(main,()->activity.save.isEnabled()));
        capture(instrumentation,activity,"legacy-recovery-ready");
        instrumentation.runOnMainSync(()->activity.save.performClick());
        new OwnerWorkspaceTest().systemClick("SAVE");
        NotebookDeviceTest.waitFor("Android recovery export unconfirmed",()->helper.onUi(main,()->activity.notice.getText().toString().contains("Fichier de récupération enregistré.")));
        capture(instrumentation,activity,"legacy-recovery-exported");
        assertNotNull(new LegacyRecoveryArchive(activity).completed());
      } catch(Throwable error) { capture(instrumentation,activity,"legacy-recovery-failure"); throw error; }
      finally { instrumentation.runOnMainSync(activity::finish); }
    } finally { instrumentation.removeMonitor(monitor); }
  }
}
