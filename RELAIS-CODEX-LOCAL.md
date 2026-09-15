## Summary

Relais d'exécution pour la branche de finalisation de Context Room, après la
fusion de la convergence initiale. Les changements livrés sont du code intégré ;
la migration complète et le remplacement à 100 % ne sont pas déclarés terminés.

## Defines

La base publique, les modifications conservées, les preuves déjà obtenues,
les commandes restantes et les frontières entre code portable encore manquant,
émulateur, fournisseur réel et BOOX physique.

## Does not define

Une autorisation de fusion, publication, installation personnelle, modification
d'appairages ou migration de données privées. La review Git et l'acceptation
documentaire humaine restent distinctes.

# Relais Codex local — 15 septembre 2026

## Base et HEAD

Base publique : `1a2cdcec1435d60cd8d07a3762a369e066508ce1`.
Branche : `mathis/context-room-recovery-hardening-20260915`.
PR de revue : `blancmathis/context-room#42` ; aucune fusion automatique.
Checkpoint du code et des tests : `98c437035970344e9b44d6e857d81bafd0dbcc2e`.
Le HEAD exact de livraison est le commit contenant ce relais, indiqué dans la PR
et dans `SOURCE_COMMIT` des artefacts CI. Vérifier cet identifiant avant tout test ;
un commit synthétique de merge CI peut avoir un SHA distinct et le même arbre.

```sh
umask 022
BASE=1a2cdcec1435d60cd8d07a3762a369e066508ce1
CODE_HEAD=98c437035970344e9b44d6e857d81bafd0dbcc2e
BRANCH=mathis/context-room-recovery-hardening-20260915
HEAD=$(git rev-parse HEAD)
git merge-base --is-ancestor "$BASE" "$HEAD"
git merge-base --is-ancestor "$CODE_HEAD" "$HEAD"
git status --short
git log --oneline "$BASE..$HEAD"
```

Travailler dans un clone/worktree dédié. Ne pas réinitialiser un arbre contenant
un travail récent. Le bundle éventuel ne contient que les nouveaux commits et
nécessite les objets de la base publique ; `git bundle verify` doit réussir après
récupération de cette base. L'archive de sources ne doit pas inclure node_modules,
les clés preview/personnelles, les bases, les enregistrements ou l'historique privé.

## Changements conservés

`7af7f0c…` : `migrate --export-lisiere` accepte un ZIP natif Android v1 et produit
un snapshot v3. Les formats de dossier v1/v2 restent lisibles. Les originaux,
les dérivés Android, les identités int64 et les PCM sont conservés ; le dossier
temporaire n'entre pas dans l'identité preview/apply. SQLite travaille sur une
copie privée, avec WAL/journal. La publication reprend seulement un préfixe exact,
sans écrasement ni lien physique persistant après interruption.

`21f2ed0…` : application explicite du mode examiné sur le nouveau descripteur de
fichier. Le bug 0644→0600 / 0755→0700 sous umask 077 a été reproduit avant correction.
Les contrôles de révision, origine et modification concurrente de permissions sont
conservés.

`9f74529…`, `8b6f0e7…` et `98c4370…` : le connecteur de dessin utilise les carnets
natifs, sans exécutable/service Lisière. Le parcours PNG demande une destination
éditable, conserve une scène figée et ne l'accepte que par la décision humaine
existante. La récupération des anciens transferts permet un choix explicite
source/aperçu/objets, conserve les tombstones et refuse les assets/révisions
inconnus. Les diagnostics audio vérifient les dépendances locales, sans installation
ni inférence. Des tests CLI et un scénario navigateur réel couvrent les nouvelles
entrées ; leurs résultats doivent être lus sur le HEAD de livraison.

Fichiers nouveaux :

```
src/lisiere_android_export.py
src/local_audio_diagnostics.mjs
src/ui/native-drawing.mjs
test/lisiere_android_export.test.mjs
test/python/lisiere_android_export_test.py
test/local_proposal_permissions.test.mjs
test/local_audio_diagnostics.test.mjs
test/native_recovery_cli.test.mjs
RELAIS-CODEX-LOCAL.md
```

