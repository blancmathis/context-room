## Summary

**Local continuation, 2026-09-16.** The downloaded `1901566` source tree was
restored and checked against all 370 archive blobs. Local corrections, actual
macOS/browser/Android execution and real Codex/Whisper checks now supersede the
unexecuted-test statements below. See the current coverage and local checkpoint
in [verification](docs/lifecycle/changes/active/android-convergence/verification.md).
Private migration receipts and source data remain outside this public repository.
The historical handoff below describes the original delivery, not current Git,
installation or authorization state. Physical BOOX acceptance and the measured
sub-ten-second first-result target remain open; do not retire the old installation
before device-only work is accounted for and its replacement is confirmed.

Continuation limitée aux dessins progressifs historiques et aux délais applicatifs
avant le premier résultat utile, depuis `56aa6c78262dc338dfcd6b44826a9416a722617e`.
ZIP et bundle représentent le même HEAD, correctif Shared antérieur inclus ; aucun
complément manuel. Aucune acceptation documentaire, installation ou publication.

## Defines

Le code livré, ses preuves exactes et les vérifications restant locales. La section
finale de `docs/lifecycle/changes/active/android-convergence/verification.md` reste
l’unique matrice courante ; sa copie de distribution est une extraction.

## Does not define

Une autorisation de fusion, poussée, release/npm, migration de données personnelles,
modification d’appairage ou arrêt de Codex/Desktop/Tailscale. Les fixtures ne sont
ni une génération réelle, ni une mesure d’affichage ou d’acoustique BOOX.

# Relais Codex local — dessins progressifs et premier résultat utile

## 1. Identité unique et restauration

Le HEAD de livraison exact figure dans `livraison/SOURCE_COMMIT`, `DELIVERY.json`,
le commentaire du ZIP et l’unique référence de branche du bundle. La copie externe
du relais le porte en en-tête. Le fichier Git versionné n’emploie pas une impossible
autoréférence de hash. Tous les octets source et leurs modes sont ceux de Git.

- Départ exact : `56aa6c78262dc338dfcd6b44826a9416a722617e`.
- Branche inchangée : `mathis/context-room-recovery-hardening-20260915`, PR 42.
- Lot progressif : `cf8ca7b2eb3705b02d545ea7367c4fa5abed1b58`.
- Lot délais/instrumentation : `c8c82e8267faaa7bc35480d957cee081d6dc5336`.
- Refus de scope synchrone préservé : `934e8ff1420d771b2d8c1f6fd0d84556d993ef7d`.
- Dernier commit logiciel : `b936be5d7d69896aecfb2478735e1b5de7f0ca4e` ; comparaison des chemins compacts.
- Base publique/prérequis du bundle cumulatif : `b41e8945786cd5821e7adb45695fb6b271849336`.
- La PR distante reste à b41 au dernier relevé ; aucun commit local n’a été poussé.

L’intégralité des commits de la livraison 56aa6c7 est incluse, avec le correctif
Shared réassemblé antérieurement dans `170918d44a40517324a264477fe6c6523a05d7cd`.
Aucun autre dépôt, référence ou historique Git privé Lisière n’est inclus. Le ZIP
est complet pour les sources ; les dépendances installées ne sont pas distribuées.
La version du package reste `0.6.17`.

Dans un clone dédié et propre possédant b41, sans modifier un worktree personnel :

```sh
umask 022
BRANCH=mathis/context-room-recovery-hardening-20260915
BASE=b41e8945786cd5821e7adb45695fb6b271849336
BUNDLE=/chemin/absolu/context-room-pr42-progressive-latency.bundle
DELIVERY=/chemin/absolu/zip-extrait/livraison
EXPECTED_HEAD=$(cat "$DELIVERY/SOURCE_COMMIT")
git cat-file -e "$BASE^{commit}"
test -z "$(git status --porcelain)" || exit 1
git bundle verify "$BUNDLE"
git fetch "$BUNDLE" "refs/heads/$BRANCH"
test "$(git rev-parse FETCH_HEAD)" = "$EXPECTED_HEAD"
git switch --detach FETCH_HEAD
git fsck --full
```

La restauration isolée n’effectue aucune fusion de PR. Une future avance de la
branche demanderait un contrôle explicite de non-divergence. Inventaire des blobs,
modes, SHA-256, résultat de restauration et commandes de test figurent dans
`livraison/VALIDATION.json`, `FILES-SHA256.json` et le reçu externe.

