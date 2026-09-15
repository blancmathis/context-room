## Summary

Relais de la livraison regroupée de la PR 42. Le ZIP et le bundle représentent
le même HEAD. Le correctif Shared précédemment fourni à part est inclus ; aucun
remplacement manuel de fichier ni patch additionnel n’est nécessaire.
Le regroupement n’ajoute aucune fonctionnalité, n’installe rien et ne clôt pas
les exigences produit qui restent ouvertes.

## Defines

L’identité des sources, les preuves effectivement conservées, les limites et la
reprise sur la branche existante. La seule matrice canonique courante est la
section finale de `docs/lifecycle/changes/active/android-convergence/verification.md`.
La copie `livraison/MATRICE-COUVERTURE.md` du ZIP en est une extraction, pas un
second état édité indépendamment.

## Does not define

Une autorisation de fusion, publication, release/npm, installation personnelle,
modification d’appairage, arrêt de Codex/Desktop/Tailscale ou migration privée.
Aucun contrôle de livraison ne constitue une acceptation documentaire humaine.

# Relais Codex local — livraison regroupée du 15 septembre 2026

## 1. HEAD unique, provenance et restauration

Le HEAD **de livraison** complet est inscrit dans `livraison/SOURCE_COMMIT` et
`livraison/DELIVERY.json` du ZIP, dans son commentaire Git, et dans l’unique
référence de branche du bundle. La copie de ce relais dans `livraison/` porte ce
même SHA en en-tête. Le présent fichier versionné évite une autoréférence de
hash : son commit ne peut contenir son propre identifiant. Tous les fichiers
sous `context-room/` restent les octets Git exacts ; aucune substitution d’export.

- Branche : `mathis/context-room-recovery-hardening-20260915` ; PR : nº 42.
- Base publique de la PR : `1a2cdcec1435d60cd8d07a3762a369e066508ce1`.
- Base publique et prérequis du bundle : `b41e8945786cd5821e7adb45695fb6b271849336`.
- Dernier objet d’entrée conservé : `f6cee69d0f698f3db279ec0d7c610cbc38bae8c6`.
- Dernier commit contenant un changement logiciel : `170918d44a40517324a264477fe6c6523a05d7cd`.
- Correctif d’origine : `36e8180ea03ab640fc8ba489bcfe72259613aeef`.

L’objet Git local 36e8180 n’était pas dans le bundle d’entrée. Ses deux fichiers
étaient conservés : ils ont été réintégrés **octet pour octet**, sans modification,
dans le commit logiciel ci-dessus. Il a une nouvelle identité Git ; 36e8180
n’est pas présenté comme un ancêtre présent dans le bundle. Le journal des commits
jusqu’à f6cee69 est conservé à l’identique. Le commit de clôture ne modifie que la
documentation. La branche distante est toujours b41, ouverte et en brouillon ;
aucune poussée, fusion ou publication n’a été effectuée lors du regroupement.

Empreintes des deux fichiers récupérés, inchangés dans le HEAD livré :

```text
606111e3592945cecf4826238906d0554274aa5f53ba78cf66585dae6e5dd748  src/shared_context.mjs
52abc8b557e89f7025ed8301d2ef9e94f4c4f12a5b79326a83bf0e9f41e96c4e  test/shared_writer_authority.test.mjs
```

Le bundle est **incrémental sur b41**, et contient uniquement cette branche de
livraison et ses objets nouveaux. Il ne contient ni les autres références ni
l’historique privé Lisière. Un clone contenant seulement main/1a2cdce ne satisfait
pas le prérequis. Le ZIP est autonome pour les **sources**, sans dépendances
installées. Aucun complément logiciel ne doit être appliqué à l’un ou à l’autre.

Après extraction dans un nouveau dossier, garder `context-room/` pour les sources
et `livraison/` pour l’identité et les preuves. La restauration Git se fait dans
un clone dédié possédant b41. Ne pas toucher un worktree personnel modifié :

