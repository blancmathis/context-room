# Parité Lisière → Context Room (T-021, lot 1)

Date : 2026-10-24. Base : HEAD intégré `40285c8` (branche
`mathis/t021-lisiere-parite`). Release déployée sur le Mac : `bbfef3d-p4319`
(sans les lots L1 à L9 ci-dessous).
Auteur : Claude (T-021). Les mesures du § (b) datent du 2026-10-15. Aucun
service Lisière n'a été arrêté, aucune donnée Lisière ni `~/.context-room`
n'a été écrite par cette doc.

## En bref

- La v2 reprend le cœur de Lisière : carnets, conversations par source, dictée,
  voix, appairage, vues partagées, présentation, cache hors ligne, migration.
- Lots fusionnés (PR #74) : L1 (bascule), L2L7 (chaîne APK), L3 (espace
  Carnets), L4 (lecteur PDF/image), L5 (Codex du Mac), L6 (découverte), L8
  (sauvegarde), L9a (sommaire, Aa, recherche sans accents, chercher/remplacer,
  cibles de 44 px), L9b (Fast, Follow agent, export PNG/PDF, appairage
  QR/fichier). Correctifs : e2e (7209b69), scan `/proc` sous Linux (678c13b),
  revue finale A (gestes de bascule des carnets) et revue finale B (5 points).
  L2 (export de la BOOX) attend la tablette.
- Huit écarts de parité sont **acceptés par Mathis** (2026-10-23) : § (a) et
  `DECISIONS.md`. Les autres manques sont marqués « absent » ou « partiel ».
- Aucun essai sur la BOOX réelle n'a eu lieu : la porte V18 reste fermée. La
  séance BOOX unique essaie tout d'un coup.
- Les données Mac sont petites (4 carnets, 3 conversations, 2 021 messages).
  Elles sont **déjà importées** le 2026-09-16, aux révisions actuelles.