## 2. Corrections navigateur déjà présentes dans la base distante

Les anciens échecs ne sont plus ouverts à b41. La CI **34966764884** a réussi :
Node 20/22.23.0/24, Chromium desktop/mobile, Firefox, WebKit, accessibilité,
performances desktop, Soak et gate. La convergence **34966764731** a réussi
(contrats, confidentialité du package, build Android).

Les deux URL de review sont servies : `/assets/local-proposal-review.mjs` et
`/assets/ui/local-proposal-review.mjs`. Le module `native-drawing.mjs` est exposé.
Les lignes de review conservent leur nœud DOM lors du rafraîchissement, notamment
entre pointerdown et pointerup. Le test Shared attend ensemble les assertions
originelles de révision exacte de `current`, du lien de skill et de configuration ;
il ne confond plus catalogue actualisé et matérialisation disque terminée.
Aucune de ces assertions n’a été retirée dans cette continuation.

Les parcours complets carnet → dessin → instantané → relecture/correction →
acceptation humaine, y compris le PNG natif, réussissent **sur b41**. Les lots
locaux prolongent cette base sans réécrire ces corrections. Ils ne
possèdent pas encore de résultat CI distant.

## 3. Nouveaux comportements livrés

### Réconciliation et cache tablette

`src/lisiere_reconcile.py` compare les arguments Android retenus avec la
sérialisation et les digests Mac d’origine, sans passage des entiers historiques
par des nombres JavaScript. Les cellules, dérivés et identités doivent concorder.
Une mutation confirmée exige digest, résultat, historique et révisions cohérents.
Une identité ou un contenu ressemblant ne constitue pas un reçu.

Les chaînes `board.mutate` projettent uniquement les révisions de leurs propres
prédécesseurs vérifiés ou projetés. Les annulations gardent, au contraire, la
précondition exacte du geste historique : aucune adaptation sur un geste récent.
Créations, métadonnées, dossiers/projets, assets, suppressions et intentions
compatibles peuvent former une **nouvelle scène de récupération**. La source Mac,
les objets indépendants et les deux snapshots restent inchangés.

Un cache tablette présent impose le choix explicite `queue` ou `tablet`. Le
second récupère les objets locaux, même absents de la file, dans une copie
éditable distincte. Les révisions d’import et leur correspondance originale sont
conservées ; elles ne prétendent pas être des révisions reçues du Mac. L’absence
d’un objet du cache ne devient pas une suppression Mac. Les assets manquants,
valeurs non représentables et conflits restent bloquants, avec originaux retenus.

```sh
node bin/context-room.mjs migrate --root "$PROJECT" \
  --reconcile-lisiere "$ANDROID_SNAPSHOT" --mac-snapshot "$MAC_SNAPSHOT" \
  --legacy-board "$BOARD_ID" --legacy-actor "$ORIGINAL_ACTOR" \
  --path docs/Recovered.crnb

# Après lecture du plan et choix explicite :
node bin/context-room.mjs migrate --root "$PROJECT" \
  --reconcile-lisiere "$ANDROID_SNAPSHOT" --mac-snapshot "$MAC_SNAPSHOT" \
  --legacy-board "$BOARD_ID" --legacy-actor "$ORIGINAL_ACTOR" \
  --path docs/Recovered.crnb --recovery-view queue
# Ajouter --apply --revision REVISION pour appliquer exactement ce second plan.
# Choisir tablet et un autre chemin pour une copie distincte du cache.
```

Ne pas déduire automatiquement `ORIGINAL_ACTOR` du nom de la tablette. Réutiliser
l’inventaire du snapshot. Aucun ancien envoi n’est rejoué ou acquitté. L’import
n’écrit pas un document ordinaire accepté ; la soumission et la décision humaine
restent les parcours Local/Shared existants.

### Jobs et frames de dessin progressif — nouveau lot

`src/lisiere_pen_recovery.py` rapproche le job, l’historique groupé `pen:<job>`,
les événements des frames `pen:<job>:<n>` et les objets Mac canoniques. Le store
historique écrivait objet/groupe/événement dans une transaction, puis le descripteur
de job dans une autre. Un descripteur en retard ne doit donc pas effacer une frame
commise ; son compteur n’est pas à lui seul une preuve de commit.