```sh
umask 022
BRANCH=mathis/context-room-recovery-hardening-20260915
BASE=b41e8945786cd5821e7adb45695fb6b271849336
BUNDLE=/chemin/absolu/vers/context-room-pr42-final.bundle
DELIVERY=/chemin/absolu/vers/le/zip-extrait/livraison
EXPECTED_HEAD=$(cat "$DELIVERY/SOURCE_COMMIT")

git cat-file -e "$BASE^{commit}"
test -z "$(git status --porcelain)" || exit 1
git bundle verify "$BUNDLE"
git fetch "$BUNDLE" "refs/heads/$BRANCH"
test "$(git rev-parse FETCH_HEAD)" = "$EXPECTED_HEAD"
# Vérification isolée, sans déplacer la branche ni fusionner :
git switch --detach FETCH_HEAD
test "$(git rev-parse HEAD)" = "$EXPECTED_HEAD"
git fsck --full
```

L’avance de la branche existante se fera ensuite uniquement en avance rapide et
après contrôle de non-divergence. Une restauration ne fusionne pas la PR.
Les empreintes globales du ZIP et du bundle sont dans le `SHA256SUMS` externe ;
`livraison/FILES-SHA256.json` lie chaque fichier source à son mode et son blob Git.
Le reçu de restauration précise le prérequis, le HEAD et l’arbre reconstruits.

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

## 4. Résultats terminaux disponibles — ne pas les cumuler en CI verte

Les journaux fournis ne portent pas tous le SHA en interne. Leur attribution aux
commits ci-dessous vient du relais conservé et du tour précédent ; les résumés
terminaux sont, eux, relus dans les fichiers. Le reçu liste les empreintes des
originaux et des copies assainies, sans modifier les erreurs ou assertions.

| Référence | Entrée / preuve | Résultat et portée |
| --- | --- | --- |
| E01 | CI b41 : 34966764884 ; convergence : 34966764731 | Succès historiques propres à **b41**. Soak et quatre navigateurs compris ; jamais attribués aux commits locaux suivants. |
| E02 | `preuves/npm-test-0b932ab.log` ; campagne associée à **0b932ab**, `umask 022`, Node 22.16.0 / Python 3.13.5 | **101/102 processus**, échec global. Le fichier termine bien par ce total ; le code de sortie 1 est consigné dans le relais précédent. |
| E03 | `preuves/baseline-ssh-prerequisite.log` | Même cas exécuté à b41 inchangé : **0/1**, même erreur `ssh-keygen is required to create the restricted agent credential`. Le blocage n’est pas une réussite. |
| E04 | `preuves/mac-installation-cli-fixed.log`, associé à **22b998d** | **4/4**, dont vrai parcours CLI preview/apply/verify/repeat. Preuve ciblée, pas une nouvelle suite complète. |
| E05 | `preuves/shared-writer-red.log` puis `preuves/shared-writer-green.log` | **0/2 avant**, **2/2 après** le correctif Shared transmis. Les deux sources sont maintenant identiques à celles récupérées ; tests non rejoués pour le seul empaquetage. |
| E06 | Campagne `umask 022; CI=1 npm test` annoncée à **36e8180** | **Résultat terminal non récupéré.** Aucun processus actif ni journal terminal correspondant dans les fichiers restaurés. Pas de relance ; pas de total final déduit des étapes intermédiaires. |
| E07 | Navigateur PCM et Gradle, selon relais précédent | `ERR_BLOCKED_BY_ADMINISTRATOR` avant scénario ; Gradle 8.11.1 absent du cache / résolution DNS impossible avant compilation. Journaux bruts non conservés dans les entrées actuelles. Non réessayés. |
| E08 | Contrôles du présent regroupement | Identité des sources, restauration bundle, inventaire, absence de fichiers privés interdits, confidentialité du package et packaging à blanc : résultats exacts dans `livraison/VALIDATION.json` et reçu externe. Ce ne sont pas des tests métier. |

