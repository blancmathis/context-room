package app.contextroom.tablet;

import android.app.Instrumentation;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentLinkedQueue;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** C-12: one navigation request at a time, and a retired session is replaced at once instead of polled forever. */
@RunWith(AndroidJUnit4.class)
public final class NativeNavigationSessionTest {
  final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
  final ConcurrentLinkedQueue<Runnable> network = new ConcurrentLinkedQueue<>();
  final List<String> sessions = new ArrayList<>();
  JSONObject next;

  NativeNavigation navigation() throws Exception {
    JSONObject device = InkView.json("id", "device-under-test", "grants", new org.json.JSONArray());
    DeviceConnection connection = new DeviceConnection(InkView.json("url", "https://127.0.0.1:4401", "fingerprint", new String(new char[64]).replace('\0', 'a'),
        "serverId", "server-under-test", "token", new String(new char[43]).replace('\0', 'b'), "device", device));
    NativeNavigation[] made = new NativeNavigation[1];
    instrumentation.runOnMainSync(() -> {
      made[0] = new NativeNavigation(network::add, new NativeNavigation.Host() {
        public boolean navigationBusy() { return false; }
        public void remoteOpen(JSONObject target) {}
        public void navigationNotice(String message) {}
        public JSONObject viewState() { return null; }
        public void receiveView(JSONObject data, JSONObject sent) {}
        public void viewFailure() {}
      });
      made[0].transport = (selected, action, body) -> { synchronized (sessions) { sessions.add(body.optString("clientSessionId")); } return next; };
      made[0].foreground(true);
      made[0].connect(connection);
    });
    instrumentation.waitForIdleSync();
    return made[0];
  }
  /** Run the queued network job, then let its answer reach the main thread. */
  void answer() { Runnable job = network.poll(); assertNotNull("a poll was in flight", job); job.run(); instrumentation.waitForIdleSync(); }

  @Test public void reconnectingWaitsForTheOldSessionRequestBeforePollingTheNewOne() throws Exception {
    NativeNavigation navigation = navigation();
    assertEquals(1, network.size());
    String first = navigation.session;
    DeviceConnection connection = navigation.connection;
    instrumentation.runOnMainSync(() -> { navigation.connect(null); navigation.connect(connection); });
    instrumentation.waitForIdleSync();
    assertEquals("the new session must not poll beside the old one", 1, network.size());
    next = InkView.json("status", 503, "body", new JSONObject());
    answer();
    assertEquals("the new session polls once the old request is done", 1, network.size());
    answer();
    assertEquals(first, sessions.get(0));
    assertNotEquals(first, sessions.get(1));
    assertEquals(navigation.session, sessions.get(1));
  }

  @Test public void aRetiredSessionIsReplacedAndPolledAtOnce() throws Exception {
    NativeNavigation navigation = navigation();
    next = InkView.json("status", 409, "body", InkView.json("code", "device_navigation_session", "error", "This tablet session has been replaced."));
    answer();
    assertEquals("a fresh session polls without the 1.2 s wait", 1, network.size());
    next = InkView.json("status", 503, "body", new JSONObject());
    answer();
    assertNotEquals("the retired session is never sent again", sessions.get(0), sessions.get(1));
    assertEquals(navigation.session, sessions.get(1));
  }
}