Les états arrêtés/interrompus/en cours/terminés sont distingués. Sont couverts :
descripteur exact, retard d’une frame, crash autour de la première frame, tentative
échouée non commise, overlay de statut au redémarrage, plusieurs objets aux dernières
révisions distinctes, suppressions et annulations. Les éditions canoniques plus
récentes restent prioritaires. L’annulation garde chaque précondition d’origine,
jamais la révision globale ni une adaptation sur un geste plus récent.

Numéros discontinus, doublons, acteur discordant, groupe ou job orphelin, préfixe
contradictoire et annulation sans révision avancée bloquent l’import. Les entiers
64 bits restent exacts. Les événements, descripteurs et historiques originaux sont
retenus ; les demandes ne sont ni envoyées, ni acquittées, ni reprises. L’apply
utilise exclusivement le moteur de scène de travail et la review humaine existants.
Les reçus ordinaires sans preuve de stylet gardent leur schéma d’octets précédent.

**Limite des données historiques, pas génération de secours :** le descripteur ne
contient pas le plan futur, et le groupe ne contient pas la géométrie de toutes les
frames intermédiaires. Ces octets absents ne sont pas inventés. Un original développé
`board.draw`, ou sa forme absolue M/L/Q/C/Z, disponible peut être lié par son digest Python exact, acteur, lease,
durée et préfixe réellement atteint. Une disposition diagram/table dépendante des polices sans ses opérations
normalisées d’origine ne devient pas comparable en substituant d’autres métriques
de police. Elle reste un conflit de preuve explicite. Un job cohérent sans requête
d’origine permet de récupérer le préfixe Mac mais ne prouve pas toute la demande :
`completedRequestProven: false`. Les chemins compacts sont décodés pour comparer le digest, jamais pour importer
une fin de trait non commise.

### PCM explicitement lié

`src/lisiere_recording_links.mjs` conserve l’audio et l’association dans le store
privé de l’assistant, **hors du projet**, avec hash, source et version choisis.
Le nom haché du PCM n’est jamais utilisé pour deviner un contexte. Chaque lecture
réautorise le document/carnet et, le cas échéant, la conversation d’origine.

```sh
node bin/context-room.mjs migrate --root "$PROJECT" \
  --import-lisiere "$SNAPSHOT" --legacy-recording "$PCM_NAME" \
  --path docs/Guide.md --label "Dictée récupérée"
# Ou --conversation-id UUID à la place de --path, jamais les deux.
# Appliquer ensuite avec --apply --revision REVISION après lecture du plan.
```

Le panneau existant de conversation propose « Recovered recordings » : sélection,
aperçu, rattachement, chargement audio **sans autoplay** et export PCM exact.
Ni transcription, ni envoi de message, ni création de tâche d’agent ne résultent
d’un rattachement. Les tests HTTP/CLI et hashes passent ; le nouveau parcours
navigateur et son ergonomie restent non exécutés ici.

### Bascule et retour arrière sans écrasement

L’action `--cutover-lisiere` vise uniquement le service standard reconnu
`fr.lisiere.companion`, son plist original et son répertoire de données standard.
Le plan vérifie un snapshot Mac terminé et identique à la source vivante.
L’application met l’écriture en transition, demande l’arrêt/désactivation du
service, vérifie l’absence de fichiers ouverts, puis déplace **sans remplacement**
le répertoire original complet vers sa rétention privée. Un répertoire bloquant
remplace l’ancien chemin SQLite. L’écriture Context Room n’est autorisée qu’après
vérification de cette barrière et du snapshot retenu. Les journaux reprennent les
phases enregistrées, sans remplacer un occupant inconnu.

```sh
# macOS, compte synthétique pour le premier essai ; aucune donnée personnelle :
node bin/context-room.mjs migrate --root "$PROJECT" \
  --cutover-lisiere "$LEGACY_SOURCE" --mac-snapshot "$MAC_SNAPSHOT" \
  --legacy-plist "$LEGACY_PLIST"
# L’application exige un choix humain local explicite, puis --apply --revision R.

node bin/context-room.mjs migrate --root "$PROJECT" --rollback-cutover
# --apply --revision R => pause de toute écriture inscrite à cette migration.
node bin/context-room.mjs migrate --root "$PROJECT" --resume-cutover
# --apply --revision R => reprise de Context Room si la barrière reste intacte.
```

