---
context_room:
  id: lifecycle.refactor.migration
  depends_on:
    - lifecycle.refactor.cadrage
    - lifecycle.refactor.architecture
---

# Migration et exécution du refactor

## Summary

Remplacer les comportements historiques par étapes exécutables. Préserver l'état utilisateur avant de retirer les anciens chemins, puis prouver les migrations et les parcours cibles. La branche de travail n'est ni une release ni une installation validée.

## Defines

L'ordre d'exécution, le traitement des capacités existantes et les conditions de retrait.

## Does not define

De nouvelles règles produit ou un résultat de tests ; consulter le [cadrage](cadrage.md) et la [vérification](verification.md).

## Baseline

Base inspectée : package 0.6.17, commit `5a2bcab`. Le checkout était propre avant la création de cette branche. Le monolithe principal comporte 48 345 lignes et le module Shared 11 148 lignes. Ces nombres sont un point de comparaison, pas un objectif arbitraire de réduction.

Les documents de ce projet sont locaux, surveillés sous `docs/`. Le dossier cible suit cette route locale et reste à la review humaine. Le profil de documentation de ce dépôt ne devient pas une contrainte imposée aux utilisateurs de Context Room.

## Matrice de transformation

| Surface actuelle | Traitement | Condition avant retrait de l'ancien chemin |
| --- | --- | --- |
| Hub, registre, projets/worktrees | Conserver les données, simplifier la résolution et les projections | Sélection, indisponibilité et retour global vérifiés |
| Explorer Projects/Computer | Conserver et uniformiser les opérations récupérables | Scopes et effets sur les reviews vérifiés |
| Baselines et review locale | Migrer vers ressources/version/décision explicites | Préservation du contenu accepté et des changements directs |
| Propositions Shared | Réutiliser les invariants Git et séparer le fournisseur | Concurrence, acceptation exacte et récupération prouvées |
| Édition locale directe par le workflow agent | Remplacer par préparation isolée ; conserver la détection extérieure | Nouvelle proposition locale et changement direct compatibles |
| Recherche et lecture déterministes | Conserver et découpler du chercheur | Corpus accepté, métadonnées facultatives, provenance et budgets |
| `ask` et processus documentaire LLM | Retirer du cœur et des interfaces publiques | Recherche/lecture utilisables sans modèle |
| CLI historique, alias, bundle imposé | Remplacer par domaines lisibles et contrat unique | Help, capabilities et dispatch concordants |
| Hosted Hub et hosted review | Retirer de la cible minimale et des packages actifs | Runtime local et Shared multi-machine via Git indépendants |
| Contrôle distant historique | Inventorier puis simplifier selon les usages retenus | Extension tablette préservée ; retrait motivé dans le lot concerné |
| Catégorie Shared instructions et projections natives obligatoires | Retirer le modèle spécifique ; préserver les fichiers utilisateurs | Contenu exportable/accessible comme documents ordinaires, sans supprimer de fichiers non gérés |
| Skills | Conserver les contenus, simplifier les associations par projet | Pas d'installation native obligatoire pour un harness |
| Prompt Center et intégrations propres aux anciens agents | Inventorier puis simplifier les consommateurs | Startup conserve l'inspection utile ; chaque retrait est un choix technique documenté |
| Graphes et dépendances | Conserver les liens utiles ; retirer les alertes de dépendance et la review transitive | Navigation existante fonctionnelle sur documents ordinaires |
| Health, doctor, guard et brief | Garder les services utiles, déterministes et partagés | Aucun diagnostic ne réintroduit de LLM ou de maintenance automatique |
| Générations de configuration | Migrer vers un contrat versionné unique | Anciennes options comprises et migration répétable sans perte |
| Formats et dessins | Étendre via capacités explicites | Rendu, édition et comparaison effectivement testés |
| Lisière | Extension facultative séparée | Aucun import, service ou appareil nécessaire au démarrage normal |

## Séquence de réalisation

1. **Cadrage et baseline.** Ranger les décisions, vérifier les liens et la couverture ; enregistrer tests, diagnostics et vulnérabilités de la base sans attribuer les échecs anciens au refactor.
2. **Noyau de ressources et versions.** Séparer chemins, octets, snapshots acceptés et changements ; tests sur fichiers temporaires, y compris sans Git.
3. **Propositions locales.** Brancher le workflow agent, le statut, la soumission et la review sur un espace isolé ; prouver application, refus et conflits avant de remplacer le chemin existant.
4. **Review unifiée.** Relier local et Shared aux mêmes états visibles, conserver la décision finale Shared exacte ; intégrer correction humaine et refus par sélection/règle autorisée.
5. **CLI et recherche.** Exposer les domaines cohérents, retirer le chercheur LLM et les commandes mortes, ajouter consultation acceptée et diffs par lecteur.
6. **Interface et formats.** Vérifier les parcours réels, HTML rendu seul, édition adaptée, dessin et navigation des documents existants.
7. **Retrait et migration finale.** Retirer les profils hébergés et dépendances inutiles seulement après examen de leurs consommateurs ; migrer les réglages et les états réels de test.
8. **Preuves et documentation courante.** Exécuter les scénarios, inspecter le rendu et les données, réécrire les propriétaires courants, puis clôturer les lots réellement terminés.

Un lot intégré reste soumis aux tests des contrats qu'il touche. Ne pas rendre les tests verts en supprimant une protection, en ignorant un échec ni en changeant un snapshot pour masquer une régression. Un test historique devient obsolète seulement lorsque son comportement a été explicitement remplacé.

## Migration et récupération

La migration inventorie projets, worktrees, chemins surveillés, baselines, décisions, propositions ouvertes, associations Shared/skills, Hub et préférences. Elle crée une sauvegarde avant modification, écrit un journal et publie un format versionné. Une seconde exécution sans changement n'a aucun effet supplémentaire. Une interruption conserve un chemin de reprise ou de restauration explicite.

Ne pas importer un statut `needs_changes`, une simple présence de fichier ou une donnée de récupération comme preuve d'acceptation. Les fichiers non reconnus et paramètres inconnus sont préservés dans le dossier de migration ; les éléments non migrables sont expliqués, pas supprimés. La désinstallation ou le retrait d'une projection ne touche que les ressources dont Context Room peut démontrer la propriété.

Les modifications distantes, le remplacement d'un projet, un chemin devenu lien symbolique, un index Git divergent ou un état source ambigu entraînent un conflit explicite. La récupération ne choisit jamais silencieusement le travail d'un auteur au détriment d'un autre.

## Conditions de fin

Le dossier de cadrage complet est une première étape, pas la fin de l'autorisation de refactor. Le chantier n'est terminé que lorsque les parcours obligatoires de [Vérification](verification.md) sont prouvés, les propriétaires courants correspondent au code et les limitations restantes sont explicites. Une compilation ou un ensemble de tests unitaires ne prouve pas la version installée sur le Mac ni l'intégration physique d'une tablette.

Ne pas fusionner main, publier un package ou déployer implicitement. L'intégration Lisière a son propre lot : facultative à utiliser, elle reste incluse dans le chantier. Prouver séparément le fonctionnement autonome et le connecteur. Un report éventuel reste explicitement un lot non réalisé, jamais une clôture implicite de cette exigence.
