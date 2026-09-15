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
public final class MainActivity extends Activity implements InkView.Listener, NativeNavigation.Host, NativeViews.Host, OwnerWorkspace.Host {
  final ExecutorService disk = Executors.newSingleThreadExecutor();
  final HashMap<String, Integer> pendingObjects = new HashMap<>();
  final JSONArray unsavedActions = new JSONArray();
  NotebookEngine engine;
  NativeNavigation navigation;
  NativeViews views;
  CredentialVault vault;
  DeviceConnection connection;
  OwnerWorkspace ownerWorkspace;
  boolean showingOwner, showingConversation, conversationBusy;
  android.webkit.ValueCallback<android.net.Uri[]> ownerFileCallback;
  OwnerWorkspace fileChooserOwner;
  android.webkit.ValueCallback<Boolean> microphonePermissionCallback;
  Boolean microphonePermissionResult;
  byte[] ownerExportBytes;
  android.webkit.ValueCallback<Boolean> ownerExportCallback;
  NativeCommandJournal journal;
  LinearLayout root, screen, drawingWorkspace;
  TextView status, title;
  EditText pairingInput;
  InkView ink;
  JSONObject lastScene, currentScope, nativeConversationState;
  long sceneVersion = -1;
  int pendingNative;
  boolean engineReady, dead, journalFailed;
  String inFlight;
  String openingId, openingProject, openingPath;
  Runnable deferredNavigation;
  byte[] pendingExport;
  Button undoButton, redoButton, conversationButton, dictateButton, voiceButton;
  long lastAgentRefresh;
  Button shareViewButton, followViewButton, presentationButton;
  TextView viewStatus;
  View drawingTools;
  boolean presentation;
  boolean viewRestored, navigationScreen, resumed;