Dans E02, le cas de configuration de sécurité Shared
`GitHub security setup installs and verifies a no-bypass pull-request ruleset`
(`test/shared_context.test.mjs:401`) échoue avant ses assertions à cause
d’OpenSSH absent. Le shard concerné est à **40/41** ; les autres processus
réussis ne changent pas le statut global. Aucun skip ou remplacement de clé,
assouplissement de droits, retrait d’assertion ou requalification en intermittence.

La vérification actuelle des archives ne recrée pas le résultat de la campagne
36e8180. Les sept lots initiaux disposent d’E02 ; la correction du script Mac
d’E04 ; le correctif Shared d’E05. Cet ensemble reste une **preuve composée et
partielle**, avec un échec enregistré et sans terminal complet pour les derniers
changements Shared. E02 passe notamment la réconciliation/cache/PCM/bascule,
mais ne couvre pas le garde Shared ajouté ensuite.

Les succès de `doctor`, du package et des compilations en mémoire rapportés avant
ce regroupement sont des preuves historiques ; leurs journaux détaillés ne sont
pas présents. Le doctor négatif sur un rétrécissement de `startupSkills` reste
signalé comme refus correct, jamais contourné. Les contrôles de package réalisés
ici sont identifiés séparément et ne démarrent aucun projet, agent ou service.

Le processus d’empaquetage n’exécute ni `npm test`, ni navigateur, ni OpenSSH,
ni Gradle. Une unique lecture Git HTTPS a échoué sur la résolution de nom ; la
base exacte a été vérifiée avec l’archive CI déjà disponible et les métadonnées
publiques lues via le connecteur autorisé. Aucun accès refusé n’a été contourné.

À reprendre uniquement dans un environnement où le vrai prérequis est disponible :

```sh
umask 022
node --test \
  --test-name-pattern='^GitHub security setup installs and verifies a no-bypass pull-request ruleset$' \
  test/shared_context.test.mjs
```

Les tests ciblés ne sont à répéter qu’après correction affectant leurs entrées.
Une campagne complète sur le HEAD livré reste une preuve manquante ; obtenir
son terminal sur l’environnement autorisé, sans effacer les résultats E02/E03.

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

Production Java/Gradle et les huit assets embarqués restent inchangés depuis b41.
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
- Comparaison des huit assets production avec les fichiers livrés : identique, recontrôlée lors du regroupement. Le reçu de distribution contient leurs empreintes.
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

## 7. Exigences initiales ouvertes, vérifications et limites hors périmètre

Le classement se réfère aux travaux A–G et aux matrices C/R/V du cadrage initial.
Une fonction volontairement refusée avec conservation des originaux n’est pas
un succès ; une extension qui n’était pas demandée n’est pas ajoutée aux critères.

### 7.1 Logiciel demandé encore absent ou partiel

| Cadrage | État exact non terminé |
| --- | --- |
| C ; C02/C08, R28, V06/V14 | Le rapprochement **complet des reçus de jobs/frames de dessin progressif** n’est pas implémenté. Ils sont conservés et bloquent l’application de file ; la copie explicite du cache ne prouve pas leur livraison. |
| F ; V07/V17 | Aucune amélioration dédiée et mesurée de la partie applicative du délai de **premier résultat utile avec vrai agent** n’a été livrée dans cette continuation. Les références restent 13,402 s et 14,189 s pour une cible de dix secondes. Ce n’est pas seulement une mesure BOOX manquante. |
| E ; C01, V02/V14 | La livraison Mac se limite au **générateur de kit, aux contrôles d’intégrité, au plist inerte et à la procédure locale**. Ce n’est pas un parcours installé/activé de bout en bout. L’installation cohérente ne peut être déclarée terminée ; la disponibilité et les effets réels macOS relèvent aussi de 7.2. Un auto-updater n’est pas une exigence implicite ajoutée. |

La réconciliation ordinaire create/metadata/asset/mutate/delete/undo, la copie
explicite du cache, les anciens transferts, les liens PCM et le coordinateur de
bascule standard **sont implémentés**. Leurs tests partiels et refus documentés ne
permettent toutefois pas de clôturer la migration intégrale V14.

### 7.2 Code présent, preuves seulement non obtenues