Fichiers existants modifiés : snapshot Python/Node et lecteur/inventaire associé,
connecteur Lisière, CLI/registry, application serveur, moteur Local de propositions,
rendu SVG, UI de review PNG, runtime/audio locaux, tests de connecteur et de snapshot,
scénario `test/e2e/notebooks.spec.mjs`, propriétaires documentaires de migration,
workflow documentaire, conversations, runtime et journal de vérification.
`git diff --name-status "$BASE" "$HEAD"` donne la liste exhaustive du commit reçu.

## Preuves déjà obtenues — ne pas les répéter sur des entrées inchangées

Le journal canonique est
`docs/lifecycle/changes/active/android-convergence/verification.md`, section
« post-merge native runtime delivery », avec toutes les lignes C01–C08/R01–R29/V01–V19.

Le premier checkpoint `7af7f0c…` a passé les trois jobs Node 20/22.23/24 et les
quatre jobs navigateur de la CI **34949046038**, avec les contrôles package du
job Node 22. Le Soak n'est pas vert : la navigation prolongée a passé, mais la
seconde fenêtre du scénario temporel échoue sur l'expansion de `notes`.
L'ancien échec « slow project activation » n'a pas été reproduit par ce run ;
aucune correction ou intermittence n'en est déduite.

Dans le clone isolé, avec Node 26.3.1/Python 3.14.6 et umask 022 : 18 tests Python
ZIP, 9 tests Python snapshot historiques, puis **40/40** tests Node ciblés sur
les fichiers ci-dessous ont passé. Ce dernier total couvre 8 contrats connecteur,
4 diagnostics audio, 7 contrats audio préexistants et 21 contrats Local de
propositions. Il n'inclut pas les deux nouveaux tests CLI ni le nouveau parcours
navigateur ; vérifier leur CI avant de les déclarer validés.

```sh
umask 022
node --test --test-concurrency=1 \
  test/lisiere_connector.test.mjs test/local_proposal_permissions.test.mjs \
  test/local_proposals.test.mjs test/local_proposal_initial.test.mjs \
  test/local_audio_diagnostics.test.mjs test/local_audio.test.mjs \
  test/assistant_audio.test.mjs
```

L'installation npm locale a été interrompue et a laissé `yaml/index.js` absent.
Des chargements de suites HTTP/CLI ont donc échoué avant leurs tests ; ce n'est pas
une preuve de défaut produit ni d'effet umask. La régression macOS initiale complète
et le cas Shared 0755/0700 restent à établir dans une installation complète.
Une lecture privée et une analyse de trace ont été bloquées par les contrôles de
la session Web ; elles n'ont pas été contournées. Aucun contenu privé n'a été publié.

## Validation portable restante sur le HEAD reçu

Utiliser une version Node prise en charge, de préférence celle de la CI, et une
installation neuve dans le clone dédié. Lire d'abord le statut final de ses jobs,
pour ne pas répéter tous les tests déjà verts sur les mêmes entrées.

```sh
umask 022
npm ci
npm test
node bin/context-room.mjs doctor
node bin/context-room.mjs doctor --format json
npm run package:privacy
npm pack --dry-run
```

Le nouveau test CLI exécute réellement `doctor` et la récupération des transferts,
dans des dossiers synthétiques et sans companion. Pour un échec circonscrit :

```sh
node --test test/native_recovery_cli.test.mjs test/lisiere_android_export.test.mjs
npx playwright test test/e2e/notebooks.spec.mjs --project=chromium-desktop \
  --grep 'PNG review uses native editable source'
npx playwright test test/e2e/ux-endurance.spec.mjs --project=chromium-desktop \
  --grep '@soak time-dependent reviews, drafts, and shared reconnect safely'
```

Ne pas lancer à nouveau les quinze minutes de navigation pour examiner seulement
l'échec de la seconde fenêtre. Conserver capture de cette seconde page, requêtes
ciblées, projet/worktree sélectionné, erreurs, état de génération du catalogue et
réponses Explorer. Résoudre le défaut ou démontrer la fixture incorrecte sans
supprimer l'assertion d'expansion ni augmenter le budget de latence arbitrairement.

Le nouveau scénario PNG vérifie : scène native réelle, source éditable non acceptée,
PNG aux dimensions d'origine, conservation d'un geste ultérieur dans la scène mais
exclusion de ce geste des octets examinés puis acceptés. Inspecter sa capture ; un
sous-test module ou une seule image ne valide pas tous les formats/écrans.

