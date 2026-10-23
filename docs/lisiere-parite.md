# Parité Lisière → Context Room (T-021, lot 1)

Date : 2026-10-15. Base : `bbfef3d` (release déployée `bbfef3d-p4319`).
Auteur : Claude (T-021). Rien n'a été arrêté, supprimé ni écrit dans les
données Lisière ou dans `~/.context-room`.

## En bref

- La v2 reprend le cœur de Lisière : carnets, conversations par source, dictée,
  voix, appairage, vues partagées, présentation, cache hors ligne, migration.
- Elle **ne reprend pas** tout. Manques nets : lecteur PDF/image, catalogue des
  projets Codex Desktop, liste des anciennes tâches Codex du Mac, découverte
  Bonjour, service de mise à jour APK, mémos libres hors projet, sauvegarde
  simple, export `.lisiere` (aperçu PNG / PDF).
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
code. « BOOX réelle » : la porte V18 (essai physique) n'est pas encore passée.

### Tablette, lecture et édition

| Fonction Lisière | Équivalent Context Room | Statut |
|---|---|---|
| Appairage QR / code 10 min, page HTML `lisiere pair --output` | Code 2 min, identifiant 30 j, épingle du certificat (`src/device_authority.mjs`, `src/device_owner.mjs`) ; `test/devices.test.mjs`, `test/device_owner.test.mjs`, `test/e2e/notebooks.spec.mjs:41,166`. Pas de QR, pas de page HTML hors ligne. | partiel |
| Rôles propriétaire / dessin seul, révocation | `src/device_owner.mjs` ; `test/e2e/notebooks.spec.mjs:166` | prouvé |
| Parcourir : Projets / Fichiers / Carnets / Récents | Navigation Hub + documents (`src/ui/app.mjs`, `src/device_navigation.mjs`) ; e2e Hub | prouvé |
| Lecteur HTML (ressources locales, liens externes) | Docs rendues + `src/document_assets.mjs` | prouvé |
| « Lire le texte » paginé, Sommaire > 300 sections, recherche sans accents, Aa | Mode focus (`src/ui/app.mjs`), recherche docs. Pas de sommaire paginé dédié ni réglage Aa vérifiés sur encre. | partiel |
| Modifier HTML/MD → diff → « Appliquer sur le Mac » | Brouillon + proposition locale + revue humaine (`src/local_proposals.mjs`, `docs/features/document-workflow.md`) | prouvé |
| Gros éditeur (annuler/rétablir, chercher/remplacer, 20 Mio) | Éditeur de documents ; pas de chercher/remplacer dans l'UI trouvé | partiel |
| Lecteur PDF et image (pages, zoom, « Image entière », Annoter) | PDF servi en octets seulement (`src/document_assets.mjs:13`, « no integrated renderer promised ») ; annotation PNG de revue (`test/e2e/notebooks.spec.mjs:499`) | **absent** (PDF) / partiel (image) |
| Carnets stylet/doigt, zoom 2 doigts, gomme, sélection, formes | `.crnb` (`src/notebook_*.mjs`, `src/ui/notebook-*.mjs`, `android/.../InkView.java`, `BooxInk.java`) ; `test/notebook*.test.mjs`, `test/e2e/notebooks.spec.mjs:216,372,484` | prouvé (navigateur) ; partiel (BOOX réelle) |
| Mémos libres hors projet (`~/Documents/Lisière/Carnets`) | Espace Notebooks (`~/Documents/Context Room/Carnets`), New notebook, déplacement vérifié vers un projet et retour (`test/notebooks.test.mjs` transfer, `test/hub_durable_identity.test.mjs` space, e2e « Notebooks space »). Les 4 mémos passent par `migrate --notebooks-to-space` à la bascule. | prouvé (navigateur) ; partiel (BOOX réelle) |
| Accueil « reprendre / Nouveau mémo » | Section Notebooks en tête de l'accueil du Hub : New notebook, Resume sur le plus récent, retrouvé après redémarrage du Hub (e2e « Notebooks space ») | prouvé (navigateur) ; partiel (BOOX réelle) |
| Cache hors ligne + file d'opérations à ID stables, conflit → copie | `test/e2e/notebooks.spec.mjs:261,283,318,358` | prouvé |
| Persistance des décisions Appliquer/Refuser, reprise | Reçus signés + annulation (`docs/features/review-authority.md`) | prouvé |

### Agent, conversations, voix

