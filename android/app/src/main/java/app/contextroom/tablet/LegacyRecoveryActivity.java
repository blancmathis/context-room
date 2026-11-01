package app.contextroom.tablet;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.widget.*;
import java.io.*;
import java.security.MessageDigest;
import java.util.concurrent.*;
import org.json.JSONObject;

/** Explicit local export, available only inside the retained Lisière identity. */
public final class LegacyRecoveryActivity extends Activity {
  static final int SAVE = 71;
  final ExecutorService disk = Executors.newSingleThreadExecutor();
  LegacyRecoveryArchive recovery;
  TextView notice;
  Button prepare, save;
  String preparedHash, pendingHash;
  boolean dead, busy;
  @Override public void onCreate(Bundle state) {
    super.onCreate(state); recovery = new LegacyRecoveryArchive(this);
    if (state != null) pendingHash = state.getString("pendingHash");
    LinearLayout content = new LinearLayout(this); content.setOrientation(LinearLayout.VERTICAL); content.setPadding(24, 24, 24, 24); content.setBackgroundColor(Color.WHITE);
    ScrollView scroll = new ScrollView(this); scroll.addView(content); setContentView(scroll);
    content.addView(label("Recover Lisière data", 24));
    content.addView(label("Keep your notebooks, drafts, pending operations and recordings so you can find them in Context Room on the Mac. The copy contains your personal documents. Choose where to save it.", 18));
    content.addView(label("The originals stay on this device. This export sends no old message or pending drawing to the Mac.", 17));
    notice = label("Checking the kept copy…", 17); notice.setAccessibilityLiveRegion(android.view.View.ACCESSIBILITY_LIVE_REGION_POLITE); content.addView(notice);
    prepare = action("Prepare a copy", this::prepare); content.addView(prepare);
    save = action("Save the ZIP file", this::chooseDestination); save.setEnabled(false); content.addView(save);
    content.addView(action("Back to Context Room", this::finish));
    prepare.setEnabled(false);
    disk.execute(() -> {
      try {
        File retained = recovery.completed();
        if (retained != null) ready(retained);
        else runOnUiThread(() -> { if (!dead) { prepare.setEnabled(LegacyRecoveryArchive.available(this)); notice.setText("Prepare a private copy before choosing where to save it."); } });
      } catch (Exception error) { failed(error); }
    });
  }
  TextView label(String text, int size) { TextView label = new TextView(this); label.setText(text); label.setTextColor(Color.BLACK); label.setTextSize(size); label.setPadding(0, 10, 0, 10); return label; }
  Button action(String text, Runnable run) { Button button = new Button(this); button.setText(text); button.setAllCaps(false); button.setTextColor(Color.BLACK); button.setMinHeight(56); button.setOnClickListener(view -> run.run()); return button; }
  void prepare() {
    if (busy) return; busy = true; prepare.setEnabled(false); save.setEnabled(false); notice.setText("Preparing the private copy… The originals are kept.");
    disk.execute(() -> { try { ready(recovery.prepare()); } catch (Exception error) { failed(error); } });
  }
  void ready(File file) throws Exception {
    String hash = LegacyRecoveryArchive.copyChecked(file, null, LegacyRecoveryArchive.LIMIT + 8 * 1024 * 1024).getString("sha256");
    runOnUiThread(() -> { if (!dead) { busy = false; preparedHash = hash; prepare.setEnabled(true); save.setEnabled(true); notice.setText("Private copy ready. Save the ZIP file to move it to the Mac. You can resume here if the file choice is cancelled."); } });
  }
  void failed(Exception error) {
    runOnUiThread(() -> { if (!dead) { busy = false; prepare.setEnabled(true); save.setEnabled(preparedHash != null); notice.setText("Recovery unfinished · " + error.getMessage() + "\nThe originals are kept."); } });
  }
  void chooseDestination() {
    if (busy || preparedHash == null) return; pendingHash = preparedHash;
    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/zip").putExtra(Intent.EXTRA_TITLE, LegacyRecoveryArchive.NAME);
    try { startActivityForResult(intent, SAVE); } catch (Exception error) { pendingHash = null; failed(error); }
  }
  @Override protected void onActivityResult(int request, int result, Intent data) {
    super.onActivityResult(request, result, data); if (request != SAVE) return;
    final String chosen = pendingHash; pendingHash = null;
    if (result != RESULT_OK || data == null || data.getData() == null) { notice.setText("Save cancelled. The private copy is still ready to save."); return; }
    final Uri destination = data.getData();
    if (chosen == null || !"content".equals(destination.getScheme())) { failed(new IOException("Choose a destination again for the kept copy.")); return; }
    busy = true; prepare.setEnabled(false); save.setEnabled(false); notice.setText("Saving the recovery file…");
    disk.execute(() -> {
      try {
        File archive = recovery.completed(); LegacyRecoveryArchive.require(archive != null, "The prepared copy is missing.");
        JSONObject metadata = LegacyRecoveryArchive.copyChecked(archive, null, LegacyRecoveryArchive.LIMIT + 8 * 1024 * 1024);
        LegacyRecoveryArchive.require(chosen.equals(metadata.getString("sha256")), "The prepared copy changed. Choose it again.");
        MessageDigest sha = LegacyRecoveryArchive.digest(); long count = 0;
        try (InputStream input = new FileInputStream(android.system.Os.open(archive.getAbsolutePath(), android.system.OsConstants.O_RDONLY | android.system.OsConstants.O_NOFOLLOW, 0));
             OutputStream output = getContentResolver().openOutputStream(destination, "wt")) {
          LegacyRecoveryArchive.require(output != null, "The chosen file cannot be written.");
          byte[] buffer = new byte[64 * 1024]; int length;
          while ((length = input.read(buffer)) != -1) {
            count += length; LegacyRecoveryArchive.require(count <= metadata.getLong("bytes"), "The copy grew while saving.");
            sha.update(buffer, 0, length); output.write(buffer, 0, length);
          }
          output.flush();
          LegacyRecoveryArchive.require(count == metadata.getLong("bytes") && LegacyRecoveryArchive.hex(sha.digest()).equals(chosen), "The copy changed while saving.");
        }
        runOnUiThread(() -> { if (!dead) { busy = false; prepare.setEnabled(true); save.setEnabled(true); notice.setText("Recovery file saved. Move this ZIP to the Mac to continue the import into Context Room. The originals are kept here."); } });
      } catch (Exception error) { failed(error); }
    });
  }
  @Override protected void onSaveInstanceState(Bundle state) { super.onSaveInstanceState(state); if (pendingHash != null) state.putString("pendingHash", pendingHash); }
  @Override protected void onDestroy() { dead = true; disk.shutdown(); super.onDestroy(); }
}
