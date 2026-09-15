## Summary

Relais d’exécution et de livraison de la PR 42. Cette continuation ajoute du code,
des tests et un kit de préparation Mac. Elle ne déclare pas le remplacement
complet de Lisière ni une installation personnelle terminée.

## Defines

Les entrées exactes des preuves, les nouveaux fichiers, la reprise sur la branche
existante et les vérifications restantes. La matrice canonique actuelle est en
fin de `docs/lifecycle/changes/active/android-convergence/verification.md` ; ses
56 lignes distinguent preuve héritée, contrat exécuté et comportement non testé.

## Does not define

Une autorisation de fusion de PR, release/npm, installation personnelle,
modification d’appairage, arrêt de Codex/Desktop/Tailscale ou migration privée.
Les décisions documentaires restent humaines et distinctes de la revue Git.
Les fixtures et les contrôles d’intégration n’acceptent aucun document personnel.

# Relais Codex local — continuation du 15 septembre 2026

## 1. Commits exacts et reprise de la même branche

- Base publique de la PR : `1a2cdcec1435d60cd8d07a3762a369e066508ce1`.
- Dernier HEAD **distant** vérifié : `b41e8945786cd5821e7adb45695fb6b271849336`.
- HEAD **logiciel et tests** de cette livraison : `22b998d4c08289ec377801c64a8f352a0f5c1b83`.
- Branche : `mathis/context-room-recovery-hardening-20260915`.
- PR : `blancmathis/context-room#42`, ouverte et en brouillon.

Les sept commits logiciels sont locaux et **ne sont pas poussés**. Les actions
GitHub exposées ici sont en lecture seule ; aucune autre connexion autorisée ne
permet la poussée. Un commit final ne modifie que ce relais et la documentation.
Son SHA exact est dans le reçu de distribution `DELIVERY.json` / `SOURCE_COMMIT`
qui accompagne les sources et le bundle. Ne pas présenter la CI de b41 comme la
CI de cette livraison.

| Commit local | Lot |
| --- | --- |
| `715f2f8435c80bd77dafc193008fa078effc0bae` | Rapprochement des intentions Android et des reçus/révisions Mac |
| `e566fd2eafb0c950e6903dd2c98a835ccf8629d1` | Rattachement PCM explicite, CLI, HTTP et panneau de conversation |
| `ada764db142341743c416a88314d2c71653a6bc4` | Bascule journalisée, arrêt vérifié de l’ancien service et pause de retour arrière |
| `fe3f10edff6552947f12ee8a70bc70071465ac35` | Kit Mac vérifiable et définition LaunchAgent inerte |
| `a6989eee73ddbee75aaae03ca05e1663ad5a7748` | Fixture native et instrumentation Android du rattachement PCM |
| `0b932abf868de1238a9368a09aa5908da6e3418f` | Copie explicite du cache tablette et préconditions exactes d’annulation |
| `22b998d4c08289ec377801c64a8f352a0f5c1b83` | Normalisation du chemin par défaut du kit et test CLI réel complet |

Le bundle est **incrémental**, avec b41 comme prérequis. Il ne contient pas
l’historique privé Lisière. Avoir seulement main/1a2cdce ne suffit pas. Reprendre
dans un clone ou worktree dédié, propre, sans réinitialisation ni force-push :

```sh
umask 022
BRANCH=mathis/context-room-recovery-hardening-20260915
BASE=b41e8945786cd5821e7adb45695fb6b271849336
CODE_HEAD=22b998d4c08289ec377801c64a8f352a0f5c1b83
BUNDLE=/chemin/vers/context-room-pr42-continuation.bundle

git fetch origin "$BRANCH"
git cat-file -e "$BASE^{commit}"
git status --short              # ne pas continuer avec un travail non conservé
git switch "$BRANCH"
git bundle verify "$BUNDLE"
git fetch "$BUNDLE" "refs/heads/$BRANCH"
git merge --ff-only FETCH_HEAD  # avance locale seulement, pas une fusion de PR
git merge-base --is-ancestor "$CODE_HEAD" HEAD
git rev-parse HEAD
```

Si la branche distante a avancé de façon divergente, arrêter l’avance rapide et
intégrer les changements en préservant les deux travaux. Ni `reset --hard` ni
force-push. Les patches offrent un second moyen de reprise ; **ne pas appliquer
à la fois patches et bundle**. La PR existante est la destination, pas une PR ou
branche concurrente. Une éventuelle poussée ultérieure doit nommer cette branche
et n’autorise aucune fusion ou publication.

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
acceptation humaine, y compris le PNG natif, réussissent **sur b41**. Les sept
nouveaux commits prolongent cette base sans réécrire ces corrections. Ils ne
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

## 4. Preuves déjà exécutées et limites exactes

Entrée de la campagne finale : **0b932abf868de1238a9368a09aa5908da6e3418f**,
Linux, Node **22.16.0**, Python **3.13.5**, `umask 022`.