| Fonction Lisière | Équivalent Context Room | Statut |
|---|---|---|
| Discussions par projet, historique | Conversations par source (`src/assistant_*.mjs`, `docs/features/conversations.md`) ; `test/assistant_*.test.mjs`, `test/e2e/assistant.spec.mjs` | prouvé |
| Codex limité à la sélection, modes « Sélection seule / et ajouts » | Outils liés au fichier ou carnet d'origine (`src/codex_provider.mjs`), « Annotate passage » | prouvé |
| Choix du modèle, raisonnement, Fast | Catalogue après connexion explicite ; `reasoningEffort` (`src/ui/assistant.mjs:245`). Fast non trouvé. | partiel |
| Dicter (Whisper local) | `src/local_audio*.mjs`, whisper-cli ; `test/e2e/assistant-voice.spec.mjs` | prouvé |
| Voix temps réel (WebRTC) | Voice avec VAD Silero (local, pas WebRTC) ; `test/e2e/assistant-voice.spec.mjs` | prouvé (autre technique) |
| `voice.say` (lecture de réponse) | « Read answer » via `/usr/bin/say` (`src/local_audio.mjs:68`) | prouvé |
| Dessin à la voix avec vue en direct, « Suivre Codex » | Suivi de vue / partage de vue (`docs/system/connected-devices.md:112`) ; pas de vue guidée par l'agent | partiel |
| Micro Android du propriétaire, dictée récupérée | `NativeAudio.java`, « Recover dictation », `test/e2e/recovery-recordings.spec.mjs` | partiel (BOOX réelle) |
| « Afficher cette discussion sur le Mac » (`agent.open`) | « Open on device » (sens inverse) ; tâche d'origine reste dans Codex | partiel |
| Tâches du Mac : lire les sessions Codex (`agent.sessions`) | Rien | **absent** |
| Catalogue des projets Codex Desktop (`integrations.json codexProjects`) | Registre Hub manuel (`project register`) | **absent** |
| Dictée via tâche Codex éphémère | Remplacée par Whisper local (décision v2 : aucun appel de modèle par CR) | non repris (voulu) |

### Mac, présentation, réseau, mise à jour

| Fonction Lisière | Équivalent Context Room | Statut |
|---|---|---|
| « Présenter sur le Mac » (`lisiere present`, ≤ 4 i/s) | Presentation dans l'éditeur commun + partage de vue (`src/device_views.mjs`, `test/device_display.test.mjs`, `test/e2e/notebooks.spec.mjs:72`) | prouvé |
| `lisiere open`, `doctor`, `capabilities` | `context-room open`, `doctor` (CLI `bin/context-room.mjs`) | prouvé |
| `lisiere network` (état Tailscale), `lisiere desktop UUID` | Rien | **absent** |
| Redécouverte Bonjour `_lisiere._tcp` | Adresse LAN fixe + `--device-browser-origin https://macbook-pro.local:4320` ; pas de mDNS | **absent** |
| Service APK `fr.lisiere.updates` (8765) + mise à jour dans l'app | PWA mise à jour par service worker (`docs/system/connected-devices.md`) ; APK construit par `scripts/build-android*.sh`, sans distribution ni installation dans l'app | partiel |
| Clé de signature `development.keystore` | Reprise par `scripts/build-android-recovery.sh` (identité `fr.lisiere.android`) | prouvé (M07, `eadc14c`) |
| `lisiere backup` / `restore` (tar.gz) | Rien de dédié pour les carnets/conversations ; Git du projet | **absent** |
| Stockage `Titre--id.lisiere` (tableau.json, apercu.png, dessin.pdf, README) | `.crnb` dans le projet ; pas d'aperçu PNG ni de PDF exporté | partiel |
| `lisiere projects add/list`, `rpc …` | `project register`, API Hub | prouvé |
| Désinstallation qui garde les données (`uninstall-companion.sh`) | `--cutover-lisiere` garde tout dans une rétention privée | partiel (jamais appliqué au vrai service) |

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

```
 1 sauvegarde ─▶ 2 export BOOX ─▶ 3 export Mac ─▶ 4 import + comptes
      ─▶ 5 aperçu cutover ─▶ 6 --apply ─▶ 7 contrôles après ─▶ 8 arrêt updates
      ─▶ 9 usage 1 semaine ─▶ 10 désinstallation
```

1. **Sauvegarde** (hors des dossiers d'origine, ex. `~/Backups/lisiere-2026-10-xx/`) :
   `tar czf` de `~/.local/share/lisiere` et de `~/Documents/Lisière`, plus une
   copie séparée de `signing/development.keystore`. Contrôle : `tar tzf | wc -l`
   et `shasum` du keystore.
2. **Export tablette** : installer l'APK de récupération (`scripts/build-android-recovery.sh`,
   même identité et même clé, mise à jour sans perte), exporter le ZIP natif
   (cache, outbox, PCM), puis `migrate --export-lisiere <zip>` et
   `--reconcile-lisiere`. Contrôle : comptes cache/outbox/PCM notés. **Besoin
   d'un oui de Mathis** (installation sur sa BOOX).
3. **Export Mac** : `migrate --export-lisiere ~/.local/share/lisiere/workspace --output <snap>`
   (aperçu), puis `--apply --revision <R>`. Contrôle : mêmes comptes que (b).