## Développement portable encore manquant — pas un blocage BOOX

La réconciliation Android/Mac des opérations en attente n'est pas implémentée.
Reprendre explicitement `board.create`, `board.metadata`, `asset.put`, `board.mutate`,
les suppressions/annulations, carnets libres et frames progressives. Une identité
seule ne prouve rien : lier contenu et reçu Mac, préserver les chaînes de révisions
ajustées par la file d'origine, produire la correspondance global→objet, et conserver
les cas inconnus dans une récupération exploitable. Le contrôle Float/Double du
ZIP est un round-trip typé, pas la preuve d'une sérialisation wire unique ; ne pas
l'utiliser pour fabriquer un acquittement. Tester perte de réponse, doublons,
révisions périmées, conflits, gros binaires, reprise et idempotence.

Le rattachement explicite des PCM à un document/conversation reste à développer.
L'inventaire conserve `context: unassigned`. Il faut une sélection/revue et une
preuve de lien ; aucun contexte ne doit être déduit du nom haché.

La bascule versionnée vers un seul système d'écriture et le rollback complet
restent à terminer. Préserver configuration, Hub, propositions et états acceptés,
ainsi que les éditions nouvelles. Ne jamais relancer automatiquement une file
ancienne incertaine. Les journaux de snapshots/transferts ne constituent pas à eux
seuls une transaction de migration de tout le système.

L'installation Mac complète n'est pas réalisée ici. Les diagnostics existent ;
vérifier l'installation propre, les chemins de l'exécutable et du modèle, puis une
reconnaissance locale réelle. Aucun téléchargement ou remplacement payant n'est
silencieusement déclenché. Les sources Android et leurs protections de protocole
n'ont pas changé dans ce lot ; aucune nouvelle protection native d'upgrade n'est
prétendue.

## Android : build, artefacts et portée des anciens essais

Aucun Java, ressource Android, Gradle ou bridge embarqué n'a été modifié. Le rendu
SVG et la UI PNG servie par le Mac ont changé : les anciens essais owner-WebView
ne couvrent pas ce nouveau parcours. Les preuves natives antérieures restent
historiques pour leurs sources inchangées, pas une validation de la livraison.

Le workflow existant **Convergence verification** compile le preview et les tests
d'instrumentation sur JDK 17/SDK 35 quand cette PR modifie les sources notebook.
Son artefact preview contient le commit source et les empreintes. Récupérer
`SOURCE_COMMIT`, `SHA256SUMS` et le rapport du vérificateur depuis le run correspondant
au HEAD. Aucun nouveau hash APK local n'est enregistré à ce checkpoint : ne pas
réutiliser un ancien APK pour couvrir une source différente.

Pour reconstruire sans installer :

```sh
umask 022
# JAVA_HOME doit désigner un JDK 17 existant ; ANDROID_HOME un SDK avec
# platform-tools, platforms/android-35 et build-tools/35.0.0.
java -version
scripts/build-android.sh
python3 scripts/check-android-artifact.py \
  --apk android/app/build/outputs/apk/debug/app-debug.apk
shasum -a 256 android/app/build/outputs/apk/debug/app-debug.apk
```

Le script utilise sa clé **preview** locale non personnelle, et produit aussi
`android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk`.
Le vérificateur contrôle identité preview, signature v2, permissions, absence de
clé incluse et huit assets partagés exacts. Cela ne lance pas l'APK.

La variante récupération exige un APK original et un versionCode strictement
supérieur, avec la même identité/signature. Commande uniquement après accord
local et présence de la vraie clé sur le Mac, sans transfert ni secret CI :

```sh
scripts/build-android-recovery.sh "$ORIGINAL_APK_ABSOLUTE" "$HIGHER_VERSION_CODE"
python3 scripts/check-android-artifact.py \
  --apk android/.local/legacy-recovery-build/app/outputs/apk/debug/app-debug.apk \
  --upgrade-from "$ORIGINAL_APK_ABSOLUTE"
```

Un refus de signature/version n'autorise jamais désinstallation, downgrade,
effacement ou copie de la clé vers ChatGPT/GitHub.

