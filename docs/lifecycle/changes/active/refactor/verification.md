---
context_room:
  id: lifecycle.refactor.verification
  depends_on:
    - lifecycle.refactor.cadrage
    - lifecycle.refactor.architecture
---

# Vérification du cadrage et du refactor

## Summary

Ce registre relie les exigences du grill me aux scénarios testés dans cette branche. Les preuves automatiques et navigateur portent sur des projets temporaires ; elles ne valent pas une installation distribuée ou une vérification physique de la tablette.

## Defines

La couverture de vérification, la baseline et les résultats observés du chantier.

## Does not define

Le fonctionnement souhaité, dont le [cadrage](cadrage.md) reste le propriétaire.

## Baseline observée

| Vérification | Résultat |
| --- | --- |
| État Git avant travail | Propre, base `5a2bcab`, package 0.6.17 |
| Route documentaire | Configuration locale ; `docs/` déjà surveillé, aucun rattachement Shared dans cette configuration |
| Dépendances avant préparation | Absentes : le CLI échouait au chargement du module YAML |
| Installation `npm ci` | Réussie ; vulnérabilité haute transitive dans `fast-uri` de la base, corrigée ensuite par mise à jour ciblée |
| Découverte CLI documentaire | Réussie après installation ; recherche et inspection déterministes disponibles |
| Recherche acceptée sur review/proposals | Exécutée, aucun résultat pour la requête ; les sources locales ont été inspectées directement |
| Suite `npm test` de base | 57/60 processus réussis ; deux dépassements de budget de performance (377 ms, 1 015 ms) et un sous-processus de lease expiré après 15 s |
| Doctor de base | Exit 0, Context Room OK ; 11 informations de faible sévérité sur le Startup local |
| Réalisation cible | Non vérifiée à cette étape |

## Matrice de scénarios