4. **Import / contrôle** : `--inspect-lisiere <snap> --kind all` ; comparer aux
   imports du 2026-09-16 (révisions 6, 7, 2, 26). Importer seulement ce qui est
   nouveau (`--import-lisiere`, `--legacy-conversation`, `--legacy-recording`).
5. **Aperçu de bascule** : depuis le projet cible,
   `migrate --root <projet> --cutover-lisiere ~/.local/share/lisiere/workspace --mac-snapshot <snap> --legacy-plist ~/Library/LaunchAgents/fr.lisiere.companion.plist`.
   Il refuse si la source a changé depuis l'export.
6. **Application** : même commande avec `--apply --revision <révision de l'aperçu>`.
   Effet : pause des écritures CR, `launchctl disable` + `bootout` du compagnon,
   contrôle `lsof` (aucun fichier ouvert), déplacement atomique du dossier
   `workspace` vers une rétention privée voisine, barrière à la place de
   `workspace.sqlite`.
7. **Contrôles après** : `launchctl list | grep fr.lisiere.companion` vide ;
   `launchctl print-disabled gui/$(id -u)` le montre désactivé ; rétention
   présente, taille = avant ; Hub : 4 carnets ouverts, conversations visibles,
   changement de projet ≤ 300 ms, tout retrouvé après redémarrage du Hub.
8. **Arrêt des mises à jour** : `launchctl bootout gui/$(id -u)/fr.lisiere.updates`
   (le cutover ne gère que le compagnon). Contrôle : port 8765 fermé.
9. **Usage réel** : Mathis confirme l'usage quotidien (porte du contrat).
10. **Désinstallation** : retirer les deux plists de `~/Library/LaunchAgents`,
    le venv et `update-service.py` ; garder sauvegarde, rétention et keystore.
    Désinstaller `fr.lisiere.android` seulement après l'étape 2 réussie.

**Retour arrière.**
- Avant l'étape 6 : rien à défaire.
- Après l'étape 6 : `--rollback-cutover` ne fait **que** mettre CR en pause ; il
  ne relance pas Lisière. Retour fonctionnel manuel : remettre le dossier de
  rétention à sa place (ou restaurer le tar), `launchctl enable` puis
  `launchctl bootstrap gui/$(id -u) <plist>`. Ensuite `--resume-cutover` pour
  rouvrir les écritures CR.
- Risque connu : `launchctl`, `lsof` et `renamex_np` n'ont jamais tourné sur
  le vrai service (RELAIS-CODEX-LOCAL.md §5 demande un essai sur un compte et
  un service synthétiques d'abord).

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

Estimations pour un agent Sonnet, tests compris. Ordre conseillé.

| Lot | Contenu | Estim. | Bloque la bascule ? |
|---|---|---|---|
| L1 Essai synthétique de l'adaptateur | `mac_legacy_quiescence.py` + `exclusive_rename.py` sur un faux LaunchAgent `fr.lisiere.companion` dans un HOME de test (ou VM/compte de test) | 0,5 j | **oui** |
| L2 Export tablette | Essai réel APK recovery → ZIP → reconcile ; doc pas à pas | 0,5 j + BOOX | **oui** |
| L3 Espace « Carnets » libre (**décidé par Mathis le 2026-10-16**) | Voir § Décision ci-dessous | 1–1,5 j | **oui** (usage attendu) |
| L4 Lecteur PDF / image | Rendu PDF paginé (pdf.js local), zoom, « image entière » mémorisée, annotation en carnet | 2 j | non |
| L5 Projets et tâches Codex | Import du catalogue Codex Desktop dans le registre (aperçu + oui) ; liste en lecture seule des sessions Codex du Mac | 1,5 j | non |
| L6 Réseau tablette | mDNS/Bonjour pour retrouver le Mac ; diagnostic réseau (LAN/Tailscale) dans `doctor` | 1 j | non |
| L7 Mise à jour APK | Distribution d'APK signée par le Hub + vérification + installation depuis l'app | 1,5 j | non (PWA suffit) |
| L8 Sauvegarde | `context-room backup/restore` des carnets, conversations et reçus | 1 j | non |
| L9 Confort lecture/édition | Sommaire paginé, Aa, chercher/remplacer, Fast, « Suivre l'agent », QR d'appairage, export PNG/PDF d'un carnet | 2 j | non |

Total : ~11 j. Minimum pour couper Lisière : **L1 + L2 + L3** (~2,5 j +
BOOX). Pour que Mathis ne perde aucun usage : L4 et L5 en plus.

### Décision 2026-10-16 : espace « Carnets » libre (L3)

Statut : **fait** (L3, 2026-10-23), sauf l'essai sur la BOOX et la migration
réelle des 4 mémos (à la bascule). Écarts avec la proposition : l'espace est
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