- Les données de la tablette (cache, file d'envoi, enregistrements PCM) sont
  **inconnues** : il faut l'export par l'APK de récupération sur la BOOX.
- L'aperçu de `--cutover-lisiere` sur le vrai service passe (sans `--apply`).

```
            ANCIEN (à retirer)                         NOUVEAU
 ┌──────────────────────────────────┐        ┌──────────────────────────────┐
 │ BOOX : fr.lisiere.android 0.1.90 │        │ BOOX : app Context Room      │
 │  cache, outbox, PCM (inconnus)   │──APK──▶│  (WebView, ou APK recovery   │
 └───────────────┬──────────────────┘ export │   fr.lisiere.android)        │
                 │ TLS 8767 / Bonjour        └──────────────┬───────────────┘
 ┌───────────────▼──────────────────┐                       │ 4318/4320 LAN
 │ Mac : fr.lisiere.companion       │  --export-lisiere ┌───▼──────────────┐
 │  ~/.local/share/lisiere/workspace│──────────────────▶│ Hub 127.0.0.1:4319│
 │ Mac : fr.lisiere.updates (8765)  │  --cutover-lisiere│ app.contextroom.  │
 │ ~/Documents/Lisière/Carnets      │  (retrait final)  │ local             │
 └──────────────────────────────────┘                   └──────────────────┘
```

## (a) Tableau de parité

Statuts : **prouvé** = présent avec un test automatique ; **partiel** = présent
mais incomplet ou jamais essayé sur la BOOX réelle ; **absent** = rien dans le
code ; **écart accepté** = Mathis a choisi de ne pas copier le comportement
Lisière (2026-10-23, huit points). « BOOX réelle » : la porte V18 (essai
physique) n'est pas encore passée.

### Tablette, lecture et édition

| Fonction Lisière | Équivalent Context Room | Statut |
|---|---|---|
| Appairage QR / code 10 min, page HTML `lisiere pair --output` | Billet de 2 min à usage unique, identifiant 30 j, épingle du certificat (`src/device_authority.mjs`, `src/device_owner.mjs`) ; QR affiché dans la feuille d'appairage et fichier `context-room-pairing.json` importé par l'APK (L9b-2, 5f9e999). Pas de scanner QR dans l'APK : la BOOX n'a pas de caméra, le fichier le remplace. Tests : `test/devices.test.mjs`, `test/device_owner.test.mjs`, `test/e2e/notebooks.spec.mjs:41,166,171` (« pairing sheet shows a QR code and saves a pairing file »). Limites : `PairingFileTest` (androidTest) compile mais n'a pas tourné ; QR, fichier et import jamais essayés sur la BOOX ; pas de page HTML hors ligne. | partiel |
| Rôles propriétaire / dessin seul, révocation | `src/device_owner.mjs` ; `test/e2e/notebooks.spec.mjs:166` | prouvé |
| Parcourir : Projets / Fichiers / Carnets / Récents | Navigation Hub + documents (`src/ui/app.mjs`, `src/device_navigation.mjs`) ; e2e Hub | prouvé |
| Lecteur HTML (ressources locales, liens externes) | Docs rendues + `src/document_assets.mjs` | prouvé |
| « Lire le texte » paginé, Sommaire > 300 sections, recherche sans accents, Aa | Lecteur de documents (L9a, 40285c8, `src/ui/text-tools.mjs`) : sommaire paginé (40 titres par page, avec recherche, titre courant en gras), sommaire des docs HTML, boutons Page, réglage Aa (lecture et édition ; le texte brut suit Aa sans saut de taille) ; cibles de 44 px pour la recherche du sommaire, ses liens et les boutons Aa, Undo, Redo, Find, Contents (r2, 9db43b2) ; recherche sans accents dans l'explorateur, les documents et les carnets. Preuves : `test/text_tools.test.mjs`, e2e `test/e2e/read-first.spec.mjs`. Limites : un texte aux accents décomposés (NFD) n'est pas trouvé ; aucun essai sur encre. « Lire le texte » remplacé par Page + Edit : écart accepté (Mathis, 2026-10-23). | partiel (essai BOOX à faire) |
| Modifier HTML/MD → diff → « Appliquer sur le Mac » | Brouillon + proposition locale + revue humaine (`src/local_proposals.mjs`, `docs/features/document-workflow.md`) | prouvé |
| Gros éditeur (annuler/rétablir, chercher/remplacer, 20 Mio) | Éditeur Markdown et éditeur de brouillon (L9a, 40285c8) : Annuler, Rétablir, Rechercher/Remplacer ; « Tout remplacer » compte pour une seule étape d'annulation et garde la borne de 200 étapes ; Undo et Redo sont grisés quand il n'y a rien à annuler ou à refaire ; la barre Find du brouillon ne change rien pendant Save ou Submit (r2, 9db43b2). Limite de 16 Mio au lieu de 20. Preuves : `test/text_tools.test.mjs`, e2e `test/e2e/read-first.spec.mjs` et `test/e2e/lisiere-drafts.spec.mjs`. Le cas de 1,7 Mo (`lisiere-drafts.spec.mjs:109` : 6400 remplacements, une seule étape d'annulation, rien d'écrit sur disque) passe sur les 4 projets (WebKit : 17 s). L'éditeur n'était pas lent : le `fill()` de Playwright sous WebKit dépasse 100 s même sur une textarea nue. Le test pose donc le texte par `value` et l'événement `input` (1eade9a). La CI ne lance pas ce fichier. | prouvé (e2e, 4 projets, sur ci) ; limite 16 Mio : écart accepté (Mathis, 2026-10-23) |
| Lecteur PDF et image (pages, zoom, « Image entière », Annoter) | Lecteur PDF/image fusionné (L4, 7f178e6) : pdf.js 6.4.299 copié dans le paquet (`src/ui/document-viewer.mjs`), route `/vendor/pdfjs/` sans `'wasm-unsafe-eval'`. Preuves : `test/document_viewer.test.mjs` 27/27, route pdf.js 1/1 (`test/context_room.test.mjs`) ; annotation PNG de revue (`test/e2e/notebooks.spec.mjs:499`). Limites : aucun essai BOOX ; chemin tablette (proxy propriétaire) sans e2e ; pas de PDF JPX en test. La course `openPdf` est corrigée (L9a). Le kit Mac admet les polices standard de pdf.js vendues (7209b69, `test/mac_installation.test.mjs`) : avant, `prepare-mac-install` refusait le paquet. | partiel (essai BOOX à faire) |
| Carnets stylet/doigt, zoom 2 doigts, gomme, sélection, formes | `.crnb` (`src/notebook_*.mjs`, `src/ui/notebook-*.mjs`, `android/.../InkView.java`, `BooxInk.java`) ; `test/notebook*.test.mjs`, `test/e2e/notebooks.spec.mjs:216,372,484` | prouvé (navigateur) ; partiel (BOOX réelle) |
| Mémos libres hors projet (`~/Documents/Lisière/Carnets`) | Espace Notebooks (`~/Documents/Context Room/Carnets`), New notebook, déplacement vérifié vers un projet et retour (`test/notebooks.test.mjs` transfer, `test/hub_durable_identity.test.mjs` space, e2e « Notebooks space »). Les 4 mémos passent par `migrate --notebooks-to-space` à la bascule. | prouvé (navigateur) ; partiel (BOOX réelle) |
| Accueil « reprendre / Nouveau mémo » | Section Notebooks en tête de l'accueil du Hub : New notebook, Resume sur le plus récent, retrouvé après redémarrage du Hub (e2e « Notebooks space ») ; contraste AA du bouton New notebook dans les deux thèmes (7209b69, e2e `accessibility.spec.mjs:77,90`) | prouvé (navigateur) ; partiel (BOOX réelle) |
| Cache hors ligne + file d'opérations à ID stables, conflit → copie | `test/e2e/notebooks.spec.mjs:261,283,318,358` | prouvé |
| Créer un carnet hors ligne | Non repris en v1 ; la conception reste extensible (`DECISIONS.md`, écart 7) | écart accepté (Mathis, 2026-10-23) |
| Persistance des décisions Appliquer/Refuser, reprise | Reçus signés + annulation (`docs/features/review-authority.md`) | prouvé |

### Agent, conversations, voix

| Fonction Lisière | Équivalent Context Room | Statut |
|---|---|---|
| Discussions par projet, historique | Conversations par source (`src/assistant_*.mjs`, `docs/features/conversations.md`) ; `test/assistant_*.test.mjs`, `test/e2e/assistant.spec.mjs` | prouvé |
| Codex limité à la sélection, modes « Sélection seule / et ajouts » | Outils liés au fichier ou carnet d'origine (`src/codex_provider.mjs`), « Annotate passage » | prouvé |
| Choix du modèle, raisonnement, Fast | Catalogue après connexion explicite ; `reasoningEffort` (`src/ui/assistant.mjs:245`) ; case Fast (L9b-1, 26061bb, r2 8905bba) : un modèle sans `priority` désactive Fast et une note le dit ; `serviceTier: null` à chaque tour sinon (voulu). Preuve : `test/e2e/assistant.spec.mjs:208` (faux fournisseur, e2e ci 8/8). Limites : aucun vrai tour Fast (limite Codex jusqu'au 2026-11-17) ; l'état « avant le chargement du catalogue » n'a pas de test ; case à essayer au doigt sur la BOOX. | partiel |
| Dicter (Whisper local) | `src/local_audio*.mjs`, whisper-cli ; `test/e2e/assistant-voice.spec.mjs` | prouvé |
| Voix temps réel (WebRTC) | Voice avec VAD Silero (local, pas WebRTC) ; `test/e2e/assistant-voice.spec.mjs` | prouvé (autre technique) |
| `voice.say` (lecture de réponse) | « Read answer » via `/usr/bin/say` (`src/local_audio.mjs:68`) | prouvé |
| Dessin à la voix avec vue en direct, « Suivre Codex » | Suivi de vue / partage de vue (`docs/system/connected-devices.md`) et bouton **Follow agent** (L9b-1) : la vue suit les outils de l'agent ; choisir « Follow <appareil> » l'arrête ; Ask about selection, Dictate about notebook et Voice ne l'arrêtent pas (Dictate text, oui) ; permis aussi en vue partagée (c03b208). Preuves : `test/e2e/notebooks.spec.mjs:90`, `test/e2e/assistant.spec.mjs:190`. Limite : le clignotement sur encre n'est vu qu'à la BOOX. | prouvé (navigateur) ; partiel (BOOX réelle) |
| Micro Android du propriétaire, dictée récupérée | `NativeAudio.java`, « Recover dictation », `test/e2e/recovery-recordings.spec.mjs` | partiel (BOOX réelle) |
| « Afficher cette discussion sur le Mac » (`agent.open`) | **Show on Mac** (L5, bfe4211) ouvre Codex Desktop sur une tâche (`docs/features/conversations.md` § Show on Mac) ; « Open on device » pour le sens inverse. « Continuer cette tâche » n'existe pas. Preuve : tests avec `openUrl` factice. Reste : essai de bout en bout depuis la BOOX. | prouvé (tests) ; « Continuer » : écart accepté (Mathis, 2026-10-23) |
| Tâches du Mac : lire les sessions Codex (`agent.sessions`) | Liste et lecture seules (`thread/list`, `thread/read`, `thread/turns/list`) : `test/codex_provider.test.mjs`, `test/assistant_http.test.mjs`, `test/e2e/assistant.spec.mjs:159`. Limite : l'essai réel sur le 1er projet du catalogue a rendu 0 tâche ; aucun `thread/read` réel. | prouvé (faux fournisseur) ; essai réel à faire |
| Catalogue des projets Codex Desktop (`integrations.json codexProjects`) | Aperçu du catalogue puis import choisi dans le registre (`src/codex_catalog.mjs`) : `test/codex_catalog.test.mjs`, `test/e2e/web-app.spec.mjs:239` ; aperçu réel : 14 projets (4 `ready`, 8 `needs-init`, 1 `missing`, 1 `refused`). Correctif r2 (f78968d) : un projet inscrit puis déplacé sort `registered`. Sur mobile, le bouton Import from Codex a sa place dans l'en-tête (7209b69, e2e `remaining-browser-scenarios.spec.mjs:465`). Limites : un projet déplacé reste indisponible jusqu'au geste de confirmation ; le lien de confirmation n'a pas d'e2e ; aucun vrai import d'un projet `ready` (geste de Mathis). | prouvé (tests, aperçu réel) ; import réel à faire |
| Dictée via tâche Codex éphémère | Remplacée par Whisper local (décision v2 : aucun appel de modèle par CR) | écart accepté (Mathis, 2026-10-23) |

### Mac, présentation, réseau, mise à jour

| Fonction Lisière | Équivalent Context Room | Statut |
|---|---|---|
| « Présenter sur le Mac » (`lisiere present`, ≤ 4 i/s) | Presentation dans l'éditeur commun + partage de vue (`src/device_views.mjs`, `test/device_display.test.mjs`, `test/e2e/notebooks.spec.mjs:72`) | prouvé |
| `lisiere open`, `doctor`, `capabilities` | `context-room open`, `doctor` (CLI `bin/context-room.mjs`) | prouvé |
| `lisiere network` (état Tailscale) | `doctor` : diagnostic réseau en lecture seule (LAN, Tailscale `status --json`, bornes 5 s / 1 s ; L6, f74c994) ; `test/local_network_diagnostics.test.mjs` | prouvé |
| `lisiere desktop UUID` | **Show on Mac** (voir « Afficher cette discussion sur le Mac ») ; l'UUID n'est plus saisi | écart accepté (Mathis, 2026-10-23) |
| Redécouverte Bonjour `_lisiere._tcp` | Le Hub annonce `_contextroom` avec `dns-sd` ; l'APK retrouve le Mac par la même empreinte TLS (`DeviceConnection.java`, `MacDiscovery.java`) ; `test/device_discovery.test.mjs` (10/10 avec le diagnostic), essai réel `dns-sd` sur un Hub de test. Pas de `--device-host auto`. Corrigés ensuite : état de l'annonce et orphelin `dns-sd` (f88ab76), dédoublonnage des sondes (L9b-2, sans test). Limites : `MacDiscoveryTest` jamais lancé (pas d'émulateur) ; 32 fausses annonces locales peuvent épuiser le budget de recherche (accepté, noté dans `connected-devices.md`) ; la redécouverte après un changement d'adresse se vérifie à la séance BOOX. | partiel |
| Service APK `fr.lisiere.updates` (8765) + mise à jour dans l'app | PWA mise à jour par service worker (`docs/system/connected-devices.md`). Chaîne APK fusionnée (L2L7, 82d62fc) : build sur `ci` sans clé, signature sur le Mac (`scripts/sign-android-apk.sh`, v2 + v3), contrôle `check-android-artifact.py`, clé stable `tablet.keystore`. Pas d'installateur dans l'app ; un serveur temporaire (port 8796, 3 h) sert l'APK à la séance BOOX. | écart accepté (Mathis, 2026-10-23) |
| Clé de signature `development.keystore` | Reprise par `scripts/build-android-recovery.sh` (identité `fr.lisiere.android`) ; copie séparée par `scripts/lisiere-backup.py` (sha256 égal). L'app Context Room (`app.contextroom.tablet`) a sa propre clé `tablet.keystore`. | prouvé (M07, `eadc14c`) |
| `lisiere backup` / `restore` (tar.gz) | `context-room backup` / `restore` (L8, 219c815 + 91d3995) : registre, reçus de revue, conversations, enregistrements, carnets ; aperçu puis révision exacte, copie « before-restore », jamais de suppression. `test/backup.test.mjs` 26/26 après r2. Limites : l'annulation ne retire pas les fichiers créés ; Hub à arrêter pour restaurer ; un enregistrement de plus de 256 Mo est sauté et listé (`skipped`) ; aucune restauration réelle essayée. Les données Lisière ont leur propre script (étape 1 du § (c)). | partiel |
| Stockage `Titre--id.lisiere` (tableau.json, apercu.png, dessin.pdf, README) | `.crnb` dans le projet. Export PNG / PDF **à la demande** depuis l'éditeur (bouton Export, L9b-1) : `test/e2e/notebooks.spec.mjs:715` ; titre PDF coupé par point de code. Pas d'aperçu PNG ni de PDF automatique. Reste : ouvrir un PDF et un PNG exportés sur la BOOX. | écart accepté (Mathis, 2026-10-23) ; export à la demande prouvé |
| `lisiere projects add/list`, `rpc …` | `project register`, API Hub | prouvé |
| Désinstallation qui garde les données (`uninstall-companion.sh`) | `--cutover-lisiere` garde tout dans une rétention privée. Essai synthétique macOS (L1, ab443b4 + 284df00) : vrai `launchctl`, `lsof`, `renamex_np` sur un agent `test.contextroom.synthetic-*` ; `test/lisiere_cutover.test.mjs`, `test/lisiere_backup.test.mjs`, test opt-in `test/lisiere_cutover_launchd.test.mjs` (`CONTEXT_ROOM_LAUNCHD_ESSAY=1`) ; 81 tests OK, 2 sautés (launchd). | prouvé (synthétique, macOS) ; jamais appliqué au vrai service |

## (b) Inventaire des données (lecture seule, 2026-10-15)

| Emplacement | Taille | Contenu |
|---|---|---|
| `~/.local/share/lisiere/workspace/` | 4,3 Mo | `workspace.sqlite` 3,8 Mo (dernière écriture 2026-10-14 09:05, au redémarrage), `assets/` 3 fichiers, `integrations.json`, `server.key/pem`, `admin.token`, `service.log` |
| `~/.local/share/lisiere/models/` | 547 Mo | `ggml-large-v3-turbo-q5_0.bin`. Context Room a **sa propre copie** (`~/.context-room/assistant/models/`, autre inode) : la supprimer ne casse rien. |
| `~/.local/share/lisiere/updates/` | 188 Mo | 3 APK + `latest.json` (dernier : 0.1.90-workspace, versionCode 95) |
| `~/.local/share/lisiere/backups/` | 14 Mo | 15 sqlite + 2 dossiers de dessins (9–11 sept.) |
| `~/.local/share/lisiere/signing/development.keystore` | — | **À garder** : sans elle, plus de mise à jour possible de `fr.lisiere.android` |
| `~/Documents/Lisière/` | 1,6 Mo | `Carnets/` 4 dossiers `.lisiere`, `README.md`, `index.json`, `.moves.json` |
| Tablette BOOX (NoteAir5C, appairée 2026-09-05) | ? | cache, outbox, PCM : **inconnus** (pas d'adb ici) |

Comptes de `workspace.sqlite` (export à blanc, révision
`b22a8bf4…` sur la source vivante) :

| Table | Lignes | Détail |
|---|---|---|
| boards | 4 | mémos libres : lalala r6 (3 obj.), test r2 (2), rrgh r7 (7), « Mémo du 11 sept. · 10:12 » r26 (33) |
| objects | 45 | |
| conversations | 3 | 6, 589 et 1 426 messages |
| messages | 2 021 | 2026-09-06 → 2026-09-15 |
| projects | 24 | 12 Codex disponibles, 11 Codex indisponibles, 1 manuel |
| proposals | 1 | en attente, `localhistory/docs/ACTIVITY_ANALYSIS.md` |
| events / history / operations | 47 / 41 / 41 | |
| devices | 1 | NoteAir5C |
| drafts, recordings, document_operations, pen_jobs | 0 | |

Dernier usage réel : 2026-09-15. Depuis, le service ne fait que redémarrer.

Déjà migré le 2026-09-16 : projet `~/Documents/Context Room/Recuperation Lisiere`
(4 carnets aux révisions 6, 7, 2, 26 = actuelles ; la proposition en attente en
copie de travail), 3 historiques dans `~/.context-room/assistant/legacy-history`.

## (c) Plan de bascule

Ordre strict. Chaque étape a un contrôle. On ne passe pas à la suivante sans lui.
Corrigé le 2026-10-23 d'après L1 (essai synthétique) et la revue L2L7. Sauf
mention, Claude lance les commandes ; les gestes sur la BOOX sont ceux du guide.
`B=~/Backups/lisiere-2026-10` est le dossier durable de la bascule ; `U=$(id -u)`.

```
 1 sauvegarde ─▶ 2 export BOOX ─▶ 3 export Mac ─▶ 4 import + comptes
      ─▶ 5 aperçu cutover ─▶ 6 --apply ─▶ 7 contrôles (+ 7 bis) ─▶ 8 arrêt updates
      ─▶ 9 usage 1 semaine ─▶ 10 retrait des exécutables (+ guide F)
```

1. **Sauvegarde** : `python3 -B scripts/lisiere-backup.py --output "$B/lisiere-backup-<date>"` (dossier neuf).
   Le script refuse un dossier qui existe déjà et n'écrit que là (mode 0700).
   Il fait : comptes en lecture seule, copie SQLite cohérente (le tar d'une base
   WAL vivante ne l'est pas), `.tgz` de `~/.local/share/lisiere` (sans `models/`,
   547 Mo : nom, taille et sha256 notés) et de `~/Documents/Lisière`, les deux
   plists, le lien `~/.local/bin/lisiere` et sa cible, `SHA256SUMS`, copie
   séparée de `development.keystore`. Il extrait l'archive dans un dossier
   temporaire et compare les sommes. Contrôle : **seul `manifest.json`, écrit en
   dernier, prouve une sauvegarde complète** ; un échec laisse un dossier partiel
   sans lui : recommencer dans un nouveau dossier. Les plists et le lien servent
   au retour arrière après l'étape 10. Mettre une 2ᵉ copie hors du disque du Mac.
2. **Export tablette** : suivre le guide A-F de
   [`docs/system/lisiere-migration.md`](system/lisiere-migration.md)
   (§ « BOOX session guide »). Le guide donne la chaîne de livraison
   (`scripts/build-android-recovery.sh` sur `ci`, signature sur le Mac, serveur
   temporaire 8796), l'export du ZIP natif (B-D), puis, après le contrôle de
   deux copies, `migrate --export-lisiere <zip> --output <snap>` (aperçu, puis
   `--apply --revision`) et `--reconcile-lisiere` **en aperçu seulement**
   (il exige `--mac-snapshot`, `--legacy-board`, `--legacy-actor`). Contrôle :
   comptes cache / outbox / PCM notés ; le nombre d'enregistrements égale celui
   des `recordings/*.pcm` du ZIP. **À la séance BOOX, avec Mathis** (installation
   sur sa BOOX). Le fichier d'appairage (L9b-2) doit exister avant l'étape E.
3. **Export Mac** : `migrate --export-lisiere ~/.local/share/lisiere/workspace --output $B/snapshots/mac`
   (aperçu), puis `--apply --revision <R>`. Le snapshot est lié au journal de
   bascule : jamais dans `/private/tmp` (vidé au redémarrage). Contrôle : mêmes
   comptes que (b).
4. **Import / contrôle** : `--inspect-lisiere <snap> --kind all` ; comparer aux
   imports du 2026-09-16 (révisions 6, 7, 2, 26). Importer seulement ce qui est
   nouveau (`--import-lisiere`, `--legacy-conversation`, `--legacy-recording`).
5. **Aperçu de bascule** : le projet de `--root` doit être enregistré dans le
   Hub réel (`project list`). Refaire l'export juste avant si
   `workspace.sqlite` a changé. Puis :
   `migrate --root <projet> --cutover-lisiere ~/.local/share/lisiere/workspace --mac-snapshot <snap> --legacy-plist ~/Library/LaunchAgents/fr.lisiere.companion.plist`.
   Il refuse si la source a changé depuis l'export.
6. **Application** : même commande avec `--apply --revision <révision de l'aperçu>`.
   Effet : pause des écritures CR, `launchctl disable` + `bootout` du compagnon
   (attente jusqu'à 10 s que le processus sorte), contrôle `lsof` (aucun
   fichier ouvert), déplacement atomique du dossier `workspace` vers la
   rétention `~/.local/share/lisiere/workspace.context-room-retired-<16 hex de R>`,
   barrière à la place de `workspace.sqlite`. Si le service écrit pendant
   l'arrêt, l'apply refuse et garde la source : refaire l'export et l'aperçu.
7. **Contrôles après** : `launchctl list | grep fr.lisiere.companion` vide ;
   `launchctl print-disabled gui/$U | grep fr.lisiere.companion` affiche
   `=> disabled` ; rétention présente, taille = avant ; Hub : 4 carnets ouverts,
   conversations visibles, changement de projet ≤ 300 ms, tout retrouvé après
   redémarrage du Hub.
   **7 bis** : `python3 -B scripts/lisiere-backup.py --output <autre dossier neuf> --source-retained <rétention>`
   sauvegarde la rétention, service arrêté, et la compare en entier.
8. **Arrêt des mises à jour** (le cutover ne gère que le compagnon) :
   `launchctl disable gui/$U/fr.lisiere.updates` puis
   `launchctl bootout gui/$U/fr.lisiere.updates`. Le `bootout` seul ne dure
   pas : `RunAtLoad` relance le service à la prochaine connexion. Contrôles :
   `launchctl print-disabled gui/$U | grep fr.lisiere.updates` affiche
   `=> disabled` ; `lsof -nP -iTCP:8765 -sTCP:LISTEN` est vide.
9. **Usage réel** : Mathis confirme l'usage quotidien (porte du contrat). Avant,
   étape E du guide : installer Context Room sur la BOOX.
10. **Retrait des exécutables** : retirer ce qui peut relancer Lisière, jamais les
    données. Déplacer (`mv`, pas `rm`) vers `$B/retired-executables/` :
    `~/Library/LaunchAgents/fr.lisiere.companion.plist`, `fr.lisiere.updates.plist`,
    `~/.local/bin/lisiere` (lien), `~/.local/share/lisiere/update-service.py`,
    `~/Documents/projects/lisiere/.venv`. Garder en place : `signing/`, `backups/`,
    rétention, barrière, `updates/`, `models/`, `~/Documents/Lisière`. Ne pas
    faire `launchctl enable` sur ces libellés. Critère final :
    `launchctl list | grep -c 'fr\.lisiere\.'` = 0 ; ports 8765, 8767, 8768
    fermés ; `launchctl print gui/$U/fr.lisiere.companion` et `.../fr.lisiere.updates`
    répondent « Could not find ». **Désinstaller `fr.lisiere.android` de la BOOX
    (étape F du guide) seulement après l'étape 9**, quand deux copies du ZIP
    sont vérifiées et l'import contrôlé. Pas avant.

**Migration réelle des 4 carnets.** Les 4 mémos sont dans le projet
« Recuperation Lisiere ». Ils passent dans l'espace Notebooks avec
`migrate --notebooks-to-space`, **sans `--legacy-board`**. Cette action écrit
dans `~/.context-room` : **Mathis a dit oui le 2026-10-23** pour ces quatre
gestes, à la séance BOOX, **après** le déploiement de `23facfc` (étape 0). Le
Hub reste arrêté de l'étape 3 à l'étape 8. `<release>` = le dossier de la nouvelle release ;
`cr() { "$HOME/.local/bin/node" "<release>/runtime/bin/context-room.mjs" "$@"; }`
(une fonction : zsh ne coupe pas une variable en mots ; la CLI n'est pas dans
le `PATH`, et seule la nouvelle release a `backup`).
Ordre strict (relu par Opus le 2026-10-25) :

0. **Début de séance : déployer `23facfc`.** Rien de T-021 n'est dans
   `bbfef3d` : `backup`, `migrate --notebooks-to-space`, `--export-lisiere`,
   `--import-lisiere` et l'APK final ont besoin de `23facfc`. Il faut donc
   préparer la release (étape 2) **avant** les étapes 2 à 6 du plan (c) et
   avant l'appairage sur le port 4318. Le Hub tourne encore à ce stade.
1. **Sauvegarde Lisière, en premier.**
   `python3 -B scripts/lisiere-backup.py --output "$B/lisiere-backup-<date>"`.
   Contrôle : `manifest.json` et `development.keystore` présents (sha
   `e6681a8d…`). `$B/keys` ne contient que `tablet.keystore` : cette clé Lisière
   n'a qu'une copie. Faire une copie de `$B` hors du Mac.
2. **Préparer, sans effet sur les données (Hub encore en marche).**
   `REL=~/.local/share/context-room/releases/23facfc-p4319`. Installer les
   fichiers : `scripts/prepare-mac-install.mjs --output "$REL" --port 4319 …`
   (aperçu, puis `--apply --revision <R>` ; voir
   `docs/system/runtime-profiles.md`). Le dossier parent de `--output` doit
   exister (`mkdir -p`). Puis les dépendances :
   `(cd "$REL/runtime" && PATH="$HOME/.local/bin:$PATH" npm ci --omit=dev --ignore-scripts --no-audit --no-fund)`.
   Contrôle : `cr --version` = 0.6.17. Ne pas copier `node_modules` de la
   release précédente : `package-lock.json` a changé depuis `bbfef3d`
   (dompurify, fast-uri). **Ne pas changer `RUNTIME`.** Pas `deploy-main.sh` :
   il relance le Hub.
3. **Geste 1, arrêter le Hub.** Noter le plist :
   `launchctl print gui/$U/app.contextroom.local | grep 'path ='`
   (attendu : `$HOME/Library/LaunchAgents/app.contextroom.local.plist`). Puis
   `launchctl bootout gui/$U/app.contextroom.local` (un `kill` le relancerait,
   `KeepAlive`). **Contrôle d'arrêt, les trois à la fois :**
   1. `launchctl print gui/$U/app.contextroom.local` répond « Could not find » ;
   2. `lsof -nP -iTCP:4319 -iTCP:4318 -sTCP:LISTEN` ne rend rien (ports libres) ;
   3. `pgrep -f 'runtime/bin/context-room.mjs hub'` ne rend rien.

   `launchctl print` seul ne suffit pas : au `bootout`, le lanceur arrête son
   enfant Node avec 15 s d'attente, le plist n'a pas d'`ExitTimeOut`, et
   launchd tue le lanceur après 20 s. L'enfant peut survivre et garder les
   ports (cas vu avec `bbfef3d`). Aucune commande `backup` ni `migrate` ne
   refuse un Hub vivant (seul `restore` le fait). S'il reste un processus
   `hub` : `kill -TERM <pid>`, attendre, refaire les trois contrôles.
   Puis vérifier le dossier de travail du plist :
   `ls -d "$(plutil -extract WorkingDirectory raw <plist>)"`. S'il manque (une
   ancienne release supprimée), launchd ne peut plus lancer le Hub : il échoue
   toutes les 30 s (`last exit code = 78: EX_CONFIG`) sans rien écrire au
   journal. Le corriger avant toute relance, retour arrière compris :
   `cp <plist> "$B/app.contextroom.local.plist.before-<date>"`, puis
   `plutil -replace WorkingDirectory -string "$HOME/.local/share/context-room" <plist>`
   et `plutil -lint <plist>`. Sans effet sur le Hub : le lanceur fixe lui-même
   le dossier du processus Node (`cwd=RUNTIME`).
4. **Copie brute, Hub arrêté, avant le premier démarrage de `23facfc`.**
   `cr backup` ne couvre que le registre, les revues, les conversations, les
   enregistrements et les carnets. Il ne couvre ni `shared`, ni `operations`,
   ni `snapshot*`, ni les `.context-room/config.json` des projets. Or le Hub
   `23facfc` réécrit ces fichiers à son premier démarrage. Copier :
   `mkdir -p "$B/raw-before-23facfc"`, puis
   `(cd ~/.context-room && cp -Rp hub shared preferences.json operations backups logs context-snapshots "$B/raw-before-23facfc/")`
   (sans `assistant`, 550 Mo de modèles), puis le `.context-room/config.json`
   de **chaque** projet du registre (6, dont le projet lié à Shared), en
   gardant le chemin relatif de chaque projet, puis les données Lisière
   (`~/.local/share/lisiere`, `development.keystore` compris). Contrôle :
   `ls` et `shasum` du keystore copié. Cette copie sert au retour à `bbfef3d`
   sur les 6 projets, pas seulement sur 3.
5. **Geste 2, sauvegarde.** `cr backup --plan --output "$B/context-room-backup-<date>"`
   (compte, n'écrit rien). Contrôle : `warnings` ne nomme pas
   « Recuperation Lisiere », et les 41 fichiers de `notebooks/v1` de ce projet
   figurent dans le plan. Puis `cr backup --output "$B/context-room-backup-<date>"`.
   Le dossier ne doit pas exister. Contrôle : `manifest.json` présent.
6. **Geste 3, changer `RUNTIME`** dans
   `~/.local/share/context-room/launch-installed.py` vers `$REL`, après
   `cp launch-installed.py launch-installed.before-23facfc.py`. Contrôles :
   `grep -n '^RUNTIME' launch-installed.py` et
   `python3 -I -m py_compile launch-installed.py`. Le Hub reste arrêté.
7. **Geste 4, migrer.** `cr migrate --root "<projet>" --notebooks-to-space`
   (aperçu : `space: "will-be-created"`, 4 carnets dans `notebooks`, `refused`
   vide), puis la même commande avec `--apply --revision <R>`. **Noter les 4
   `from`** (`Carnets/<uuid>.crnb`) : ils servent au retour. L'apply crée
   l'espace (`~/Documents/Context Room/Carnets`) puis déplace. Après un crash :
   attendre 30 s (verrou), puis relancer ; si la réponse dit « Preview again »,
   refaire l'aperçu.
8. **Relancer le Hub** : `launchctl bootstrap gui/$U <plist noté à l'étape 3>`.
   En 20 s au plus : le port 4319 répond, le port 4318 écoute (si le réseau
   local est là), les 6 projets et l'espace Notebooks sont `available`, et les
   4 carnets sont dans l'espace Notebooks.

Retour arrière de ces gestes :
- Geste 1 ou préparation : `launchctl bootstrap gui/$U <plist>` ; la release
  préparée reste sur le disque sans effet.
- Copie brute et geste 2 : rien à défaire (dossiers neufs, à garder).
- Geste 3 : remettre `launch-installed.before-23facfc.py` à la place de
  `launch-installed.py`, puis `launchctl bootstrap`. Seulement après avoir
  défait le geste 4.
- Geste 4 : revenir à `bbfef3d` ne remet **pas** les carnets (sources dans
  `retired/`, marqueur `moved`), et `restore` non plus. Avec la nouvelle
  release, Hub lancé : **Move to project…** sur chaque carnet, vers
  « Recuperation Lisiere » (déplacement vérifié, L3). Seulement ensuite,
  revenir à `bbfef3d` comme au geste 3.
  - **Chemin du fichier (D1).** Le dialogue propose `docs/<titre>.crnb` : le
    projet « Recuperation Lisiere » le refuse (« The destination folder is not
    authorized for notebooks »), il n'autorise que `Carnets/`. Taper le chemin
    **d'origine** `Carnets/<uuid>.crnb` (le `from` noté à l'étape 7), pas un nom
    libre : l'état reste exact. Les accents du titre ne sont pas retirés par
    le Hub ; seul le script d'essai le faisait. Correctif de code à faire après
    la séance : proposer le premier chemin autorisé du projet cible.
  - **Sans Hub sous launchd.** Il n'existe pas de commande CLI pour déplacer un
    carnet (seulement l'API du Hub). Si le Hub `23facfc` ne démarre pas sous
    launchd, lancer à la main le Hub de la nouvelle release sur le port 4399 :
    `(cd "$B" && nohup "$HOME/.local/bin/node" "$REL/runtime/bin/context-room.mjs" hub --no-local --port 4399 > hub-4399.log 2>&1 &)`,
    ouvrir `http://127.0.0.1:4399`, faire « Move to project… » ×4, puis
    l'arrêter (`pkill -TERM -f 'hub --no-local --port 4399'`).
  - Vu dans le code de `bbfef3d` : l'ancien Hub lit un registre qui contient
    l'espace sans erreur ; il le montre comme un projet ordinaire
    « Notebooks » et efface le champ `space` à sa prochaine écriture du
    registre. Au retour à la nouvelle release, `registerContextHubProject`
    remet `space` sur l'entrée existante, et Hub › New notebook le reconnaît
    de nouveau (dossier déjà configuré).

**Retour arrière.**
- Avant l'étape 6 : rien à défaire.
- Après l'étape 6 : `--rollback-cutover` ne fait **que** mettre CR en pause ; il
  ne relance pas Lisière :
  `migrate --root <projet> --rollback-cutover`, puis `--apply --revision <R>`.
  Retour fonctionnel à Lisière, à la main :
  1. `python3 -B src/exclusive_rename.py ~/.local/share/lisiere/workspace ~/.local/share/lisiere/workspace.context-room-fence-<16 hex>`
     (met la barrière de côté) ;
  2. `python3 -B src/exclusive_rename.py ~/.local/share/lisiere/workspace.context-room-retired-<16 hex> ~/.local/share/lisiere/workspace`
     (remet les données) ;
  3. `launchctl enable gui/$U/fr.lisiere.companion` puis
     `launchctl bootstrap gui/$U ~/Library/LaunchAgents/fr.lisiere.companion.plist`.
     Après l'étape 10, remettre d'abord le plist, le lien et le venv depuis
     `$B/retired-executables/`.
- **Revenir à Context Room après ce retour.** `--resume-cutover` refuse si
  Lisière tourne encore. Arrêter Lisière à la main (le CLI n'a pas de `stop`) :

  ```
  U=$(id -u)
  launchctl disable gui/$U/fr.lisiere.companion
  launchctl print gui/$U/fr.lisiere.companion    # si le service est chargé :
  launchctl bootout gui/$U/fr.lisiere.companion
  launchctl print-disabled gui/$U | grep fr.lisiere.companion   # attendu : => disabled
  ps -axo pid=,command= | grep '[l]isiere.server'              # attendu : vide
  python3 -B src/mac_legacy_quiescence.py verify --source ~/.local/share/lisiere/workspace --plist ~/Library/LaunchAgents/fr.lisiere.companion.plist
  ```

  Puis remettre les dossiers comme à l'étape 6 : `workspace` → rétention, barrière
  → `workspace` (les renommages 2 et 1 à l'envers, avec `exclusive_rename.py`).
  Si la rétention contient du travail plus récent que la dernière révision connue,
  l'exporter (`--export-lisiere <rétention> --output <nouveau snapshot>`), importer
  ce travail, puis `migrate --root <projet> --resume-cutover --mac-snapshot <nouveau snapshot>`
  et `--apply --revision <R>`. Sans travail nouveau, `--mac-snapshot` n'est pas utile.
- Risque restant : sur le vrai service, `launchctl`, `lsof` et `renamex_np` n'ont
  jamais tourné (l'essai L1 est synthétique : agent `test.contextroom.synthetic-*`).
  Sept réglages `test.contextroom.synthetic-* => enabled` restent dans
  `launchctl print-disabled gui/$U` : sans effet, seul root les retire.

### Essai à blanc fait (2026-10-15)

Avec `CONTEXT_ROOM_HUB_HOME`, `CONTEXT_ROOM_SHARED_HOME` et
`CONTEXT_ROOM_ASSISTANT_HOME` dans `/private/tmp/t021-Vym2` :

- export d'une copie : aperçu puis `--apply` OK, comptes identiques à (b) ;
  `--inspect-lisiere` : 4 carnets, 3 conversations, 24 projets, 0 brouillon,
  0 enregistrement ;
- export de la source vivante (SQLite ouvert en `mode=ro`) : aperçu + apply
  vers `/private/tmp` OK, révision `b22a8bf4…` ; taille et date de
  `workspace.sqlite` inchangées ;
- aperçu `--cutover-lisiere` sur un projet temporaire : **ok**, service reconnu
  (`fr.lisiere.companion`, uid 501), effet `retire-original-workspace-and-enable-context-room-only`,
  retour `pause-writes-retain-all-data-no-legacy-restart`. Pas de `--apply`.
- `~/.context-room` inchangé ; `launchctl list` montre toujours les 3 services.
- Note : la date du dossier `workspace/` avance seule (le service vivant y
  touche) ; ce n'est pas l'essai.

## (d) Manques à coder

État au 2026-10-24, branche `mathis/t021-lisiere-parite`. Minimum pour couper
Lisière : **L1 + L2 + L3**. Pour que Mathis ne perde aucun usage : L4 et L5 en
plus.

| Lot | Contenu | État | Bloque la bascule ? |
|---|---|---|---|
| L1 Essai synthétique de l'adaptateur | `mac_legacy_quiescence.py` + `exclusive_rename.py` sur un faux LaunchAgent `fr.lisiere.companion` dans un HOME de test (ou VM/compte de test) | **fusionné** (ab443b4, 284df00) ; jamais appliqué au vrai service | **oui** |
| L2 Export tablette | Essai réel APK recovery → ZIP → reconcile ; doc pas à pas | **à faire** à la séance BOOX, avec Mathis ; chaîne APK prête (L2L7, 82d62fc) | **oui** |
| L3 Espace « Carnets » libre (**décidé par Mathis le 2026-10-16**) | Voir § Décision ci-dessous | **fusionné** (2fcc861, f88ab76, 11e38aa) ; reste l'essai BOOX et la migration des 4 carnets (séance BOOX) | **oui** (usage attendu) |
| L4 Lecteur PDF / image | Rendu PDF paginé (pdf.js local), zoom, « image entière » mémorisée, annotation en carnet | **fusionné** (7f178e6) ; essai BOOX à faire | non |
| L5 Projets et tâches Codex | Import du catalogue Codex Desktop dans le registre (aperçu + oui) ; liste en lecture seule des sessions Codex du Mac | **fusionné** (bfe4211, f78968d) | non |
| L6 Réseau tablette | mDNS/Bonjour pour retrouver le Mac ; diagnostic réseau (LAN/Tailscale) dans `doctor` | **fusionné** (f74c994, f88ab76, c597d6b) ; redécouverte à essayer sur la BOOX | non |
| L7 Mise à jour APK | Distribution d'APK signée par le Hub + vérification + installation depuis l'app | chaîne APK **fusionnée** (L2L7, 82d62fc) ; pas d'installateur dans l'app : écart accepté (Mathis, 2026-10-23) | non (PWA suffit) |
| L8 Sauvegarde | `context-room backup/restore` des carnets, conversations et reçus | **fusionné** (219c815, 91d3995) | non |
| L9a Confort de lecture | Sommaire paginé, Aa, recherche sans accents, chercher/remplacer, annuler/rétablir | **fusionné** (40285c8 ; r2 9db43b2) ; essai BOOX à faire | non |
| L9b Confort de travail | Fast, « Suivre l'agent », QR et fichier d'appairage, export PNG/PDF d'un carnet | **fusionné** (c597d6b, 3c88c15, c03b208) ; aucun vrai tour Fast avant le 2026-11-17 | non |

### Décision 2026-10-16 : espace « Carnets » libre (L3)

Statut : **fait** (L3, 2026-10-23), sauf l'essai sur la BOOX et la migration
réelle des 4 mémos (oui de Mathis le 2026-10-23, à la séance BOOX : voir § (c),
« Migration réelle des 4 carnets »). Écarts avec la proposition : l'espace est
une entrée marquée du registre ; ses carnets sont sous `Carnets/` ; libellés
en anglais (Notebooks, New notebook, Move to project…).

Mathis veut un espace « Carnets » libre, hors de tout projet, comme les mémos
libres de Lisière. Proposition de conception (validée au début de L3) :

- Un dossier dédié, par défaut `~/Documents/Context Room/Carnets`, enregistré
  une fois dans le Hub comme espace spécial (pas un projet de code : pas de
  Git, pas de contexte d'agent, pas de Shared).
- Le Hub et la tablette montrent « Carnets » en tête de la navigation, avant
  les projets. Bouton **Nouveau carnet** toujours visible, sans choisir de
  projet.
- Action **Déplacer vers un projet** (copie vérifiée, puis retrait de
  l'original), et l'inverse.
- Le format reste `.crnb` : l'éditeur, le cache hors ligne et la dictée
  marchent sans changement.
- Migration : les 4 mémos du projet « Recuperation Lisiere » passent dans
  « Carnets » (aperçu puis oui). Les futurs imports `--import-lisiere` de
  mémos sans projet visent « Carnets » par défaut.
- Tests : unitaire (création, déplacement aller-retour, refus d'écraser) et
  e2e (nouveau carnet sans projet, retrouvé après redémarrage du Hub).

```
 Hub ─┬─ Carnets (libre)  ── lalala, test, rrgh, Mémo du 11 sept., + nouveaux
      ├─ Projet A         ── docs, carnets du projet
      └─ Projet B
            ▲   Déplacer vers un projet / vers Carnets   │
            └────────────────────────────────────────────┘
```