| Contrôle | Résultat observé |
| --- | --- |
| `npm test` avec le runner et les assertions d’origine | **101/102 processus**, code de sortie **1** ; pas une suite entièrement verte |
| Cas restant du shard Shared 1/4 | `shared_context.test.mjs:401`, « GitHub security setup installs and verifies a no-bypass pull-request ruleset » ; `ssh-keygen` absent, arrêt avant assertions |
| Comparaison ciblée à b41 inchangé | Même test, même erreur `ssh-keygen is required to create the restricted agent credential` |
| Reste de ce shard | 40/41 cas passent ; les shards 2/4, 3/4, 4/4 et les tests exclusifs Shared passent |
| Nouveaux modules de réconciliation/cache/PCM/bascule/kit/fixture | Tous leurs processus passent dans la campagne finale, sans skip ajouté |
| Réconciliation Python | 16 contrats, incluant nombres exacts et annulations périmées, appelés par la suite Node |
| `node --check` et compilation Python en mémoire | 32 fichiers nouveaux/modifiés vérifiés ; contrôle du script Mac corrigé ensuite |
| Script Mac final | **4/4** contrats ciblés, dont preview/apply/verify/repeat via la vraie CLI |
| `npm run package:privacy` | Réussite |
| `npm pack --dry-run` | Réussite ; version **0.6.17** inchangée, aucune publication |
| `doctor` sur projet synthétique neuf, sans réduction du périmètre | Aucune erreur projet ; dépendances audio facultatives absentes annoncées, aucun store d’agent créé |
| Fixture doctor négative | Une réduction `startupSkills.enabled` a correctement déclenché `review_authority_tamper` ; résultat conservé, aucun contournement |
| Nouveau navigateur PCM | Navigation refusée : `net::ERR_BLOCKED_BY_ADMINISTRATOR` avant exécution du scénario |
| Build Android local | Échec **avant compilation** : distribution Gradle 8.11.1 non mise en cache, résolution DNS indisponible ; SDK non configuré |

Le dossier de distribution contient un résumé assaini des preuves. Les logs
complets ne sont pas publiés indistinctement : les fixtures peuvent produire des
identifiants temporaires. Aucune donnée personnelle n’a servi aux tests.

Ne pas répéter la campagne complète inchangée pour chercher du vert. Le test
bloqué doit être lancé avec le vrai OpenSSH, pas un wrapper simulé ou une assertion
réduite :

```sh
command -v ssh-keygen
umask 022
node --test \
  --test-name-pattern='^GitHub security setup installs and verifies a no-bypass pull-request ruleset$' \
  test/shared_context.test.mjs
```

La fabrication réelle du kit a ensuite trouvé un défaut du script : le chemin
par défaut dérivé d’une URL de dossier comportait un slash final. Le garde
canonique avait raison de le refuser. Le commit **22b998d4c08289ec377801c64a8f352a0f5c1b83**
normalise seulement ce défaut dérivé et conserve le refus des sources explicites
non canoniques. Le nouveau test CLI prépare le vrai package et vérifie la seconde
exécution ; **4/4 contrats Mac passent**. Le kit réel est aussi préparé, vérifié
et rejoué. Ce résultat n’efface pas l’échec initial, consigné dans les preuves.

Les entrées exécutables de la campagne complète, hors ce script et son test,
sont inchangées entre 0b932ab et le HEAD logiciel final. Les résultats sont donc
composés de cette campagne et du contrôle ciblé corrigé, pas présentés comme un
nouveau `npm test` entièrement vert. Le kit de distribution a ses propres
révision/empreinte ; il ne contient aucune dépendance installée.

Le dernier commit de distribution ne change que des documents. Si le logiciel
est modifié lors d’une reprise, exécuter d’abord les tests affectés, puis une
campagne finale pertinente sur le nouvel état. La réussite CI b41 est réutilisable
seulement pour ses entrées réellement inchangées, jamais pour valider l’UI PCM.

## 5. Préparation et vérification Mac

Le kit fourni est du **code préparé, pas une installation**. Il ne contient ni
node_modules, ni modèle Whisper, ni clé, ni base, ni plist activé. Son manifeste
fixe les fichiers, modes et SHA-256. La configuration livrée désigne
`/opt/homebrew/bin/node` comme chemin cible à vérifier sur le Mac ; aucun constat
de disponibilité de ce chemin n’a été fait dans cette session Linux.

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

Production Java/Gradle et les huit assets embarqués restent inchangés depuis b41.
**Nouveau code natif de test** :
`android/app/src/androidTest/java/app/contextroom/tablet/OwnerRecordingTest.java`.
La fixture `test/android/owner-fixture.mjs` et le vérificateur
`test/android/verify-owner.py --recording` sont étendus. L’interface servie par
le Mac a changé : les anciennes preuves owner-WebView ne couvrent pas ce nouvel
écran, même avec un APK production byte-for-byte compatible.

