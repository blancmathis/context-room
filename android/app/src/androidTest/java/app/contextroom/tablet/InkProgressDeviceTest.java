package app.contextroom.tablet;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Progress cannot introduce future geometry or leave a tip on a moved stroke. */
@RunWith(AndroidJUnit4.class)
public final class InkProgressDeviceTest {
  @Test public void nativeTipUsesOnlyTheCurrentReceivedPath() {
    android.app.Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
    instrumentation.runOnMainSync(() -> {
      InkView view = new InkView(instrumentation.getTargetContext(), new InkView.Listener() {
        public void change(JSONArray operations) {} public void viewport() {} public void text(float x, float y) {}
        public void selection(int count) {} public void draft(JSONArray points) {}
      });
      try {
        JSONObject progress = InkView.json("objectId", "agent-stroke", "point", new JSONArray("[50,20,.6]"), "at", System.currentTimeMillis());
        view.setAgentProgress(progress); assertNull("An absent stroke has no tip", view.agentTip);
        view.objects.put("agent-stroke", InkView.json("id", "agent-stroke", "type", "ink", "points", new JSONArray("[[10,20,.6],[40,20,.6]]")));
        view.resolveAgentTip(); assertNull("Progress cannot paint an unreceived point", view.agentTip);
        view.objects.get("agent-stroke").put("points", new JSONArray("[[10,20,.6],[50,20,.6],[60,20,.6]]"));
        view.resolveAgentTip(); assertNotNull(view.agentTip); assertEquals(60f, view.agentTip.x, 0f);
        view.objects.get("agent-stroke").put("points", new JSONArray("[[110,120,.6],[150,120,.6]]"));
        view.resolveAgentTip(); assertNull("A moved object cannot retain the original tip", view.agentTip);
        view.objects.get("agent-stroke").put("points", new JSONArray("[[10,20,.6],[50,20,.6]]"));
        progress.put("at", System.currentTimeMillis() - 4000); view.setAgentProgress(progress); assertNull("Old progress expires", view.agentTip);
        progress.put("at", System.currentTimeMillis()); progress.put("completed", true); view.setAgentProgress(progress); assertNull("Completed ink has no live tip", view.agentTip);
      } catch (JSONException failure) { throw new AssertionError(failure); }
    });
  }
}
