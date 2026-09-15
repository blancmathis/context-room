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
    content.addView(label("Récupérer les données Lisière", 24));
    content.addView(label("Conservez vos carnets, brouillons, opérations en attente et enregistrements pour les retrouver dans Context Room sur le Mac. La copie contient vos documents personnels. Choisissez où l’enregistrer.", 18));
    content.addView(label("Les originaux restent sur cet appareil. Aucun ancien message ni dessin en attente n’est envoyé au Mac par cet export.", 17));
    notice = label("Vérification de la copie conservée…", 17); notice.setAccessibilityLiveRegion(android.view.View.ACCESSIBILITY_LIVE_REGION_POLITE); content.addView(notice);
    prepare = action("Préparer une copie", this::prepare); content.addView(prepare);
    save = action("Enregistrer le fichier ZIP", this::chooseDestination); save.setEnabled(false); content.addView(save);
    content.addView(action("Revenir à Context Room", this::finish));
    prepare.setEnabled(false);
    disk.execute(() -> {
      try {
        File retained = recovery.completed();
        if (retained != null) ready(retained);
        else runOnUiThread(() -> { if (!dead) { prepare.setEnabled(LegacyRecoveryArchive.available(this)); notice.setText("Préparez une copie privée avant de choisir sa destination."); } });
      } catch (Exception error) { failed(error); }
    });
  }
  TextView label(String text, int size) { TextView label = new TextView(this); label.setText(text); label.setTextColor(Color.BLACK); label.setTextSize(size); label.setPadding(0, 10, 0, 10); return label; }
  Button action(String text, Runnable run) { Button button = new Button(this); button.setText(text); button.setAllCaps(false); button.setTextColor(Color.BLACK); button.setMinHeight(56); button.setOnClickListener(view -> run.run()); return button; }
  void prepare() {
    if (busy) return; busy = true; prepare.setEnabled(false); save.setEnabled(false); notice.setText("Préparation de la copie privée… Les originaux restent conservés.");
    disk.execute(() -> { try { ready(recovery.prepare()); } catch (Exception error) { failed(error); } });
  }
  void ready(File file) throws Exception {
    String hash = LegacyRecoveryArchive.copyChecked(file, null, LegacyRecoveryArchive.LIMIT + 8 * 1024 * 1024).getString("sha256");
    runOnUiThread(() -> { if (!dead) { busy = false; preparedHash = hash; prepare.setEnabled(true); save.setEnabled(true); notice.setText("Copie privée prête. Enregistrez le fichier ZIP pour le transférer au Mac. Vous pourrez reprendre ici si le choix du fichier est annulé."); } });
  }
  void failed(Exception error) {
    runOnUiThread(() -> { if (!dead) { busy = false; prepare.setEnabled(true); save.setEnabled(preparedHash != null); notice.setText("Récupération inachevée · " + error.getMessage() + "\nLes originaux restent conservés."); } });
  }
  void chooseDestination() {
    if (busy || preparedHash == null) return; pendingHash = preparedHash;
    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/zip").putExtra(Intent.EXTRA_TITLE, LegacyRecoveryArchive.NAME);
    try { startActivityForResult(intent, SAVE); } catch (Exception error) { pendingHash = null; failed(error); }
  }
  @Override protected void onActivityResult(int request, int result, Intent data) {
    super.onActivityResult(request, result, data); if (request != SAVE) return;
    final String chosen = pendingHash; pendingHash = null;
    if (result != RESULT_OK || data == null || data.getData() == null) { notice.setText("Enregistrement annulé. La copie privée reste prête à être enregistrée."); return; }
    final Uri destination = data.getData();
    if (chosen == null || !"content".equals(destination.getScheme())) { failed(new IOException("Sélectionnez à nouveau une destination pour la copie conservée.")); return; }
    busy = true; prepare.setEnabled(false); save.setEnabled(false); notice.setText("Enregistrement du fichier de récupération…");
    disk.execute(() -> {
      try {
        File archive = recovery.completed(); LegacyRecoveryArchive.require(archive != null, "La copie préparée est absente.");
        JSONObject metadata = LegacyRecoveryArchive.copyChecked(archive, null, LegacyRecoveryArchive.LIMIT + 8 * 1024 * 1024);
        LegacyRecoveryArchive.require(chosen.equals(metadata.getString("sha256")), "La copie préparée a changé. Sélectionnez-la à nouveau.");
        MessageDigest sha = LegacyRecoveryArchive.digest(); long count = 0;
        try (InputStream input = new FileInputStream(android.system.Os.open(archive.getAbsolutePath(), android.system.OsConstants.O_RDONLY | android.system.OsConstants.O_NOFOLLOW, 0));
             OutputStream output = getContentResolver().openOutputStream(destination, "wt")) {
          LegacyRecoveryArchive.require(output != null, "Le fichier choisi ne peut pas être écrit.");
          byte[] buffer = new byte[64 * 1024]; int length;
          while ((length = input.read(buffer)) != -1) {
            count += length; LegacyRecoveryArchive.require(count <= metadata.getLong("bytes"), "La copie a grandi pendant l’enregistrement.");
            sha.update(buffer, 0, length); output.write(buffer, 0, length);
          }
          output.flush();
          LegacyRecoveryArchive.require(count == metadata.getLong("bytes") && LegacyRecoveryArchive.hex(sha.digest()).equals(chosen), "La copie a changé pendant son enregistrement.");
        }
        runOnUiThread(() -> { if (!dead) { busy = false; prepare.setEnabled(true); save.setEnabled(true); notice.setText("Fichier de récupération enregistré. Transférez ce ZIP au Mac pour poursuivre l’import dans Context Room. Les originaux restent conservés ici."); } });
      } catch (Exception error) { failed(error); }
    });
  }
  @Override protected void onSaveInstanceState(Bundle state) { super.onSaveInstanceState(state); if (pendingHash != null) state.putString("pendingHash", pendingHash); }
  @Override protected void onDestroy() { dead = true; disk.shutdown(); super.onDestroy(); }
}
