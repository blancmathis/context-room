---
context_room:
  id: lifecycle.refactor.couverture
  depends_on:
    - lifecycle.refactor.cadrage
---

# Couverture et corrections de l'entretien

## Summary

Les décisions utiles de l'entretien sont conservées dans le cadrage, sans transcriptions privées ni duplication de la conversation. La liste ci-dessous permet de vérifier que les corrections tardives ont remplacé les premières propositions.

## Defines

La traçabilité des lots de questions, leur propriétaire final et les propositions devenues obsolètes.

## Does not define

Une deuxième spec produit ou une preuve de fonctionnement. Les règles complètes appartiennent au [cadrage](cadrage.md).

## Sources de décision

L'entretien a commencé dans la tâche « Refactoriser Context Room » en août 2026, puis a été repris ici début septembre et complété par les échanges vocaux jusqu'au 12 septembre. Les sources primaires sont les réponses et corrections utilisateur de ces deux conversations, récupérées dans cette tâche. Les audits de spécialistes ont servi à repérer les omissions, sans remplacer les décisions utilisateur. Le présent dossier reformule uniquement les conclusions durables.

| Lot de l'entretien | Décisions couvertes dans le cadrage | Résultat |
| --- | --- | --- |
| Vision initiale, accueil et navigation | R01–R06 | Global, projet, worktree, Explorer et Hub définis |
| Review locale et correction du sens de Reject | R07–R09, R13–R14 | Autorité, version exacte, effet réel du refus et correction humaine |
| Shared, brouillons et soumission | R10–R11 | Travail isolé puis review humaine |
| Correction « proposals seulement Shared » | R12–R14 | Parité locale recherchée, cas des fichiers déjà modifiés conservé |
| Question des travaux « abandonnés » | R15 | Conservation par défaut, refus manuel ou automatisme choisi par l'humain |
| Suppression du sous-agent et séparation du CLI | R16–R17, R26 | Agent principal et moteur déterministe |
| Révisions, lectures successives et hors ligne | R07, R18–R19 | Dernière version acceptée, diff limité, pas de mélange des lecteurs |
| Compatibilité harness et portée des skills | R16, R20 | CLI commun et skills choisis par projet |
| Formats et exception HTML | R21–R24 | Adoption de l'existant, édition adaptée, HTML rendu |
| Dépendances documentaires | R06 | Navigation conservée, alertes automatiques retirées |
| Correction humaine pendant la review | R09 | Enregistrer accepte seulement la version corrigée du document |
| Tablette et consultation du projet Lisière | R25 | Intégration optionnelle, aucune preuve d'intégration existante |
| Maintenance, réalisation et vérifications | R26–R29 | Responsabilités explicites et preuves confiées à l'agent |

## Propositions remplacées

| Ancienne proposition ou ambiguïté | Règle finale à appliquer |
| --- | --- |
| Explorer ordinateur limité à la lecture | R04 : édition humaine et opérations de fichiers récupérables |
| Reject marque seulement un désaccord | R14 : annulation réelle du changement examiné |
| Seul Shared possède des propositions | R12 : propositions locales avec une expérience proche, différences explicites |
| Le CLI normal peut lire la version non validée | R07 : contenu accepté uniquement ; inspection de proposition séparée |
| Un agent conserve la même révision Shared toute sa tâche | R18 : nouvelle vérification à chaque commande |
| Diff de tous les changements du dépôt | R18 : seulement les documents déjà consultés par le lecteur concerné |
| Agent documentaire intégré obligatoire | R26 : retiré ; ne pas confondre avec les spécialistes d'audit du refactor |
| Tous les skills sont globaux ou obligatoirement installés par harness | R20 : association par projet, accès CLI |
| Une structure et des métadonnées sont imposées aux documents | R21 : fonctionnement de base sur l'existant |
| Une dépendance modifiée remet les autres documents en review | R06 : aucune propagation de review ou d'alerte documentaire |
| L'humain édite le code HTML dans Context Room | R23 : rendu uniquement, modification par agent |
| Les vieux travaux disparaissent automatiquement | R15 : conservation sans limite sauf choix humain explicite |
| Enregistrer une correction humaine exige une seconde acceptation du fichier | R09 : enregistrement et acceptation de cette version liés |
| Lisière est nécessaire pour utiliser Context Room | R25 : optionnel |
| « Tout est clair » signifie « la technique est prouvée » | R29 : cadrage, réalisation et preuves séparés |

## Points techniques encore à démontrer

Ils sont suivis dans [Vérification](verification.md), pas transformés en questions produit artificielles : isolation et stockage des propositions locales ; acceptation multi-fichier récupérable ; coexistence avec les modifications directes ; provenance des corrections humaines ; refus automatique sans écrasement ; concurrence Git ; navigation des docs ordinaires ; matrice des formats ; édition des dessins ; extension Lisière ; migrations ; coût réel en tokens et latence.

Les syntaxes proposées pendant l'entretien, notamment `docs topics`, ne sont pas des votes implicites de l'utilisateur. L'architecture peut les retenir ou les simplifier tant que les usages R16–R21 sont préservés.
