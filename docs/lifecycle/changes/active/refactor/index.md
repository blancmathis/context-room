---
context_room:
  id: lifecycle.refactor.index
  depends_on: []
---

# Refactor Context Room — dossier de mise en place

## Summary

Ce dossier rassemble le cadrage utilisateur, la cible technique, la migration et les preuves du refactor. Le travail est autorisé dans cette branche ; son existence ne signifie ni que la cible fonctionne déjà, ni que les fichiers ont été validés dans la review humaine.

## Defines

Le point d'entrée et l'état d'avancement de cette transformation.

## Does not define

Le comportement livré, encore décrit par les documents courants jusqu'au remplacement effectif de chaque fonctionnalité.

## Lire et travailler dans cet ordre

1. [Cadrage consolidé](cadrage.md) : propriétaire des décisions produit issues de l'entretien.
2. [Couverture de l'entretien](couverture.md) : provenance, corrections et sujets confiés à l'agent.
3. [Architecture cible](architecture.md) : choix d'implémentation, limites et invariants à prouver.
4. [Migration et exécution](migration.md) : conservation, retrait, étapes et reprise.
5. [Vérification](verification.md) : scénarios de réussite et résultats effectivement observés.

Les décisions utilisateur récentes priment sur les anciennes propositions de l'entretien et sur le code à migrer. Les choix techniques de ce dossier sont des choix de réalisation, pas des réponses inventées de l'utilisateur.

## État du chantier

| Étape | État |
| --- | --- |
| Entretien produit et audit des questions conditionnelles | Terminés ; décisions consolidées dans ce dossier |
| Préservation du cadrage et audit documentaire | Terminés ; 29 exigences et 28 scénarios reliés |
| Baseline code, tests et dépendances | Établie ; 57/60 processus sur la base, dépendances installées |
| Réalisation de la cible | Intégrée : CLI déterministe, lecteur accepté, propositions locales, nettoyage, images et connecteur Lisière |
| Migrations, concurrence et récupération | Scénarios automatiques exécutés ; état réel utilisateur conservé |
| Parcours visuels de la nouvelle version | Markdown, HTML, Mermaid, PNG local/Shared et cleanup vérifiés ; axe sur les nouvelles fenêtres |
| Vérification logicielle | Passes et reprises documentées ; tous les échecs identifiés corrigés et revalidés |
| Publication GitHub | Autorisée ; intégration à `main` conditionnée aux contrôles de la PR |
| Distribution et appareil physique | Pas de release npm ni de mise à jour installée dans ce chantier ; BOOX non testé |

## Frontière actuelle et cible

La base inspectée est le package 0.6.17, commit `5a2bcab`. Sur cette base, le CLI local écrivait dans le dossier du projet ; Shared utilisait un espace isolé. Le nouveau workflow local utilise désormais un espace de proposition. L’interface a été extraite dans `src/ui/app.mjs` ; le serveur et l’intégration de review restent dans [context_room.mjs](../../../../../src/context_room.mjs). Cette observation justifie le refactor, elle n'impose pas de conserver cette architecture.

Les propriétaires courants concernés sont le [produit](../../../../product-overview.md), le [Hub](../../../../features/context-hub.md), [Shared](../../../../features/shared-context.md), l'[autorité humaine](../../../../features/review-authority.md), l'[architecture](../../../../system/architecture.md) et les [profils de runtime](../../../../system/runtime-profiles.md). Ils ont été actualisés avec le propriétaire du [workflow documentaire](../../../../features/document-workflow.md). Les résultats et limites de cette branche sont consignés dans la matrice de vérification.

## Limites de cette réalisation

Les formats Office et PDF restent des ressources binaires à vérifier, sans éditeur intégré. Le connecteur Lisière a été vérifié avec un compagnon réel isolé ; l’ouverture automatique du carnet n’est pas exposée par son protocole actuel et aucun test physique BOOX n’a été effectué. Les résultats de publication sont consignés dans la PR associée ; une intégration GitHub ne vaut pas mise à jour de la version installée.