**Ce rollback est une pause sûre, pas un retour fonctionnel à Lisière.** Il
préserve les gestes, fichiers, propositions et configurations récents en place.
Il ne restaure pas d’anciens fichiers sur les nouveaux et ne redémarre aucune
ancienne file. Répéter une transition dont la réponse s’est perdue n’agit pas sur
une génération ultérieure. `doctor`, les lectures et les actions de sécurité
restent accessibles pendant la pause. Une barrière ou une autorité manquante
bloque les mutations au lieu de les déclarer réussies.

La source complète retirée peut contenir des données privées et credentials ;
elle reste uniquement dans son répertoire privé local. Ne jamais joindre cette
rétention à une PR, aux logs publics ou à cette distribution de sources.

### Complément Shared désormais intégré

`src/shared_context.mjs` consulte l’autorité d’écriture à la création/réutilisation
et publication d’une proposition, pour le carnet figé et **juste avant le push**.
La publication depuis un dépôt Shared réautorise aussi le projet d’origine de la
proposition. La pause pendant la préparation conserve le commit local, sans
push ni faux reçu distant. `test/shared_writer_authority.test.mjs` couvre ces
chemins via les API et la vraie CLI avec dépôts synthétiques. Ces garanties ont
les deux preuves ciblées E05 ; elles n’ont pas de terminal complet récupéré.

### Délais applicatifs — nouveau lot

La lecture du chemin critique a identifié des attentes contrôlées par Context Room,
sans attribuer arbitrairement les 13,402/14,189 s historiques au fournisseur :

| Étape | Changement vérifiable | Ce qui reste distinct |
| --- | --- | --- |
| Ouverture du composeur | Le brouillon exact est toujours récupéré avant activation ; le catalogue des autres conversations ne bloque plus la saisie/capture. | Temps de récupération du brouillon et rendu réel. |
| Démarrage fournisseur | Un seul processus lorsque la configuration effective prouve l’absence de MCP hérités actifs ; sinon remplacement isolé et recontrôle maintenus. | Initialisation, backfill éventuel du fournisseur, IPC et modèle. |
| Fermeture de la sonde inactive | Une opportunité EOF dans la boucle d’événements, puis SIGTERM du seul processus possédé et sans tâche ; attente de sa sortie effective. | Le délai normal de fermeture des sessions actives reste inchangé. |
| Premier texte reçu | Sauvegarde immédiate dans le callback, sans les 250 ms de regroupement initiaux. Les deltas suivants restent regroupés. | Réception réseau/fournisseur, coût disque et peinture client. |
| Mesure | Jalons monotones par requestId et métriques d’initialisation détaillées. Premier point et segment utile d’au moins une unité sont séparés. | Pas de mesure pure d’inférence, d’affichage ni d’audio. |

`operation.timing` contient les frontières de traitement du même envoi.
`provider.setupTiming` distingue initialisation, configuration, fermeture/reprise
éventuelle et catalogue de modèles. `toolWorkSumMs` peut contenir des intervalles
concurrents ; ne pas le soustraire pour annoncer un temps d’inférence. Les contrôles
d’autorisation/révision, modèles, effort, périmètre et durée des gestes sont conservés.
Le polling de conversation à 500 ms et du carnet à 900 ms n’a pas été accéléré.
Aucune pré-génération, seconde demande, récupération d’un ancien dessin ou augmentation
de permissions ne sert de substitut au premier résultat réel.

## 4. Résultats réellement exécutés — pas une CI verte globale

Les journaux et leurs reçus sont dans `livraison/preuves/` et `VALIDATION.json`.
Les nouveaux reçus enregistrent le commit d’entrée, les commandes, versions,
inventaires d’empreintes, masque 022 et résultat terminal. Les durées de tests avec
transport synthétique ne sont jamais des temps de fournisseur authentifié.