## Émulateur dédié : à autoriser et exécuter localement

Ces commandes installent/interagissent avec des APK. Elles n'ont pas été exécutées
dans cette session. Obtenir l'autorisation avant exécution. Utiliser un émulateur
jetable `emulator-*`, AVD `ContextRoom_*`, jamais un appareil/émulateur personnel,
et un répertoire de preuve privé nouveau hors dépôt. Le vérificateur de récupération
refuse les autres identités et dispose de reprises explicites.

```sh
case "$SERIAL" in emulator-*) ;; *) echo 'Émulateur dédié requis' >&2; exit 1;; esac
python3 test/android/verify.py --serial "$SERIAL" --output "$PRIVATE_OUTPUT/core"
python3 test/android/verify-owner.py --serial "$SERIAL" --output "$PRIVATE_OUTPUT/owner"
python3 test/android/verify-owner.py --serial "$SERIAL" --output "$PRIVATE_OUTPUT/history" --history
python3 test/android/verify-owner.py --serial "$SERIAL" --output "$PRIVATE_OUTPUT/draft" --draft
python3 test/android/verify-legacy-upgrade.py --serial "$SERIAL" \
  --original-apk "$ORIGINAL_APK_ABSOLUTE" --output "$PRIVATE_OUTPUT/recovery"
```

Pour une interruption de récupération déjà amorcée, utiliser seulement le dossier
exact appartenant à la fixture et `--resume-from` ; pour un export natif réussi
restant à exploiter côté Mac, utiliser `--resume-export-from`. Ne pas inventer de
marqueur de réussite ou réensemencer un appareil pour obtenir du vert.

Sur l'owner-WebView, vérifier en plus le nouveau scénario PNG : destination explicite,
clavier/cibles, ouverture du carnet, dessin, retour à la review, scène figée, autre
édition concurrente, acceptation des seuls octets vus, permissions retirées, source
modifiée, rotation et reprise. Le test navigateur fourni prépare la logique ; il ne
remplace pas cette instrumentation/native UX.

## Fournisseur Codex et voix réels : preuves séparées

Aucun nouveau temps de génération authentifiée n'est annoncé. Les valeurs
historiques 13,402 et 14,189 secondes restent au-dessus de la cible de dix secondes.
Les dessins synthétiques/tests de rendu ne sont pas des mesures de génération.
Utiliser les fixtures prévues et une connexion Codex locale autorisée, sans
redémarrer Codex ou ChatGPT Desktop personnels ni reprendre une tâche historique.

```sh
python3 test/android/verify-agent.py --run --serial "$SERIAL" \
  --output "$PRIVATE_OUTPUT/agent" --codex-state "$APPROVED_CODEX_TEST_STATE"
python3 test/android/verify-observation.py --run --serial "$SERIAL" \
  --output "$PRIVATE_OUTPUT/observation" --codex-state "$APPROVED_CODEX_TEST_STATE"
python3 test/android/verify-dictation.py --run --serial "$SERIAL" \
  --output "$PRIVATE_OUTPUT/dictation" --model "$LOCAL_WHISPER_MODEL" \
  --sample "$SYNTHETIC_SPEECH_WAV"
python3 test/android/verify-audio.py --serial "$SERIAL" \
  --output "$PRIVATE_OUTPUT/audio" --native-pen
```

Mesurer demande utilisateur→premier résultat réellement utile, séparer attente
fournisseur, bridge, persistance et affichage, conserver interruption/redirection et
provenance. Le test de dictée avec audio synthétique ne valide pas un microphone
BOOX. Les chemins/états d'authentification restent privés hors dépôt.

## BOOX physique : aucune preuve remplacée par l'émulateur

Après autorisation d'installation/appairage spécifique, vérifier séparément pression,
paume, fidélité du trait et latence d'encre, ghosting et rafraîchissement, portrait/
paysage, zoom et lecteur d'écran, clavier/cibles en niveaux de gris, micro/haut-parleur,
interruption vocale, veille/reprise et coupure/reconnexion Wi-Fi. Tester les deux
modes tablette et conserver les gestes/brouillons en cours. Ces résultats sont
entièrement non vérifiés ici ; aucun des tests synthétiques, captures navigateur
ou builds ne valide V18.