| Périmètre | Vérification restant réellement à faire |
| --- | --- |
| A/G, V09/V19 | Cas sécurité Shared avec vrai OpenSSH ; terminal complet des derniers changements Shared et de la livraison. E02 reste en échec. |
| D/F, C03/C05, V04/V10/V16 | Nouveau parcours PCM dans les quatre navigateurs : sélection/revue, association à la bonne source, changement de conversation, absence d’autoplay/envoi, export exact, captures et accessibilité. |
| E, C01/R01/V02 | Installation neuve effective sans Lisière, dépendances locales, unicité du Hub, plist/launchctl, arrêt/redémarrage et reboot. Le kit seul ne prouve pas cela. |
| E, R28/V14 | Adaptateur Darwin : arrêt du service standard, `lsof`, `renamex_np(RENAME_EXCL)`, interruption/reprise et pause/reprise sur compte Mac synthétique. Les contrats Linux ne sont pas une preuve Darwin. |
| G, C06/V04/V15/V19 | Compilation de la nouvelle classe d’instrumentation, puis exécution sur émulateur dédié, y compris PCM owner, compatibilité/mise à jour. APK b41 : baseline uniquement. |
| F, C02/C03, V07/V10/V17 | Fournisseur Codex authentifié, vrai modèle Whisper choisi, interruption/redirection et nouveaux temps. Aucun mock ne clôt cette preuve. |
| V18, C04/C06, V03/V05/V16/V17 | BOOX physique : pression, paume, latence, ghosting, micro/haut-parleur, interruption, Wi-Fi/veille-reprise, clavier/zoom et confort. **C’est bien dans le périmètre initial**, pas une limitation hors demande. |
| C08/V14 | Recette complète de remplacement avec données synthétiques représentatives. Aucune migration personnelle réalisée ou autorisée implicitement. |

### 7.3 Limites réelles à ne pas transformer en exigences nouvelles

- Le rollback livré **met en pause les écritures inscrites à la migration**, puis
  permet leur reprise révisionnée. Il ne réactive pas Lisière et ne réinjecte pas
  les nouvelles données dans son ancien format. Un inverseur bidirectionnel ou
  retour fonctionnel automatique avec fusion de tout le travail récent n’était
  pas explicitement exigé. La préservation du travail récent, elle, l’était.
- La bascule reconnaît le service et le workspace Lisière standards. Les
  déploiements personnalisés non spécifiés, writers déplacés/manuels et réparations
  automatiques de barrières inconnues ou remplacées ne sont pas pris en charge.
  Ils échouent en sécurité ; aucune couverture exhaustive de ces variantes n’est
  revendiquée. Cela n’efface pas la recette de l’installation standard à faire.
- Un utilisateur local privilégié peut modifier la barrière ou démarrer ailleurs
  un writer non inscrit. Le coordinateur n’est pas une isolation contre
  l’administrateur du Mac.
- Un installateur silencieux, un auto-updater générique ou une distribution
  notarialisée universelle ne sont pas des livrables explicitement demandés.
- Le mode tablette complet **requiert le service Mac connecté**. Le fonctionnement
  autonome sans Mac, une Inbox/bibliothèque séparée, un éditeur Office, un serveur
  hébergé obligatoire et une API de transcription payante de remplacement sont
  hors demande ou contraires au cadrage ; aucune de ces fonctions n’a été ajoutée.
- Dépassements de bornes, schémas inconnus et assets manquants produisent un refus
  explicite avec conservation des sources, pas une réparation supposée ni une
  conversion universelle de formats futurs.

## 8. Fichiers nouveaux dans les lots logiciels


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
test/shared_writer_authority.test.mjs
```

Les sources complètes incluent ces fichiers et les propriétaires canoniques
modifiés. Aucun dépôt Lisière complet, son historique Git, fichier de signature,
node_modules, base réelle, enregistrement personnel ou credential n’est inclus.
Les références privées consultées servent seulement à comprendre le contrat du
format d’origine ; elles ne sont pas nécessaires pour exécuter les tests fournis.