L’archive APK fournie est explicitement la **baseline b41** issue du run
34966764731, artefact 10396110115, commit CI `a868511baa87b37e582001b48440afba79da1610`
(arbre identique à b41).

- APK : `d0f711540bc8008ca9d09413ce2e458c1d920c5c75ceeebf2b4a0d77ddbe2f8c`.
- ZIP d’artefact : `1dca8d9913eb3a899267eb158c44d53c7a58588d9f65731fc4c483063f8687d3`.
- Comparaison des huit assets production avec les fichiers livrés : identique.
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

### Fournisseur authentifié et BOOX : preuves distinctes

Les tests d’agent simulé ne valent pas preuve de génération réelle. Les derniers
temps authentifiés historiques restent **13,402 s et 14,189 s** ; aucun résultat
sous dix secondes n’est annoncé. Sur l’environnement local autorisé :

```sh
python3 test/android/verify-agent.py --run --serial "$EMULATOR_SERIAL" \
  --output "$NEW_AGENT_EVIDENCE" --codex-state "$LOCAL_CODEX_STATE"
python3 test/android/verify-observation.py --run --serial "$EMULATOR_SERIAL" \
  --output "$NEW_OBSERVATION_EVIDENCE" --codex-state "$LOCAL_CODEX_STATE"
python3 test/android/verify-dictation.py --run --serial "$EMULATOR_SERIAL" \
  --output "$NEW_DICTATION_EVIDENCE" --model "$LOCAL_WHISPER_MODEL" \
  --sample "$SYNTHETIC_WAV"
```

Lire leurs contrôles locaux avant lancement ; ces essais utilisent réellement
le fournisseur ou le modèle choisi. Garder l’état Codex, les logs et toute clé
hors dépôt public. Mesurer séparément coût applicatif, premier résultat utile du
fournisseur et reçu d’affichage ; ne pas vendre un replay comme une génération.

Les essais BOOX physiques nécessitent une autorisation séparée et une procédure
non destructive : pression, paume, encre/latence, ghosting, micro/haut-parleur,
interruption vocale, réseau, veille/reprise Wi-Fi, clavier/zoom et confort. Ne pas
assouplir les scripts d’émulateur pour les faire agir sur la tablette personnelle.

## 7. Logiciel incomplet, à ne pas renommer « test local restant »

1. Les reçus de jobs de dessin progressif historiques ne disposent pas d’un
   rapprochement automatique complet. Ils restent explicitement bloqués/conservés,
   jamais assimilés à une mutation ordinaire. Les scènes/cache sélectionnés restent
   récupérables séparément ; aucune ancienne exécution ne redémarre.
2. La bascule reconnaît l’installation standard Lisière. Les installations
   personnalisées et la réparation automatique de barrières partielles ou
   remplacées ne sont pas implémentées. Leur état est conservé et bloque l’écriture.
3. Le retour arrière fonctionnel vers Lisière, fusionnant tout le travail nouveau,
   n’est pas implémenté. Le rollback livré est la pause réversible décrite plus haut.
4. Le kit et la définition LaunchAgent sont préparés ; un installateur/upgrader
   macOS automatique remplaçant en sécurité une installation active n’est pas livré.

Cela est distinct des **vérifications** restantes : OpenSSH du cas Shared,
exécution navigateur PCM, vrais appels launchctl/Darwin, compilation et exécution
instrumentation Android, fournisseur Codex authentifié et BOOX physique.
Ne pas déclarer C08/V14/V18/V19 complètement validés.

## 8. Fichiers nouveaux dans les sept commits logiciels

```text
android/app/src/androidTest/java/app/contextroom/tablet/OwnerRecordingTest.java
scripts/prepare-mac-install.mjs
src/exclusive_rename.py
src/lisiere_cutover.mjs
src/lisiere_reconcile.mjs
src/lisiere_reconcile.py
src/lisiere_recording_links.mjs
src/lisiere_tablet_notebook.mjs
src/mac_installation.mjs
src/mac_legacy_quiescence.py
src/ui/assistant-recordings.mjs
src/writer_authority.mjs
test/e2e/recovery-recordings.spec.mjs
test/fixtures/lisiere-reconciliation.mjs
test/fixtures/lisiere-recording.mjs
test/lisiere_cutover.test.mjs
test/lisiere_reconcile.test.mjs
test/lisiere_recording_links.test.mjs
test/lisiere_tablet_notebook.test.mjs
test/mac_installation.test.mjs
test/owner_recording_fixture.test.mjs
test/python/lisiere_reconcile_test.py
test/python/mac_legacy_quiescence_test.py
```

Les sources complètes incluent ces fichiers et les propriétaires canoniques
modifiés. Aucun dépôt Lisière complet, son historique Git, fichier de signature,
node_modules, base réelle, enregistrement personnel ou credential n’est inclus.
Les références privées consultées servent seulement à comprendre le contrat du
format d’origine ; elles ne sont pas nécessaires pour exécuter les tests fournis.