| Preuve | Exigences | Scénario minimal et résultat attendu | État |
| --- | --- | --- | --- |
| V01 | R01–R03 | Installation Mac propre, ouverture globale, deux projets et deux worktrees, sélection exacte et retour global | Contrats Hub/worktrees testés ; nouvelle installation distribuée non effectuée |
| V02 | R03–R04 | Emplacement absent, dossier renommé, navigation Computer : aucune inscription ni substitution implicite | Tests Hub, identité de projet et Explorer ; aucune donnée utilisateur déplacée |
| V03 | R04, R13–R14 | Création, édition, renommage, déplacement, duplication et suppression récupérable ; collisions bloquées, lien légitime navigable ; sortie de périmètre et substitution de cible bloquées | Tests Explorer/révisions et récupération ; opérations sur fixtures |
| V04 | R05–R06 | Hub global/projet, raccourcis, Startup avec provenance ; problème résolu retiré de Health | Tests settings, Startup, Hub et Health ; correction humaine Startup vérifiée par HTTP |
| V05 | R07, R18 | Fichier accepté modifié par agent : lecture normale renvoie seulement l'accepté ; nouveau fichier non accepté non divulgué | Tests corpus accepté et baselines historiques réussis ; nouveau document exclu de begin |
| V06 | R08–R09 | Correction humaine enregistrée : seule cette version du fichier est acceptée ; autres fichiers et modifications suivantes restent en review | Tests workflow/HTTP et navigateur ; Markdown, Startup et image Shared |
| V07 | R10, R12 | Projet sans Git : créer deux espaces de préparation complets, éditer indépendamment, soumettre ; aucun original changé avant application | Tests sans Git et mesure sur 512 documents ; deux arbres indépendants |
| V08 | R10–R12 | Refuser une proposition isolée laisse les originaux inchangés ; accepter applique exactement le manifeste revu | Tests application exacte, refus local et navigateur ; Shared conserve sa décision finale |
| V09 | R11–R14 | Deux propositions touchent le même fichier, puis modification externe : conflit explicite, aucune perte de travail | Tests conflits, fichier externe, index Git, mode et révision |
| V10 | R13–R14 | Changement direct pendant arrêt ; détection au démarrage ; refus modifié/nouveau/supprimé/renommé restaure sans écrasement récent | Tests workflow sans Git : modifié, nouveau, supprimé, renommé et révision périmée |
| V11 | R10–R14, R28 | Interruption à chaque étape d'application multi-fichier ; reprise idempotente ou récupération annoncée | Tests journaux, interruption et reprise locale/Shared ; décisions locales par fichier |
| V12 | R11 | Deux clones Git et deux humains simulés dans un dépôt temporaire : soumission, review périmée, conflit, acceptation exacte, rejet, reprise réseau | Suite Shared sur vrais dépôts Git temporaires : quatre tranches réussies, puis contrôles ciblés après optimisation |
| V13 | R15 | Aucune expiration par défaut ; refus ponctuel âge/projet ; règle humaine exacte, jamais activable via réglage agent ordinaire | Tests cleanup et intégration de refus automatique réel ; aperçu UI vide vérifié |
| V14 | R15 | Révision modifiée après sélection ou règle, brouillon encore actif, Shared hors ligne : aucun refus périmé ni réussite fictive | Tests révision, âge, politique signée et erreur partielle ; pas de succès fictif |
| V15 | R16–R17, R26 | Harness générique utilisant CLI sans Codex ni modèle : help ciblé, projet résolu, recherche/lecture, begin/status/submit | Tests CLI/registre/recherche ; commandes génériques sans chercheur LLM |
| V16 | R18–R19 | Main change entre deux commandes ; seconde commande fraîche, diff limité aux docs lus ; deux lecteurs génériques sans commande initiale, jeton repris et absent ; mode hors ligne explicite | Tests snapshots/lecteurs ; fraîcheur Shared et cache hors ligne explicites |
| V17 | R20 | Deux projets du même Shared avec skills différents ; seuls les contenus acceptés associés sont exposés | Tests Shared des affectations par projet et providers facultatifs |
| V18 | R06, R21 | Docs sans front matter ni structure imposée ; liens navigables ; dépendance modifiée sans ajout automatique de review | Tests docs sans front matter, liens et retrait des alertes de dépendance |
| V19 | R22–R23 | Markdown, Mermaid, HTML et ressources : rendu inspecté, modifications visibles, aucun code/éditeur HTML dans la surface humaine | Navigateur : correction Markdown, HTML rendu sans textarea et Mermaid modifié |
| V20 | R22, R24 | Image avant/après, dessin humain, annuler/rétablir, rechargement ; conservation de l'original et de la source éditable selon format | Navigateur : PNG local et Shared, dessin, undo/redo ; conservation des octets avant décision |
| V21 | R22 | Matrice des formats vérifiée ; un format non éditable est explicitement limité, pas présenté comme un éditeur intégré fonctionnel | Matrice explicite dans document-workflow.md ; édition bureautique non implémentée |
| V22 | R25 | Sans Lisière : tous les parcours principaux fonctionnent ; avec extension : dessin exact, reçu Mac et résultat tablette distingués | 3 tests de contrat et aller-retour avec le vrai compagnon isolé ; BOOX non vérifié |
| V23 | R27–R28 | Migration réaliste de 0.6.17, deuxième exécution sans effet, panne puis reprise, baselines/drafts/Hub/skills conservés | 3 tests migration : sauvegarde exacte, idempotence et interruption ; anciens états conservés |
| V24 | R27 | Inventaire des imports, commandes, routes et packages : aucun chercheur LLM ou profil hébergé actif restant après retrait | Tests runtime local, CLI et package ; surfaces hébergées retirées, compatibilité interne inactive documentée |
| V25 | R17–R18 | Questions documentaires représentatives avec réponses attendues ; mesurer couverture, erreurs, tokens, commandes et latence | 4 requêtes représentatives réussies sur petit corpus ; latence mesurée, pas de preuve de réduction universelle de tokens |
| V26 | R12, R28 | Plusieurs propositions sur grand corpus : coût disque réel, temps de préparation, indépendance des octets et reprise | 512 documents / 14,86 Mo ; 513 objets après une modification ; partage physique APFS non mesuré |
| V27 | R02–R06, R08 | Parcours navigateur complets, navigation clavier, chargement/conflit/récupération, absence d'erreur console | 2 parcours Chromium + audit axe des nouvelles fenêtres ; inspection visuelle et absence d’erreur console |
| V28 | R28–R29 | Relecture du diff, documentation courante alignée, tests obligatoires, package sans données privées | Audit documentaire sans anomalie, doctor et package OK ; résultats des reprises ci-dessous |

## Méthode

Commencer par les tests du contrat modifié. Utiliser de vrais fichiers et dépôts temporaires pour les mécanismes de stockage et Git. Une simulation d'interface peut compléter mais ne remplace pas la lecture des octets, reçus et refs après l'action. Ne pas toucher aux données utilisateur pour prouver un refus ou une migration.

La recherche est évaluée sur des questions dont les sections attendues sont connues, notamment des informations réparties entre plusieurs documents et des réponses absentes. La réduction de tokens ne justifie pas l'omission d'une information critique. Aucun seuil arbitraire d'édition de fichiers ou de dessin n'est qualifié de validé sans mesure.

Les vérifications de repository incluent `npm test` et `node bin/context-room.mjs doctor --root .`. Les changements de package incluent `npm run package:privacy` et `npm pack --dry-run`. Les scripts navigateur pertinents couvrent layout, smoke, accessibilité et performance selon le périmètre réellement modifié. Les résultats sont séparés entre code local, navigateur, package, installation et appareil physique.

## Tenue des preuves

Conserver les journaux complets dans un espace temporaire privé pendant les essais. Inscrire ici les commandes réellement exécutées, résultats, limites et observations utiles ; ne pas incorporer de données privées ou de transcriptions dans le repository. Un fichier de test présent n'est pas une preuve qu'il a été exécuté.

## Preuves de réalisation