| Preuve | Entrée et commande | Résultat terminal / portée |
| --- | --- | --- |
| P01 | Lot progressif initial à cf8ca7b, inclus dans F01 | 17/17 contrats Python et 3/3 tests Node (dont le lanceur Python). |
| P02 | Chemins compacts et preuve finale à b936be5d7d69896aecfb2478735e1b5de7f0ca4e, inclus dans F02 | 19/19 contrats Python et 3/3 tests Node (dont le lanceur Python), sans ancien appel fournisseur. Frames, fenêtres de crash, undo exact, conflits et reprise sans remplacer le travail récent. |
| L01 | `node --test test/assistant_latency.test.mjs test/codex_provider.test.mjs` après correction de fermeture de sonde | 24/24. Les transports sont synthétiques, la sauvegarde et le moteur de carnet sont réels. |
| F01 | Campagne ciblée de 35 fichiers à c8c82e8, `CI=1`, Node 22.16.0, Python 3.13.5, masque 022 | 182/183 tests, code de sortie 1 ; un échec conservé. Régression trouvée : le wrapper d’instrumentation async changeait le refus synchrone de scope. Aucune assertion retirée. |
| F02 | Code `b936be5d7d69896aecfb2478735e1b5de7f0ca4e`, mêmes assertions de conversation historique, dépendances du wrapper et réconciliation finale | 68/68 tests sur 12 fichiers, code de sortie 0 ; aucun skip ni assertion réduite. Le contrôle d’accès synchrone et le retour synchrone/asynchrone original sont préservés. |
| D01 | Dernier code logiciel + clôture documentaire seulement | Syntaxe, confidentialité/package, inventaire, bundle/restauration et octets ZIP : résultats dans les reçus. Pas de nouvelle suite métier après changement documentaire seul. |

Le premier essai de fermeture de sonde a également échoué sur deux assertions de
sortie naturelle. Le journal `latency-probe.log` est conservé : 22/24. Le correctif
laisse une opportunité de terminer sur EOF avant SIGTERM ; les **mêmes assertions**
passent ensuite dans `latency-probe-fixed.log` (24/24). La campagne F01 et sa
régression ne sont pas effacées au profit de F02. La validation finale est composée
de périmètres explicitement identifiés, pas d’un nouveau `npm test` complet.

**Historique conservé mais non réattribué :** la CI b41 (34966764884 / 34966764731)
a réussi, notamment navigateurs et Soak, uniquement sur b41. Le journal complet
antérieur associé à 0b932ab finit à 101/102 processus, donc en échec. Le cas sécurité
Shared réclame `ssh-keygen` ; même échec ancien sur b41. Le terminal ancien annoncé
à 36e8180 n’a pas été récupéré. Ces preuves historiques sont celles de 56aa6c7,
pas celles des nouveaux commits. Le test Shared de pause pré-push est inclus dans
F01 ; ce n’est pas le cas de configuration OpenSSH bloqué.

Aucun nouvel essai OpenSSH, navigateur, fournisseur authentifié ou Gradle n’a été
lancé. Le refus navigateur `ERR_BLOCKED_BY_ADMINISTRATOR` et Gradle absent du cache /
échec DNS avant compilation restent documentés sans contournement. Les dépendances
Node proviennent du cache de vérification antérieur, avec lockfile identique.
Aucune installation de package, clé ou modèle n’a été tentée.

Dans un environnement local déjà autorisé et équipé, terminer la campagne générale
et lire son terminal. Ne pas relancer les lots ciblés inchangés pour le seul
reconditionnement, et ne pas qualifier de réussite un prérequis manquant.

## 5. Préparation et vérification Mac

Le générateur de kit fourni prépare du **code, pas une installation**. Aucun ancien kit généré sur un autre HEAD n’est joint comme kit courant. Il ne contient ni
node_modules, ni modèle Whisper, ni clé, ni base, ni plist activé. Son manifeste
fixe les fichiers, modes et SHA-256. Le chemin Node cible doit être choisi sur le Mac avec `--node` ; aucun chemin local personnel ni dépendance installée n’est livré.

Conserver le kit à un emplacement privé stable et vérifier **avant** d’ajouter
les dépendances. Utiliser les sources complètes pour régénérer un kit lorsque le
chemin Node ou les options doivent changer, plutôt que modifier le manifeste :

```sh
NODE_ON_MAC=/chemin/absolu/vers/node
KIT=/chemin/prive/stable/context-room-kit
node scripts/prepare-mac-install.mjs --output "$KIT" --node "$NODE_ON_MAC"
# Puis --apply --revision REVISION, avec les mêmes options.
node scripts/prepare-mac-install.mjs --verify --output "$KIT" --revision "$REVISION"
```

Prérequis locaux à vérifier : Node 20+, npm, Git, Python 3 compatible avec les
helpers, OpenSSH pour la configuration sécurisée Shared ; JDK 17/SDK 35 pour
Android. Whisper et son modèle restent optionnels. Aucune API payante n’est
substituée. Ajouter `--whisper /chemin/whisper-cli --model /chemin/modele.bin`
lors de la préparation seulement après choix et vérification locaux.

