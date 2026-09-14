package app.contextroom.tablet;

import android.app.*;
import android.content.*;
import android.graphics.*;
import android.os.*;
import android.text.InputType;
import android.view.*;
import android.widget.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import org.json.*;

/** Native pen surface attached to a scoped Context Room connection. */
public final class MainActivity extends Activity implements InkView.Listener {
  final ExecutorService disk = Executors.newSingleThreadExecutor();
  final HashMap<String, Integer> pendingObjects = new HashMap<>();
  final JSONArray unsavedActions = new JSONArray();
  NotebookEngine engine;
  CredentialVault vault;
  DeviceConnection connection;
  NativeCommandJournal journal;
  LinearLayout root, screen;
  TextView status, title;
  EditText pairingInput;
  InkView ink;
  JSONObject lastScene, currentScope;
  long sceneVersion = -1;
  int pendingNative;
  boolean engineReady, dead, journalFailed;
  String inFlight;
  Runnable deferredNavigation;
  byte[] pendingExport;
  Button undoButton, redoButton;
  boolean viewRestored;

  @Override public void onCreate(Bundle saved) {
    super.onCreate(saved);
    getWindow().setStatusBarColor(Color.WHITE); getWindow().setNavigationBarColor(Color.WHITE);
    getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
    root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(Color.WHITE);
    root.setFitsSystemWindows(true); setContentView(root);
    screen = new LinearLayout(this); screen.setOrientation(LinearLayout.VERTICAL);
    root.addView(screen, new LinearLayout.LayoutParams(-1, 0, 1));
    engine = new NotebookEngine(this, this::engineEvent);
    engine.web.setVisibility(View.INVISIBLE); engine.web.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
    root.addView(engine.web, new LinearLayout.LayoutParams(1, 1));
    vault = new CredentialVault(this);
    header("Context Room", "Ouverture du stockage local…");
    disk.execute(() -> {
      try { JSONObject savedConnection = vault.read(); DeviceConnection found = savedConnection == null ? null : new DeviceConnection(savedConnection);
        runOnUiThread(() -> { if (dead) return; connection = found; engine.connection = found; if (found == null) pairingScreen(); else if (engineReady) engine.call("catalogue", found.session); });
      } catch (Exception error) { runOnUiThread(() -> { pairingScreen(); showError(error.getMessage()); }); }
    });
  }
  int dp(float value) { return Math.round(value * getResources().getDisplayMetrics().density); }
  TextView label(String text, float size) { TextView view = new TextView(this); view.setText(text); view.setTextSize(size); view.setTextColor(Color.BLACK); view.setPadding(dp(20), dp(8), dp(20), dp(8)); return view; }
  Button button(String text, Runnable action) {
    Button result = new Button(this); result.setText(text); result.setAllCaps(false); result.setTextColor(Color.BLACK); result.setMinHeight(dp(48));
    result.setOnClickListener(view -> action.run()); return result;
  }
  void header(String heading, String detail) {
    screen.removeAllViews(); title = label(heading, 24); title.setTypeface(Typeface.DEFAULT, Typeface.BOLD); screen.addView(title);
    status = label(detail, 15); status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); screen.addView(status);
  }
  void setStatus(String text) { if (status != null && !text.contentEquals(status.getText())) status.setText(text); }
  void showError(String message) { setStatus(message == null ? "Le travail local est conservé. Réessayez la connexion." : message); }

  void pairingScreen() {
    ink = null; header("Context Room", "Dessinez sur la tablette, retrouvez le même carnet sur votre Mac.");
    screen.addView(label("Sur le Mac, ouvrez un carnet et choisissez « Connect tablet ». Collez ici le code de connexion créé pour ce carnet.", 17));
    pairingInput = new EditText(this); pairingInput.setHint("Code de connexion"); pairingInput.setContentDescription("Code de connexion créé sur le Mac");
    pairingInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
    pairingInput.setMinLines(4); pairingInput.setMaxLines(8); pairingInput.setTextSize(14); pairingInput.setPadding(dp(16),dp(12),dp(16),dp(12));
    LinearLayout.LayoutParams inputLayout = new LinearLayout.LayoutParams(-1, -2); inputLayout.setMargins(dp(16),dp(12),dp(16),dp(12)); screen.addView(pairingInput, inputLayout);
    Button pair = button("Connecter cette tablette", () -> {
      String text = pairingInput.getText().toString();
      if (text.length() > 8192) { showError("Ce code est trop long. Recopiez le code créé sur le Mac."); return; }
      try { pair(new JSONObject(text)); } catch (Exception error) { showError("Le code est incomplet. Collez le contenu entier créé sur le Mac."); }
    }); screen.addView(pair);
    if (connection != null) screen.addView(button("Revenir aux carnets connectés", () -> engine.call("catalogue", connection.session)));
  }

  void pair(JSONObject ticket) {
    setStatus("Vérification de l’identité du Mac…");
    engine.network.execute(() -> {
      try {
        JSONObject saved = DeviceConnection.pair(ticket); vault.save(saved); DeviceConnection paired = new DeviceConnection(saved);
        runOnUiThread(() -> { if (dead) return; connection = paired; engine.connection = paired; if (pairingInput != null) pairingInput.setText("");
          if (engineReady) engine.call("catalogue", paired.session); else setStatus("Connexion enregistrée. Ouverture du moteur local…"); });
      } catch (Exception error) { runOnUiThread(() -> showError(error instanceof javax.net.ssl.SSLException ? "Le certificat ne correspond pas au code du Mac. La connexion est refusée." : error.getMessage())); }
    });
  }

  void catalogue(JSONObject event) {
    ink = null; currentScope = null; lastScene = null; journal = null;
    header("Vos carnets", event.optBoolean("offline") ? "Mac indisponible · les carnets déjà ouverts restent accessibles." : "Connecté au Mac · les gestes sont partagés, la validation reste humaine.");
    ScrollView scroll = new ScrollView(this); LinearLayout list = new LinearLayout(this); list.setOrientation(LinearLayout.VERTICAL); scroll.addView(list);
    screen.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
    JSONArray notebooks = event.optJSONArray("notebooks");
    for (int n = 0; notebooks != null && n < notebooks.length(); n++) {
      JSONObject item = notebooks.optJSONObject(n);
      Button open = button(item.optString("title", item.optString("path")) + "\n" + item.optString("path"), () -> openNotebook(item));
      open.setGravity(Gravity.START | Gravity.CENTER_VERTICAL); open.setPadding(dp(20),dp(12),dp(20),dp(12)); open.setEnabled(!item.optBoolean("unavailable")); list.addView(open);
    }
    screen.addView(button("Actualiser la connexion", () -> engine.call("catalogue", connection.session)));
    screen.addView(button("Connecter un autre carnet", this::pairingScreen));
    screen.addView(button("Connexions enregistrées", this::savedConnections));
  }

  void savedConnections() {
    disk.execute(() -> {
      try { JSONArray saved = vault.list(); String[] labels = new String[saved.length()];
        for (int n = 0; n < saved.length(); n++) { JSONObject device = saved.getJSONObject(n).getJSONObject("device");
          labels[n] = device.optString("label", "Tablette") + " · " + device.getJSONArray("grants").getJSONObject(0).getJSONArray("paths").getString(0); }
        runOnUiThread(() -> new AlertDialog.Builder(this).setTitle("Connexions enregistrées").setItems(labels, (dialog, selected) -> disk.execute(() -> {
          try { JSONObject value = saved.getJSONObject(selected); DeviceConnection picked = new DeviceConnection(value); vault.save(value);
            runOnUiThread(() -> { if (dead) return; connection = picked; engine.connection = picked; engine.call("close"); engine.call("catalogue", picked.session); });
          } catch (Exception error) { runOnUiThread(() -> showError(error.getMessage())); }
        })).setNegativeButton("Fermer", null).show());
      } catch (Exception error) { runOnUiThread(() -> showError(error.getMessage())); }
    });
  }

  void openNotebook(JSONObject item) {
    whenJournalIdle(() -> {
      engine.call("close"); journal = null; currentScope = null; pendingObjects.clear(); sceneVersion = -1; lastScene = null; inFlight = null; journalFailed = false; viewRestored = false;
      header(item.optString("title", item.optString("path")), "Ouverture du carnet…");
      HorizontalScrollView scrolling = new HorizontalScrollView(this); scrolling.setHorizontalScrollBarEnabled(false);
      LinearLayout tools = new LinearLayout(this); scrolling.addView(tools); screen.addView(scrolling);
      tools.addView(button("Carnets", () -> whenJournalIdle(() -> { engine.call("close"); engine.call("catalogue", connection.session); })));
      ink = new InkView(this, this); ink.recordingHistory = false; ink.setEnabled(false);
      HashMap<String, Button> toolButtons = new HashMap<>();
      for (String[] tool : new String[][]{{"Stylo","ink"},{"Sélection","select"},{"Gomme","erase"},{"Texte","text"},{"Rectangle","rect"},{"Ellipse","ellipse"},{"Ligne","line"},{"Flèche","arrow"},{"Déplacer","pan"}}) {
        Button select = button(tool[0], () -> { ink.setTool(tool[1]); for (Map.Entry<String, Button> entry : toolButtons.entrySet()) {
          boolean active = entry.getKey().equals(tool[1]); entry.getValue().setSelected(active); entry.getValue().setTypeface(Typeface.DEFAULT, active ? Typeface.BOLD : Typeface.NORMAL);
          entry.getValue().setContentDescription(entry.getValue().getText() + (active ? " · outil actif" : ""));
        } });
        if (tool[1].equals("ink")) { select.setSelected(true); select.setTypeface(Typeface.DEFAULT, Typeface.BOLD); select.setContentDescription("Stylo · outil actif"); }
        toolButtons.put(tool[1], select); tools.addView(select);
      }
      undoButton = button("Annuler", () -> enqueue(InkView.json("action", "undo"))); tools.addView(undoButton);
      redoButton = button("Rétablir", () -> enqueue(InkView.json("action", "redo"))); tools.addView(redoButton);
      tools.addView(button("Effacer la sélection", () -> ink.selectedAction("delete")));
      tools.addView(button("Relier", () -> ink.selectedAction("connect")));
      tools.addView(button("Dupliquer", () -> ink.selectedAction("duplicate")));
      if (BooxInk.supportedDevice()) tools.addView(button("Mode BOOX", () -> ink.toggleBoox()));
      tools.addView(button("Reconnecter", () -> engine.call("refresh")));
      tools.addView(button("Exporter la récupération", () -> engine.call("exportRecovery")));
      tools.addView(button("Voir les conflits", () -> {
        JSONArray conflicts = lastScene == null ? null : lastScene.optJSONArray("conflictDetails"); StringBuilder detail = new StringBuilder();
        for (int n = 0; conflicts != null && n < conflicts.length(); n++) { JSONObject error = conflicts.optJSONObject(n).optJSONObject("error");
          detail.append(error == null ? "Geste en conflit" : error.optString("message")).append("\n\n"); }
        new AlertDialog.Builder(this).setTitle("Gestes à réconcilier").setMessage(detail.length() == 0 ? "Aucun conflit dans ce carnet." : detail.toString()).setPositiveButton("Fermer", null).show();
      }));
      screen.addView(ink, new LinearLayout.LayoutParams(-1, 0, 1));
      engine.call("open", item);
    });
  }

  void engineEvent(JSONObject event) {
    if (dead) return;
    switch (event.optString("type")) {
      case "ready": engineReady = true; if (connection != null) engine.call("catalogue", connection.session); break;
      case "catalogue": catalogue(event); break;
      case "opened": {
        currentScope = event.optJSONObject("scope"); JSONObject scope = InkView.copy(currentScope);
        disk.execute(() -> {
          try { NativeCommandJournal opened = new NativeCommandJournal(this, scope); JSONObject recovery = opened.recovery();
            runOnUiThread(() -> {
              if (dead || !InkView.sameJson(scope, currentScope)) return;
              journal = opened; JSONArray commands = recovery.optJSONArray("commands"); pendingNative = commands.length();
              for (int n=0;n<commands.length();n++) pending(commands.optJSONObject(n), 1);
              ink.setEnabled(true); drain(); renderScene();
            });
          } catch (Exception error) { runOnUiThread(() -> failJournal(null, error)); }
        }); break;
      }
      case "scene":
        if (ink == null || currentScope != null && !event.optString("resourceId").equals(currentScope.optString("resourceId")) || event.optLong("version") < sceneVersion) return;
        sceneVersion = event.optLong("version"); lastScene = event; renderScene(); break;
      case "command": completeCommand(event); break;
      case "export": export(event.optJSONObject("data")); break;
      case "engineStopped": if (ink != null) ink.setEnabled(false); showError(event.optString("message")); break;
      case "error": showError(event.optString("message")); break;
    }
  }

  void renderScene() {
    if (ink == null || lastScene == null || journalFailed) return;
    ink.merge(lastScene.optJSONArray("objects"), pendingObjects.keySet(), true);
    if (!viewRestored && journal != null) {
      JSONObject saved = lastScene.optJSONObject("savedView");
      if (saved != null) { ink.offsetX = (float)saved.optDouble("x",32); ink.offsetY = (float)saved.optDouble("y",32); ink.scale = (float)saved.optDouble("scale",1); }
      viewRestored = true;
    }
    JSONObject assets = lastScene.optJSONObject("assets");
    if (assets != null) {
      Iterator<String> names = assets.keys();
      while (names.hasNext()) {
        String hash = names.next(); if (ink.images.containsKey(hash) || ink.imageErrors.contains(hash)) continue;
        try {
          byte[] bytes = android.util.Base64.decode(assets.optJSONObject(hash).getString("data"), android.util.Base64.DEFAULT);
          BitmapFactory.Options options = new BitmapFactory.Options(); options.inJustDecodeBounds = true; BitmapFactory.decodeByteArray(bytes,0,bytes.length,options);
          if (options.outWidth < 1 || options.outHeight < 1) throw new IOException("Invalid image");
          options.inSampleSize = 1; while ((long)options.outWidth * options.outHeight / ((long)options.inSampleSize * options.inSampleSize) > 4_000_000) options.inSampleSize *= 2;
          options.inJustDecodeBounds = false; Bitmap image = BitmapFactory.decodeByteArray(bytes,0,bytes.length,options);
          if (image == null) throw new IOException("Invalid image"); ink.images.put(hash, image);
        } catch (Exception error) { ink.imageErrors.add(hash); }
      }
    }
    int conflicts = lastScene.optInt("conflicts");
    if (conflicts > 0) setStatus(conflicts + " conflit(s) · exportez la récupération avant de réconcilier les gestes.");
    else if (pendingNative > 0) setStatus("Enregistrement sur la tablette…");
    else if (lastScene.optBoolean("offline")) setStatus("Conservé sur la tablette · en attente du Mac");
    else if (lastScene.optInt("pending") > 0) setStatus("Conservé sur la tablette · synchronisation en cours");
    else setStatus("Synchronisé avec le Mac · brouillon du carnet");
    undoButton.setEnabled(lastScene.optInt("undo") > 0 && !ink.drawing);
    redoButton.setEnabled(lastScene.optInt("redo") > 0 && !ink.drawing);
    ink.invalidate();
  }

  void pending(JSONObject command, int delta) {
    JSONArray ops = command.optJSONArray("operations");
    for (int n = 0; ops != null && n < ops.length(); n++) {
      String id = ops.optJSONObject(n).optString("id"); int count = pendingObjects.getOrDefault(id, 0) + delta;
      if (count <= 0) pendingObjects.remove(id); else pendingObjects.put(id, count);
    }
  }
  void enqueue(JSONObject action) {
    if (journal == null || journalFailed) { failJournal(action, new IOException("Le stockage local n’est pas prêt. Le geste doit être récupéré.")); return; }
    NativeCommandJournal selected = journal;
    pendingNative++; pending(action, 1); setStatus("Enregistrement sur la tablette…");
    disk.execute(() -> {
      try { selected.append(action); runOnUiThread(this::drain); }
      catch (Exception error) { runOnUiThread(() -> failJournal(action, error)); }
    });
  }
  void drain() {
    if (journal == null || inFlight != null || journalFailed || dead) return;
    JSONObject head = journal.head(); if (head == null) return;
    inFlight = head.optString("id"); engine.call("command", head);
  }
  void completeCommand(JSONObject event) {
    if (journal == null || inFlight == null || !inFlight.equals(event.optString("id"))) return;
    if (!event.optBoolean("success")) { failJournal(null, new IOException(event.optString("message"))); return; }
    NativeCommandJournal selected = journal; String id = inFlight; JSONObject completed = InkView.copy(selected.head());
    disk.execute(() -> {
      try { selected.acknowledge(id); runOnUiThread(() -> {
        if (dead || journal != selected) return;
        pendingNative--; pending(completed, -1); inFlight = null; renderScene(); drain();
        if (pendingNative == 0 && deferredNavigation != null) { Runnable action = deferredNavigation; deferredNavigation = null; action.run(); }
      }); } catch (Exception error) { runOnUiThread(() -> failJournal(null, error)); }
    });
  }
  void failJournal(JSONObject action, Exception error) {
    journalFailed = true; if (ink != null) ink.setEnabled(false);
    if (action != null) unsavedActions.put(InkView.json("scope", currentScope, "action", action));
    showError(error.getMessage());
  }
  void whenJournalIdle(Runnable action) {
    if (pendingNative > 0 || inFlight != null) { deferredNavigation = action; setStatus("Enregistrement local avant de changer de carnet…"); }
    else action.run();
  }
  @Override public void change(JSONArray operations) { changeGesture(operations, UUID.randomUUID().toString()); }
  @Override public void changeGesture(JSONArray operations, String gesture) { enqueue(InkView.json("action", "edit", "gestureId", gesture, "operations", operations)); }
  @Override public void viewport() { if (ink != null && currentScope != null) engine.call("view", InkView.json("x", ink.offsetX, "y", ink.offsetY, "scale", ink.scale)); }
  @Override public void selection(int count) { }
  @Override public void draft(JSONArray points) { }
  @Override public void text(float x, float y) {
    if (ink == null) return;
    InkView target = ink; EditText input = new EditText(this); input.setHint("Texte du carnet"); input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
    target.suspendBoox(true);
    AlertDialog dialog = new AlertDialog.Builder(this).setTitle("Ajouter du texte").setView(input)
      .setPositiveButton("Ajouter", (d, which) -> { if (ink == target && input.length() > 0) target.add(InkView.json("type", "text", "x", x, "y", y, "w", 260, "h", 80, "fontSize", 20, "text", input.getText().toString())); })
      .setNegativeButton("Annuler", null).create();
    dialog.setOnDismissListener(d -> target.suspendBoox(false)); dialog.show();
  }
  void export(JSONObject clientRecovery) {
    NativeCommandJournal selected = journal; JSONObject unsaved = InkView.json("actions", unsavedActions);
    disk.execute(() -> {
      JSONObject result = InkView.json("schemaVersion", 1, "notebook", clientRecovery, "nativeJournal", selected == null ? JSONObject.NULL : selected.recovery(), "unsaved", unsaved);
      byte[] bytes = result.toString().getBytes(StandardCharsets.UTF_8);
      runOnUiThread(() -> { pendingExport = bytes;
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/json").putExtra(Intent.EXTRA_TITLE, "Context-Room-recovery.json");
        startActivityForResult(intent, 7);
      });
    });
  }
  @Override protected void onActivityResult(int request, int result, Intent data) {
    super.onActivityResult(request,result,data);
    if (request != 7 || result != RESULT_OK || data == null || data.getData() == null || pendingExport == null) return;
    byte[] bytes = pendingExport; pendingExport = null; android.net.Uri uri = data.getData();
    disk.execute(() -> { try (OutputStream stream = getContentResolver().openOutputStream(uri, "w")) { if (stream == null) throw new IOException("Le fichier ne peut pas être ouvert."); stream.write(bytes); runOnUiThread(() -> setStatus("Récupération exportée. Les gestes restent dans Context Room.")); }
      catch (Exception error) { runOnUiThread(() -> showError(error.getMessage())); } });
  }
  @Override protected void onPause() { if (ink != null) { ink.finishReachedInk(); ink.suspendBoox(true); viewport(); } super.onPause(); }
  @Override protected void onResume() { super.onResume(); if (ink != null) ink.suspendBoox(false); if (engineReady && currentScope != null) engine.call("refresh"); }
  @Override public void onBackPressed() { if (connection != null && ink != null) whenJournalIdle(() -> { engine.call("close"); engine.call("catalogue", connection.session); }); else super.onBackPressed(); }
  @Override protected void onDestroy() { if (ink != null) ink.finishReachedInk(); dead = true; engine.close(); disk.shutdown(); super.onDestroy(); }
}