  @Override public void onCreate(Bundle saved) {
    super.onCreate(saved);
    getWindow().setStatusBarColor(Color.WHITE); getWindow().setNavigationBarColor(Color.WHITE);
    getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
    root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(Color.WHITE);
    root.setFitsSystemWindows(true); setContentView(root);
    screen = new LinearLayout(this); screen.setOrientation(LinearLayout.VERTICAL);
    root.addView(screen, new LinearLayout.LayoutParams(-1, 0, 1));
    engine = new NotebookEngine(this, this::engineEvent);
    navigation = new NativeNavigation(engine.network, this);
    views = new NativeViews(this);
    engine.web.setVisibility(View.INVISIBLE); engine.web.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
    root.addView(engine.web, new LinearLayout.LayoutParams(1, 1));
    vault = new CredentialVault(this);
    header("Context Room", "Ouverture du stockage local…");
    disk.execute(() -> {
      try { JSONObject savedConnection = vault.read(); DeviceConnection found = savedConnection == null ? null : new DeviceConnection(savedConnection);
        runOnUiThread(() -> { if (dead) return; useConnection(found); if (found == null) pairingScreen(); else if (engineReady) connectionHome(); });
      } catch (Exception error) { runOnUiThread(() -> { pairingScreen(); showError(error.getMessage()); }); }
    });
  }
  int dp(float value) { return Math.round(value * getResources().getDisplayMetrics().density); }
  TextView label(String text, float size) { TextView view = new TextView(this); view.setText(text); view.setTextSize(size); view.setTextColor(Color.BLACK); view.setPadding(dp(20), dp(8), dp(20), dp(8)); return view; }
  Button button(String text, Runnable action) {
    Button result = new Button(this); result.setText(text); result.setAllCaps(false); result.setTextColor(Color.BLACK); result.setMinHeight(dp(48));
    result.setOnClickListener(view -> { interaction(); action.run(); }); return result;
  }
  void header(String heading, String detail) {
    showingOwner = false; showingConversation = false; conversationBusy = false; nativeConversationState = null;
    if (ownerWorkspace != null) { ownerWorkspace.leaveConversation(); ownerWorkspace.foreground(false); }
    navigationScreen = false;
    openingId = null;
    if (views != null) views.setMode("independent");
    setPresentation(false);
    screen.removeAllViews(); title = label(heading, 24); title.setTypeface(Typeface.DEFAULT, Typeface.BOLD); screen.addView(title);
    status = label(detail, 15); status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); screen.addView(status);
  }
  void setStatus(String text) { if (status != null && !text.contentEquals(status.getText())) status.setText(text); }
  void showError(String message) { setStatus(message == null ? "Le travail local est conservé. Réessayez la connexion." : message); }
  void useConnection(DeviceConnection selected) {
    if (views != null) views.setMode("independent");
    if (ownerWorkspace != null) { if (ownerWorkspace.web.getParent() instanceof android.view.ViewGroup) ((android.view.ViewGroup) ownerWorkspace.web.getParent()).removeView(ownerWorkspace.web); ownerWorkspace.close(); ownerWorkspace = null; }
    connection = selected; engine.connection = selected; navigation.connect(selected);
    if (engineReady && selected != null) engine.call("session", selected.session);
  }
  void connectionHome() { if (connection.isOwner()) ownerScreen(); else engine.call("catalogue", connection.session); }
  void ownerScreen() {
    engine.call("close"); engine.call("session", connection.session);
    ink = null; currentScope = null; lastScene = null; journal = null;
    header("Context Room", "Interface propriétaire · les fichiers et les décisions restent sur le Mac.");
    try {
      if (ownerWorkspace == null || ownerWorkspace.closed) ownerWorkspace = new OwnerWorkspace(this, connection, this);
      screen.addView(ownerWorkspace.web, new LinearLayout.LayoutParams(-1, 0, 1));
      showingOwner = true; ownerWorkspace.foreground(resumed);
      LinearLayout controls = new LinearLayout(this);
      controls.addView(button("Carnets disponibles hors ligne", () -> engine.call("catalogue", connection.session)));
      controls.addView(button("Connexions", this::pairingScreen));
      controls.addView(button("Recharger", () -> ownerWorkspace.web.reload()));
      HorizontalScrollView toolbar = new HorizontalScrollView(this); toolbar.addView(controls); screen.addView(toolbar);
    } catch (Exception error) { showError(error.getMessage()); screen.addView(button("Réessayer", this::ownerScreen)); screen.addView(button("Connexions", this::pairingScreen)); }
  }
  @Override public void ownerError(String message) { if (!dead && (showingOwner || showingConversation)) showError(message); }
  void nativeConversation() {
    if (showingConversation) { closeNativeConversation(); return; }
    nativeConversation("text");
  }
  void nativeConversation(String mode) {
    if (connection == null || !connection.isOwner() || ink == null || ink.gestureActive() || pendingNative > 0 || inFlight != null || lastScene == null || currentScope == null || lastScene.optBoolean("offline") || lastScene.optInt("pending") > 0) {
      showError("Attendez la confirmation du carnet par le Mac avant d’ouvrir sa conversation."); return;
    }
    whenJournalIdle(() -> {
      try {
        if (ownerWorkspace == null || ownerWorkspace.closed) ownerWorkspace = new OwnerWorkspace(this, connection, this);
        if (ownerWorkspace.web.getParent() instanceof ViewGroup) ((ViewGroup) ownerWorkspace.web.getParent()).removeView(ownerWorkspace.web);
        boolean wide = getResources().getConfiguration().screenWidthDp >= 840;
        drawingWorkspace.setOrientation(wide ? LinearLayout.HORIZONTAL : LinearLayout.VERTICAL);
        ink.setLayoutParams(wide ? new LinearLayout.LayoutParams(0, -1, 1) : new LinearLayout.LayoutParams(-1, 0, 1));
        drawingWorkspace.addView(ownerWorkspace.web, wide ? new LinearLayout.LayoutParams(dp(390), -1) : new LinearLayout.LayoutParams(-1, dp(280)));
        showingConversation = true; ownerWorkspace.foreground(resumed); conversationButton.setText("Fermer la conversation");
        JSONObject source = InkView.json("kind", "notebook", "projectId", lastScene.optString("projectId"), "resourceId", lastScene.optString("resourceId"),
          "path", lastScene.optString("path"), "revision", lastScene.opt("sceneRevision"), "locationRevision", lastScene.opt("locationRevision"), "selection", new JSONArray(ink.selected), "mode", mode);
        ownerWorkspace.conversation(source);
      } catch (Exception error) { showError(error.getMessage()); }
    });
  }
  void closeNativeConversation() {
    if (!showingConversation) return;
    showingConversation = false; conversationBusy = false; nativeConversationState = null;
    if (ownerWorkspace != null) {
      ownerWorkspace.foreground(false); ownerWorkspace.leaveConversation();
      if (ownerWorkspace.web.getParent() instanceof ViewGroup) ((ViewGroup) ownerWorkspace.web.getParent()).removeView(ownerWorkspace.web);
    }
    if (ink != null) { ink.setAgentProgress(null); ink.setLayoutParams(new LinearLayout.LayoutParams(-1, -1)); }
    if (conversationButton != null) conversationButton.setText("Conversation");
  }
  @Override public void ownerConversationState(JSONObject value) {
    if (!showingConversation || ink == null || lastScene == null) return;
    if (value.has("error")) { showError(value.optString("error")); return; }
    JSONObject source = value.optJSONObject("source");
    if (source == null || !"notebook".equals(source.optString("kind")) || !lastScene.optString("projectId").equals(value.optString("projectId"))
      || !lastScene.optString("resourceId").equals(source.optString("resourceId")) || !lastScene.optString("path").equals(source.optString("path"))
      || !Objects.equals(lastScene.opt("locationRevision"), source.opt("locationRevision"))) return;
    if (value.optBoolean("closed") && value.optBoolean("dismiss")) { closeNativeConversation(); return; }
    nativeConversationState = InkView.copy(value);
    conversationBusy = !value.optBoolean("closed") && (value.optBoolean("busy") || value.optBoolean("audioActive") || value.optBoolean("hasDraft"));
    JSONObject progress = value.optBoolean("closed") ? null : value.optJSONObject("progress"); ink.setAgentProgress(progress);
    if (progress != null && !progress.optBoolean("completed") && SystemClock.elapsedRealtime() - lastAgentRefresh > 350) { lastAgentRefresh = SystemClock.elapsedRealtime(); engine.call("refresh"); }
  }
  @Override public InkView.SourcePreview ownerObservation(JSONObject request) throws Exception {
    JSONObject source = request.optJSONObject("source");
    if (dead || !resumed || !showingConversation || ink == null || lastScene == null || nativeConversationState == null || nativeConversationState.optBoolean("closed")
      || source == null || !"notebook".equals(source.optString("kind")) || !lastScene.optString("projectId").equals(request.optString("projectId"))
      || !lastScene.optString("resourceId").equals(source.optString("resourceId")) || !lastScene.optString("path").equals(source.optString("path"))
      || !Objects.equals(lastScene.opt("locationRevision"), source.opt("locationRevision"))) throw new IOException("Revenez au carnet d’origine pour partager son aperçu.");
    return ink.sourcePreview(lastScene);
  }
  @Override public void requestOwnerMicrophone(android.webkit.ValueCallback<Boolean> callback) {
    if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED) { callback.onReceiveValue(true); return; }
    if (microphonePermissionCallback != null) { callback.onReceiveValue(false); return; }
    microphonePermissionCallback = callback; requestPermissions(new String[]{android.Manifest.permission.RECORD_AUDIO}, 73);
  }
  void finishMicrophonePermission() {
    if (!resumed || microphonePermissionResult == null || microphonePermissionCallback == null) return;
    android.webkit.ValueCallback<Boolean> callback = microphonePermissionCallback; boolean granted = microphonePermissionResult;
    microphonePermissionCallback = null; microphonePermissionResult = null; callback.onReceiveValue(granted);
  }
  @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
    super.onRequestPermissionsResult(request, permissions, results);
    if (request == 73) { microphonePermissionResult = results.length == 1 && results[0] == android.content.pm.PackageManager.PERMISSION_GRANTED; finishMicrophonePermission(); }
  }
  @Override public void saveOwnerFile(byte[] bytes, String filename, String type, android.webkit.ValueCallback<Boolean> callback) {
    if (ownerExportCallback != null) { callback.onReceiveValue(false); ownerError("Terminez d’abord l’export ouvert."); return; }
    ownerExportBytes = bytes; ownerExportCallback = callback;
    try { startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(type).putExtra(Intent.EXTRA_TITLE, filename), 72); }
    catch (ActivityNotFoundException error) { ownerExportBytes = null; ownerExportCallback = null; callback.onReceiveValue(false); ownerError("Le sélecteur de fichiers Android est indisponible."); }
  }
  @Override public void chooseOwnerFiles(android.webkit.ValueCallback<android.net.Uri[]> callback, String[] types, boolean multiple) {
    if (ownerFileCallback != null) { callback.onReceiveValue(null); ownerError("Terminez d’abord la sélection ouverte."); return; }
    ownerFileCallback = callback; fileChooserOwner = ownerWorkspace;
    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT); intent.addCategory(Intent.CATEGORY_OPENABLE); intent.setType("*/*");
    ArrayList<String> accepted = new ArrayList<>();
    for (String group : types) for (String value : group.split(",")) if (value.trim().matches("[a-z]+/[a-zA-Z0-9.+_*-]+")) accepted.add(value.trim());
    if (!accepted.isEmpty()) intent.putExtra(Intent.EXTRA_MIME_TYPES, accepted.toArray(new String[0]));
    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple);
    try { startActivityForResult(intent, 71); }
    catch (ActivityNotFoundException error) { ownerFileCallback = null; fileChooserOwner = null; callback.onReceiveValue(null); ownerError("Le sélecteur de fichiers Android est indisponible."); }
  }

  void pairingScreen() {
    ink = null; header("Context Room", "Dessinez sur la tablette, retrouvez le même carnet sur votre Mac.");
    screen.addView(label("Sur le Mac : « Connect tablet » dans un carnet pour dessiner, ou Réglages → Connected devices pour l’interface complète. Collez le code correspondant ici.", 17));
    pairingInput = new EditText(this); pairingInput.setHint("Code de connexion"); pairingInput.setContentDescription("Code de connexion créé sur le Mac");
    pairingInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
    pairingInput.setMinLines(4); pairingInput.setMaxLines(8); pairingInput.setTextSize(14); pairingInput.setPadding(dp(16),dp(12),dp(16),dp(12));
    LinearLayout.LayoutParams inputLayout = new LinearLayout.LayoutParams(-1, -2); inputLayout.setMargins(dp(16),dp(12),dp(16),dp(12)); screen.addView(pairingInput, inputLayout);
    Button pair = button("Connecter cette tablette", () -> {
      String text = pairingInput.getText().toString();
      if (text.length() > 8192) { showError("Ce code est trop long. Recopiez le code créé sur le Mac."); return; }
      try { pair(new JSONObject(text)); } catch (Exception error) { showError("Le code est incomplet. Collez le contenu entier créé sur le Mac."); }
    }); screen.addView(pair);
    if (connection != null) screen.addView(button("Revenir à Context Room", this::connectionHome));
  }

  void pair(JSONObject ticket) {
    setStatus("Vérification de l’identité du Mac…");
    engine.network.execute(() -> {
      try {
        JSONObject saved = DeviceConnection.pair(ticket); vault.save(saved); DeviceConnection paired = new DeviceConnection(saved);
        runOnUiThread(() -> { if (dead) return; useConnection(paired); if (pairingInput != null) pairingInput.setText("");
          if (engineReady) connectionHome(); else setStatus("Connexion enregistrée. Ouverture du moteur local…"); });
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
    if (connection.isOwner()) screen.addView(button("Interface complète", this::ownerScreen));
    navigationScreen = true;
  }

  void savedConnections() {
    disk.execute(() -> {
      try { JSONArray saved = vault.list(); String[] labels = new String[saved.length()];
        for (int n = 0; n < saved.length(); n++) { JSONObject device = saved.getJSONObject(n).getJSONObject("device");
          JSONObject grant = device.getJSONArray("grants").getJSONObject(0);
          labels[n] = device.optString("label", "Tablette") + " · " + ("owner".equals(grant.optString("mode")) ? "Interface propriétaire" : grant.getJSONArray("paths").getString(0)); }
        runOnUiThread(() -> new AlertDialog.Builder(this).setTitle("Connexions enregistrées").setItems(labels, (dialog, selected) -> disk.execute(() -> {
          try { JSONObject value = saved.getJSONObject(selected); DeviceConnection picked = new DeviceConnection(value); vault.save(value);
            runOnUiThread(() -> { if (dead) return; useConnection(picked); engine.call("close"); connectionHome(); });
          } catch (Exception error) { runOnUiThread(() -> showError(error.getMessage())); }
        })).setNegativeButton("Fermer", null).show());
      } catch (Exception error) { runOnUiThread(() -> showError(error.getMessage())); }
    });
  }

  @Override public void openNotebook(JSONObject item) {
    whenJournalIdle(() -> {
      engine.call("close"); journal = null; currentScope = null; pendingObjects.clear(); sceneVersion = -1; lastScene = null; inFlight = null; journalFailed = false; viewRestored = false;
      header(item.optString("title", item.optString("path")), "Ouverture du carnet…");
      openingId = UUID.randomUUID().toString(); openingProject = item.optString("projectId"); openingPath = item.optString("path");
      JSONObject openItem = InkView.copy(item);
      try { openItem.put("nativeOpenId", openingId); } catch (JSONException error) { throw new IllegalStateException(error); }
      HorizontalScrollView scrolling = new HorizontalScrollView(this); scrolling.setHorizontalScrollBarEnabled(false);
      drawingTools = scrolling;
      LinearLayout tools = new LinearLayout(this); scrolling.addView(tools); screen.addView(scrolling);
      tools.addView(button(connection.isOwner() ? "Context Room" : "Carnets", () -> whenJournalIdle(() -> { engine.call("close"); connectionHome(); })));
      conversationButton = null; dictateButton = null; voiceButton = null;
      if (connection.isOwner()) {
        conversationButton = button("Conversation", this::nativeConversation); dictateButton = button("Dicter", () -> nativeConversation("dictate")); voiceButton = button("Parler", () -> nativeConversation("voice"));
        for (Button action : new Button[]{conversationButton, dictateButton, voiceButton}) { action.setEnabled(false); tools.addView(action); }
      }
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
      drawingWorkspace = new LinearLayout(this); drawingWorkspace.addView(ink, new LinearLayout.LayoutParams(-1, -1));
      screen.addView(drawingWorkspace, new LinearLayout.LayoutParams(-1, 0, 1));
      HorizontalScrollView viewScrolling = new HorizontalScrollView(this); LinearLayout viewTools = new LinearLayout(this); viewScrolling.addView(viewTools);
      shareViewButton = button("Partager ma vue", () -> views.setMode(views.mode.equals("share") ? "independent" : "share"));
      followViewButton = button("Suivre le Mac", () -> views.setMode("follow"));
      // A selected Follow button is also a direct stop; the generic button handler
      // already returns the view to human control before the action runs.
      followViewButton.setOnClickListener(v -> { if (views.mode.equals("follow")) interaction(); else { interaction(); views.setMode("follow"); } });
      presentationButton = button("Plein écran", () -> setPresentation(!presentation));
      viewTools.addView(shareViewButton); viewTools.addView(followViewButton); viewTools.addView(presentationButton); screen.addView(viewScrolling);
      viewStatus = label("Vues indépendantes.", 13); viewStatus.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); screen.addView(viewStatus);
      engine.call("open", openItem);
    });
  }

  void engineEvent(JSONObject event) {
    if (dead) return;
    switch (event.optString("type")) {
      case "ready": engineReady = true; if (connection != null) { engine.call("session", connection.session); connectionHome(); } break;
      case "catalogue": catalogue(event); break;
      case "opened": {
        if (openingId == null || !openingId.equals(event.optString("openId")) || !openingPath.equals(event.optString("path"))) return;
        currentScope = event.optJSONObject("scope"); JSONObject scope = InkView.copy(currentScope);
        disk.execute(() -> {
          try { NativeCommandJournal opened = new NativeCommandJournal(this, scope); JSONObject recovery = opened.recovery();
            runOnUiThread(() -> {
              if (dead || !InkView.sameJson(scope, currentScope)) return;
              journal = opened; JSONArray commands = recovery.optJSONArray("commands"); pendingNative = commands.length();
              for (int n=0;n<commands.length();n++) pending(commands.optJSONObject(n), 1);
              navigationScreen = true; ink.setEnabled(true); drain(); renderScene();
            });
          } catch (Exception error) { runOnUiThread(() -> failJournal(null, error)); }
        }); break;
      }
      case "scene":
        if (openingId == null || !openingId.equals(event.optString("openId")) || !openingProject.equals(event.optString("projectId")) || !openingPath.equals(event.optString("path"))) return;
        if (ink == null || currentScope != null && !InkView.sameJson(currentScope, event.optJSONObject("scope")) || event.optLong("version") < sceneVersion) return;
        sceneVersion = event.optLong("version"); lastScene = event; renderScene(); break;
      case "command": completeCommand(event); break;
      case "export": export(event.optJSONObject("data")); break;
      case "engineStopped": navigationScreen = false; navigation.unavailable(); if (ink != null) ink.setEnabled(false); showError(event.optString("message")); break;
      case "error": if (event.has("openId") && (openingId == null || !openingId.equals(event.optString("openId")))) return; if (currentScope == null) navigation.unavailable(); showError(event.optString("message")); break;
    }
  }

  void renderScene() {
    if (ink == null || lastScene == null || currentScope == null || !InkView.sameJson(currentScope, lastScene.optJSONObject("scope")) || journalFailed) return;
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
    if (conversationButton != null) {
      boolean ready = !ink.gestureActive() && pendingNative == 0 && inFlight == null && lastScene.optInt("pending") == 0 && !lastScene.optBoolean("offline");
      conversationButton.setEnabled(showingConversation || ready); dictateButton.setEnabled(ready); voiceButton.setEnabled(ready);
    }
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
        settleNavigation();
      }); } catch (Exception error) { runOnUiThread(() -> failJournal(null, error)); }
    });
  }
  void failJournal(JSONObject action, Exception error) {
    journalFailed = true; if (ink != null) ink.setEnabled(false);
    if (action != null) unsavedActions.put(InkView.json("scope", currentScope, "action", action));
    showError(error.getMessage());
  }
  void whenJournalIdle(Runnable action) {
    if (journalFailed) { showError("Récupérez les gestes du carnet avant de changer de vue."); return; }
    if (pendingNative > 0 || inFlight != null || ink != null && ink.gestureActive()) { deferredNavigation = action; setStatus("Enregistrement local avant de changer de carnet…"); }
    else action.run();
  }
  void settleNavigation() {
    if (pendingNative == 0 && inFlight == null && !journalFailed && (ink == null || !ink.gestureActive()) && deferredNavigation != null) {
      Runnable action = deferredNavigation; deferredNavigation = null; action.run();
    }
  }
  @Override public boolean navigationBusy() {
    return !resumed || dead || !engineReady || !navigationScreen || !hasWindowFocus() || journalFailed || conversationBusy || pendingNative > 0 || inFlight != null
      || deferredNavigation != null || ink != null && (ink.gestureActive() || currentScope == null || journal == null
        || lastScene == null || !InkView.sameJson(currentScope, lastScene.optJSONObject("scope")) || lastScene.optInt("pending") > 0 || lastScene.optBoolean("offline"));
  }
  @Override public void remoteOpen(JSONObject target) {
    JSONObject item = InkView.copy(target);
    try { item.put("expectedTarget", InkView.copy(target)); } catch (JSONException error) { navigation.unavailable(); return; }
    openNotebook(item);
  }
  @Override public void navigationNotice(String message) { setStatus(message); }
  @Override public void interaction() { if (views != null) views.interaction(); if (navigation != null) navigation.interaction(); }
  @Override public void rendered(InkView source) {
    final JSONObject renderedScene = lastScene;
    source.post(() -> {
      if (dead || ink != source || renderedScene != lastScene) return;
      settleNavigation();
      if (ink == source && !navigationBusy() && source.isAttachedToWindow() && source.isShown()
          && InkView.sameJson(currentScope, renderedScene == null ? null : renderedScene.optJSONObject("scope"))) { navigation.rendered(renderedScene); views.rendered(); }
    });
  }
  @Override public void change(JSONArray operations) { changeGesture(operations, UUID.randomUUID().toString()); }
  @Override public void changeGesture(JSONArray operations, String gesture) { enqueue(InkView.json("action", "edit", "gestureId", gesture, "operations", operations)); }
  @Override public void viewport() { if (ink != null && currentScope != null) engine.call("view", InkView.json("x", ink.offsetX, "y", ink.offsetY, "scale", ink.scale)); }
  @Override public JSONObject viewState() { return views.body(); }
  @Override public void receiveView(JSONObject data, JSONObject sent) { views.receive(data, sent); }
  @Override public void viewFailure() { views.setMode("independent"); }
  @Override public JSONObject viewTarget() {
    if (!resumed || dead || !navigationScreen || !hasWindowFocus() || ink == null || currentScope == null || lastScene == null || !InkView.sameJson(currentScope, lastScene.optJSONObject("scope")) || lastScene.optBoolean("offline")) return null;
    return InkView.json("projectId", lastScene.optString("projectId"), "resourceId", lastScene.optString("resourceId"), "path", lastScene.optString("path"), "locationRevision", lastScene.opt("locationRevision"));
  }
  @Override public JSONArray viewBounds() { return ink == null ? null : ink.viewportBounds(); }
  @Override public boolean viewBusy() { return navigationBusy(); }
  @Override public boolean frameView(JSONArray bounds) { if (ink == null || navigationBusy() || !ink.frameSharedView(bounds)) return false; viewport(); return true; }
  @Override public void viewNotice(String mode, String message) {
    if (viewStatus != null) viewStatus.setText(message);
    if (shareViewButton != null) { shareViewButton.setSelected(mode.equals("share")); shareViewButton.setText(mode.equals("share") ? "Arrêter le partage" : "Partager ma vue"); }
    if (followViewButton != null) { followViewButton.setSelected(mode.equals("follow")); followViewButton.setText(mode.equals("follow") ? "Arrêter le suivi" : "Suivre le Mac"); }
  }
  void setPresentation(boolean enabled) {
    presentation = enabled;
    if (title != null) title.setVisibility(enabled ? View.GONE : View.VISIBLE);
    if (status != null) status.setVisibility(enabled ? View.GONE : View.VISIBLE);
    if (drawingTools != null) drawingTools.setVisibility(enabled ? View.GONE : View.VISIBLE);
    if (presentationButton != null) presentationButton.setText(enabled ? "Quitter le plein écran" : "Plein écran");
    getWindow().getDecorView().setSystemUiVisibility(enabled ? View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
      : View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
  }
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
    if (request == 72) {
      android.webkit.ValueCallback<Boolean> callback = ownerExportCallback; byte[] bytes = ownerExportBytes;
      ownerExportBytes = null; ownerExportCallback = null;
      android.net.Uri uri = data == null ? null : data.getData();
      if (callback == null) return;
      if (result != RESULT_OK || bytes == null || uri == null || !"content".equals(uri.getScheme())) { callback.onReceiveValue(false); return; }
      disk.execute(() -> {
        try (OutputStream stream = getContentResolver().openOutputStream(uri, "w")) {
          if (stream == null) throw new IOException("Destination indisponible."); stream.write(bytes);
        } catch (Exception error) { runOnUiThread(() -> { callback.onReceiveValue(false); ownerError("L’export n’a pas été écrit. Le travail reste disponible."); }); return; }
        runOnUiThread(() -> { callback.onReceiveValue(true); ownerError("Fichier exporté dans la destination choisie."); });
      }); return;
    }
    if (request == 71) {
      android.webkit.ValueCallback<android.net.Uri[]> callback = ownerFileCallback; ownerFileCallback = null;
      boolean valid = fileChooserOwner == ownerWorkspace && showingOwner; fileChooserOwner = null;
      ArrayList<android.net.Uri> selected = new ArrayList<>();
      if (valid && result == RESULT_OK && data != null) {
        if (data.getClipData() != null) for (int n = 0; n < Math.min(16, data.getClipData().getItemCount()); n++) selected.add(data.getClipData().getItemAt(n).getUri());
        else if (data.getData() != null) selected.add(data.getData());
      }
      selected.removeIf(uri -> uri == null || !"content".equals(uri.getScheme()));
      if (callback != null) callback.onReceiveValue(selected.isEmpty() ? null : selected.toArray(new android.net.Uri[0]));
      return;
    }
    if (request != 7 || result != RESULT_OK || data == null || data.getData() == null || pendingExport == null) return;
    byte[] bytes = pendingExport; pendingExport = null; android.net.Uri uri = data.getData();
    disk.execute(() -> { try (OutputStream stream = getContentResolver().openOutputStream(uri, "w")) { if (stream == null) throw new IOException("Le fichier ne peut pas être ouvert."); stream.write(bytes); runOnUiThread(() -> setStatus("Récupération exportée. Les gestes restent dans Context Room.")); }
      catch (Exception error) { runOnUiThread(() -> showError(error.getMessage())); } });
  }
  @Override protected void onPause() { resumed = false; if (ownerWorkspace != null) ownerWorkspace.foreground(false); views.setMode("independent"); navigation.foreground(false); if (ink != null) { ink.finishReachedInk(); ink.suspendBoox(true); viewport(); } super.onPause(); }
  @Override protected void onResume() { super.onResume(); resumed = true; if (ownerWorkspace != null) ownerWorkspace.foreground(showingOwner || showingConversation); finishMicrophonePermission(); navigation.foreground(true); if (ink != null) ink.suspendBoox(false); if (engineReady && currentScope != null) engine.call("refresh"); }
  @Override public void onBackPressed() { interaction(); if (showingConversation) { closeNativeConversation(); return; } if (presentation) { setPresentation(false); return; } if (showingOwner && ownerWorkspace.web.canGoBack()) { ownerWorkspace.web.goBack(); return; } if (connection != null && ink != null) whenJournalIdle(() -> { engine.call("close"); connectionHome(); }); else super.onBackPressed(); }
  @Override protected void onDestroy() { if (ink != null) ink.finishReachedInk(); dead = true; if (ownerFileCallback != null) { ownerFileCallback.onReceiveValue(null); ownerFileCallback = null; } if (ownerExportCallback != null) { ownerExportCallback.onReceiveValue(false); ownerExportCallback = null; ownerExportBytes = null; } if (ownerWorkspace != null) ownerWorkspace.close(); navigation.close(); engine.close(); disk.shutdown(); super.onDestroy(); }
}