Les tests dédiés se trouvent dans `test/documentation.test.mjs`, `test/documentation_readers.test.mjs`, `test/local_proposals.test.mjs`, `test/documentation_workflow.test.mjs`, `test/document_assets.test.mjs`, `test/review_cleanup.test.mjs`, `test/state_migration.test.mjs` et `test/lisiere_connector.test.mjs`. Les suites existantes restent responsables du Hub, d’Explorer, de Startup, de Git et de l’autorité de review.

- `node --test test/documentation_workflow.test.mjs` : 11 tests réussis, dont sauvegarde Startup protégée par l’autorité humaine, version périmée et changement du mode d’un fichier.
- `test/e2e/local-proposals.spec.mjs`, exécuté avec un serveur et une configuration isolés : deux parcours Chromium. Markdown corrigé, HTML rendu puis refusé, Mermaid modifié, PNG dessiné avec undo/redo, cleanup et image Shared. Le main Shared est contrôlé inchangé avant la décision finale. Audit axe WCAG A/AA sur les nouvelles fenêtres, aucune erreur console.
- Lisière : trois tests de contrat, puis aller-retour avec le vrai CLI et un compagnon TLS isolé. Projet, carnet, image et objets éditables récupérés à révision stable. Aucun projet réel ni tablette utilisé pour cette preuve.
- Migration : plan lié à une révision exacte, copie des octets de contrôle, refus d’un plan périmé, deuxième application sans duplication et reprise d’un journal interrompu.
- `doctor --root .` : Context Room OK ; informations de faible sévérité liées au Startup de cette machine. `package:privacy` et `npm pack --dry-run` réussis : 93 fichiers, sans données privées.

### Passes de développement et reprises

La troisième passe globale de développement de `npm test` a réussi 53 des 57 processus. Les quatre échecs ont été traités sans assouplir les assertions : fixtures de proposition encore basées sur une simple baseline, maintien du refus UTF-8 invalide pour le texte tout en autorisant les images, et budget de latence Shared.

| Vérification après correction | Résultat |
| --- | --- |
| Suite CLI complète | 19/19 tests réussis |
| Suite serveur complète, environnement isolé | 226/226 réussis |
| Suite d’intégrité complète | 52/52 réussis |
| Corpus accepté, workflow et surfaces en lecture seule | 24/24 réussis |
| Sélection/révision globale après ajout du mode de fichier | 3/3 réussis |
| Review Shared de 80 fichiers par HTTP | 869 ms, sous le seuil inchangé de 900 ms ; preuves et 80 événements persistés |
| Shared après optimisation : préflight, rollback, copie, modes, dépendances, images et décisions concurrentes | 8/8 tests réussis |
| Navigateur Chromium et axe après optimisation | 2/2 parcours réussis, aucune erreur console |

Les reprises serveur exécutées pendant la charge concurrente avaient aussi rencontré deux délais dépassés ; les deux tests passent dans la suite isolée sans changement de leur seuil. L’optimisation Shared réutilise les mêmes octets déjà lus dans la transaction pour l’index et les dépendances ; les contrôles avant/après, les écritures de preuve et le contrôle final restent actifs.

Ces reprises ne transforment pas la troisième passe en succès. La publication impose une nouvelle exécution complète de `npm test`, puis les contrôles GitHub sur le commit proposé : versions Node, navigateurs, accessibilité et navigation prolongée. Les résultats de cette passe finale et des contrôles de publication sont consignés dans la PR associée, avec leurs limites.

### Corpus et stockage

Une mesure du moteur local sur 512 documents (14 855 570 octets) a donné 2 629 ms pour le premier espace, 257 ms pour le second et 180 ms pour la soumission d’un fichier changé. Les deux propositions utilisent 512 objets de base ; une modification ajoute un seul objet, soit 513 au total. Le fichier source et l’autre proposition restent identiques à leur base, avec des fichiers modifiables indépendants.

Cette mesure a été faite pendant les autres tests ; ce n’est pas un budget de performance garanti. Le décompte porte sur les objets, pas sur les extents physiques APFS. La copie à l’écriture dépend du système de fichiers et un fallback de copie existe.

### Qualité des lectures

Un petit corpus accepté a servi à quatre requêtes avec chemin attendu ou réponse absente. Les quatre ont réussi ; une modification non acceptée n’a pas remplacé la réponse validée. Construction : 62,76 ms ; recherche en corpus chaud : 0,04 à 0,59 ms. Les tailles de sortie sont mesurées en caractères. Aucune mesure de tokenizer réel, aucun gain global de tokens ni qualité sémantique universelle n’est revendiqué.

### Périmètre des preuves

L’édition intégrée concerne le texte et les dessins raster annoncés. PDF et documents Office restent des ressources binaires à accepter/refuser, avec une limite affichée ; ils ne disposent pas d’un éditeur intégré. Lisière ne fournit pas encore une commande d’ouverture automatique d’un carnet sur la tablette ; l’interface indique quel carnet ouvrir. La preuve physique BOOX reste distincte.

Le package reste en version 0.6.17 ; la publication demandée porte sur GitHub `main`. Aucune release npm, installation de distribution ou validation des documents réels de l’utilisateur n’est incluse.