Avec autorisation explicite de téléchargement des dépendances :

```sh
cd "$KIT/runtime"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
# --offline peut être ajouté si le cache est déjà complet.
node bin/context-room.mjs doctor --root "$SYNTHETIC_PROJECT"
node bin/context-room.mjs hub status --format json
```

Le vérificateur du kit refuse les fichiers non listés, y compris les dépendances
installées ensuite ; son reçu concerne le code préparé avant cette expansion.
La définition LaunchAgent se rend donc **avant** `npm ci`, depuis les sources
complètes, et se conserve hors du kit sans écrasement :

```sh
node scripts/prepare-mac-install.mjs --launch-plist --output "$KIT" \
  --revision "$REVISION" --home "$HOME" > "$NEW_PRIVATE_PLIST"
```

`NEW_PRIVATE_PLIST` doit être absent ; utiliser le mode shell `noclobber` ou une
création exclusive. Inspecter les processus, le port choisi et tout ancien plist
`app.contextroom.local` avant activation. La définition ne crée pas de store
alternatif, ne réenregistre pas le projet du runtime et n’expose pas implicitement
un listener tablette. En compte de test et après autorisation, valider avec
`plutil -lint`, enregistrer le plist sans remplacer un existant, puis utiliser
`launchctl bootstrap gui/$(id -u) CHEMIN_PLIST`. Vérifier arrêt, redémarrage,
reconnexion, archives et absence d’un deuxième Hub. Ces actions ne sont **pas**
exécutées par la préparation du kit.

L’adaptateur d’arrêt Lisière, `lsof` et `renamex_np(RENAME_EXCL)` doivent être
exercés sur macOS. Les contrats Linux utilisent de vrais fichiers/SQLite et le
renommage Linux sans remplacement ; ils ne prouvent pas le comportement Darwin.
Ne pas tester l’arrêt avec le compte/service personnel : préparer un compte
synthétique et un service factice explicitement contrôlé sous les chemins du
contrat. Conserver hors dépôt tout état produit par ces essais.

## 6. Android : fichiers touchés, artefact et exécution locale

Aucun fichier Android de production, Gradle ou test natif n’est modifié depuis
56aa6c7 par ces deux lots. Les huit assets embarqués restent ceux de la baseline.
Le module de conversation servi par le Mac et le provider ont changé ; les anciens
essais d’exécution Android ne valident pas ces nouveaux comportements.
**Nouveau code natif de test** :
`android/app/src/androidTest/java/app/contextroom/tablet/OwnerRecordingTest.java`.
La fixture `test/android/owner-fixture.mjs` et le vérificateur
`test/android/verify-owner.py --recording` sont étendus. L’interface servie par
le Mac a changé : les anciennes preuves owner-WebView ne couvrent pas ce nouvel
écran, même avec un APK production byte-for-byte compatible.

L’archive APK conservée dans les entrées de reprise est explicitement la **baseline b41** issue du run
34966764731, artefact 10396110115, commit CI `a868511baa87b37e582001b48440afba79da1610`
(arbre identique à b41).

- APK : `d0f711540bc8008ca9d09413ce2e458c1d920c5c75ceeebf2b4a0d77ddbe2f8c`.
- ZIP d’artefact : `1dca8d9913eb3a899267eb158c44d53c7a58588d9f65731fc4c483063f8687d3`.
- Comparaison des huit assets production avec les fichiers livrés : identique, contrôlée dans la livraison 56aa6c7. Le reçu de distribution contient leurs empreintes.
- APK exécuté ici : **non**. Nouvelle instrumentation compilée/exécutée : **non**.

Build local avec les vrais outils, sans importer la clé privée personnelle dans
ChatGPT/GitHub :

```sh
umask 022
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
export ANDROID_HOME="$HOME/Library/Android/sdk"
scripts/build-android.sh
python3 scripts/check-android-artifact.py
```

Pour la variante de récupération, uniquement après autorisation et avec APK/
clé d’origine déjà présents localement :

```sh
scripts/build-android-recovery.sh "$ORIGINAL_APK" "$HIGHER_VERSION_CODE"
```

Ce script exige le chemin absolu de l’APK original et un code de version supérieur,
vérifie l’identité/signature, et ne doit pas réinitialiser l’application d’origine.
La vraie clé n’est jamais transférée ou ajoutée à un secret CI.

### Émulateur dédié : nouveau scénario PCM

Sélectionner un AVD nommé `ContextRoom_...`, avec un serial `emulator-...`.
Les vérificateurs refusent les appareils physiques ou les émulateurs personnels.
La fixture Shared doit être sous le home : choisir un **nouveau** dossier privé
sous `$HOME`, hors du dépôt, et ne jamais recycler les fichiers d’un essai ambigu.
Le script installe les deux APK sur cet émulateur ; cela requiert l’autorisation
locale d’installation sur cet émulateur dédié.

```sh
EVIDENCE="$HOME/.context-room-verification/pcm-$(date +%Y%m%d-%H%M%S)"
python3 test/android/verify-owner.py --serial "$EMULATOR_SERIAL" \
  --output "$EVIDENCE" --recording
```

Attendu : navigation réelle vers la conversation, sélection et preview du PCM
synthétique, association exacte, lecteur chargé mais en pause, export via le
sélecteur natif, hash PCM inchangé, source/document/carnet initial inchangés,
aucune tâche ou requête d’agent. Le test conserve trois captures et un reçu JSON.
Aucune prise de son ni qualité acoustique n’est déduite de ce scénario.

### Navigateur autorisé : nouvelle UI et non-régression pertinente

```sh
npx playwright install chromium firefox webkit
npx playwright test test/e2e/recovery-recordings.spec.mjs --project=chromium-desktop
# Puis les autres projets autorisés, après correction éventuelle ciblée :
npx playwright test test/e2e/recovery-recordings.spec.mjs --project=chromium-mobile
npx playwright test test/e2e/recovery-recordings.spec.mjs --project=firefox-desktop
npx playwright test test/e2e/recovery-recordings.spec.mjs --project=webkit-desktop
```

Inspecter les captures et les résultats axe ; vérifier sélection, passage à une
autre conversation, absence d’autoplay, absence d’envoi et exactitude de l’export.
La première commande installe les navigateurs de test : utiliser un cache existant
ou obtenir l’autorisation de téléchargement. Aucun contournement de la politique
Chromium locale n’a été tenté ici. Après intégration/poussée sur la branche
existante, lire les vrais résultats CI du nouveau SHA plutôt que supposer du vert.

### Fournisseur authentifié : protocole restant, distinct du rendu

Aucun nouveau temps réel n’est disponible. Références historiques : **13,402 s**
et **14,189 s**, objectif dix secondes encore ouvert. Les attentes supprimées sont
vérifiées par contrats ; aucun gain réel chiffré n’est attribué au modèle.

Sur un Mac déjà équipé d’un Codex authentifié, autoriser explicitement le véritable
essai. Le vérificateur crée uniquement un carnet synthétique et préserve le texte
humain et un autre projet ; ses résultats restent hors dépôt :

```sh
umask 022
node test/agent/verify-codex.mjs --run --output "$NEW_PRIVATE_AGENT_EVIDENCE" \
  --codex-state "$LOCAL_CODEX_STATE"
```

Le modèle par défaut reste celui du script (`gpt-6-astra`, effort low). Ne pas
changer modèle/effort pour comparer la seule correction applicative. `--output`
doit être absolu et absent ; le script refuse une sortie dans le dépôt. Lire
`proof.json`, `calls.json`, `events.json`, `progress.json` et les erreurs éventuelles.
`providerSetup`, `providerReadyMs`, `threadSetupMs`, `toolWorkSumMs`, `firstUsefulMs`
et `firstDrawSegmentMs` sont séparés. `firstUsefulMs` garde l’ancienne définition
(première modification confirmée ou premier point) pour comparaison historique ;
le segment significatif est une métrique supplémentaire, pas un seuil abaissé.

Pour la mesure produit, faire un envoi neuf à froid puis un autre sur un provider
résident, avec et sans historique retenu, sans changer prompt/scène/modèle/effort.
Enregistrer le `requestId` **du même envoi**, ses jalons `operation.timing` via le
GET existant de conversation, la réception HTTP et le premier rendu du bon objet /
texte dans le navigateur. Garder une seule horloge monotone par surface et des
corrélations requestId/révision ; ne pas soustraire les horloges Mac et Android.
Classer : coût applicatif avant dispatch ; attente au-delà de la frontière provider
(IPC/backfill/génération indissociables sans trace fournisseur) ; outils locaux ;
transfert/polling/peinture. Ne pas additionner des intervalles qui se chevauchent.
Un loader, accusé d’envoi, point seul ou ancien contenu n’est pas une preuve de
premier dessin utile. Rapporter aussi erreurs, arrêt/redirection et intégrité humaine.

Le verifier natif existant peut ensuite être utilisé sur l’émulateur dédié :

```sh
python3 test/android/verify-agent.py --run --serial "$EMULATOR_SERIAL" \
  --output "$NEW_NATIVE_AGENT_EVIDENCE" --codex-state "$LOCAL_CODEX_STATE"
```

Il contient plusieurs envois/redirections : ne pas attribuer les timings du dernier
envoi à son premier résultat natif. Capturer les jalons du premier requestId pendant
son exécution. La nouvelle mesure d’affichage reste à faire ; les fixtures de
transport présentes ne la remplacent pas. Comparer plusieurs essais autorisés
représentatifs avec leur distribution, pas uniquement le meilleur temps.

### BOOX physique — périmètre initial, autorisation séparée

Pression, paume, latence/ghosting, micro/haut-parleur, interruption vocale,
veille/reprise Wi-Fi, clavier/zoom et confort restent à tester physiquement. Ne pas
assouplir les protections des scripts d’émulateur pour agir sur la tablette
personnelle. Aucune clé, conversation privée ou capture d’un compte réel n’est à
publier dans GitHub. Les tests Whisper et d’observation historiques restent
indépendants de cette mesure de génération et n’ont pas été relancés ici.

## 7. Limites réelles et exigences encore ouvertes

**Logiciel de cette demande livré :** rapprochement des jobs/frames du protocole
historique reconnu, récupération de préfixes et annulation exacte, attentes
applicatives réduites et instrumentation. Les données impossibles à reconstituer
(absence de géométrie intermédiaire, de plan normalisé original, conflit d’identité
ou de révision) sont conservées et refusées explicitement ; aucune reprise d’agent
ne prétend les réparer. Cela ne clôt pas V14 pour toutes les données personnelles.

**Preuves de cette demande encore manquantes :** génération authentifiée, gain
réel vers dix secondes, affichage navigateur et natif, puis BOOX. L’UI doit vérifier
que le catalogue lent ne bloque plus le brouillon exact, qu’un échec de récupération
le bloque toujours, et que fermeture/changement de source n’envoie rien de tardif.
Le refus synchrone de scope et la lecture des historiques restent testés côté Node.

**Écarts initiaux hérités, non élargis ici :** le kit Mac et le plist sont préparés,
mais une installation activée/cohérente de bout en bout n’est pas démontrée ;
Darwin/launchctl/lsof et la bascule standard restent à tester sur compte synthétique.
L’UI PCM navigateur et l’instrumentation Android préparée restent non exécutées.
Le cas sécurité Shared OpenSSH et une campagne complète au HEAD final restent
ouverts ; les succès ciblés ne constituent pas une CI générale verte.

**Limites hors extension demandée :** le rollback met en pause les writers inscrits
et préserve le travail récent, sans réactiver Lisière ni convertir tout le travail
nouveau vers l’ancien format. Aucun inverseur bidirectionnel complet, installateur
universel pour configurations inconnues, réparation de barrières remplacées ou
updater automatique n’est ajouté aux critères. Pas de tablette sans Mac connecté,
Inbox indépendante, hosted obligatoire, éditeur Office ou remplacement vocal payant.
La validation physique BOOX, elle, demeure une exigence initiale.

## 8. Fichiers de ces deux lots

Nouveaux : `src/lisiere_pen_recovery.py`, `src/assistant_timing.mjs`,
`test/python/lisiere_pen_recovery_test.py`, `test/lisiere_pen_recovery.test.mjs`,
`test/assistant_latency.test.mjs`.

Modifiés : `src/lisiere_reconcile.py`, `src/lisiere_reconcile.mjs`,
`src/assistant_sessions.mjs`, `src/codex_provider.mjs`, `src/notebook_agent.mjs`,
`src/ui/assistant.mjs`, `test/lisiere_reconcile.test.mjs`,
`test/agent/verify-codex.mjs`, les propriétaires migration/conversation, l’index,
le journal et ce relais. Les fichiers antérieurs, y compris le correctif Shared,
sont intégralement présents. Aucun fichier de grooming, workflow CI, package/lock,
configuration de modèle ni assertion de performance n’a été retiré ou affaibli.
