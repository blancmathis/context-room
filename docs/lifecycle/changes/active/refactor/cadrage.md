---
context_room:
  id: lifecycle.refactor.cadrage
  depends_on: []
---

# Cadrage consolidé du refactor

## Summary

Context Room rapproche le travail des agents et la compréhension humaine : les agents trouvent la documentation acceptée, préparent les changements, et l'humain les voit, les corrige, les accepte ou les refuse. L'application s'adapte aux projets existants et rapproche les parcours local et Shared sans masquer leurs différences physiques.

## Defines

Les décisions produit finales de l'entretien. Les identifiants R01 à R29 relient les décisions à la couverture et aux vérifications.

## Does not define

Un protocole de stockage déjà prouvé, une compatibilité universelle des formats, ou l'état de livraison. Ces sujets appartiennent à l'architecture et aux preuves.

## Produit, installation et périmètres

### R01 — Application locale

Le produit est open source, destiné aux personnes qui travaillent avec des agents de code. La première version cible macOS. Chacun utilise son installation. Il n'y a pas de service Context Room hébergé ; un serveur local pour l'interface reste possible. Les fichiers et états restent sur les machines et dans les dépôts Git explicitement connectés.

### R02 — Accueil global et sélection

L'accueil présente la Review Queue de tous les projets, le Context Health global, le Startup Environment global et le Hub configurable. Sélectionner un projet filtre ces surfaces et ouvre son arborescence. Le retour global est immédiat et explicite.

### R03 — Projets et worktrees

Un projet logique peut posséder plusieurs worktrees. Chaque emplacement conserve son chemin, sa branche, sa révision, sa disponibilité, sa review locale et son Health. Le rattachement Shared appartient au projet logique. Aucun remplacement silencieux d'un emplacement indisponible.

### R04 — Explorer modifiable

Projects et Computer sont deux modes distincts. Computer permet de parcourir, rechercher, ouvrir, créer, modifier, renommer, déplacer, dupliquer et supprimer de façon récupérable fichiers et dossiers. Parcourir un dossier ne sélectionne, n'enregistre et ne surveille pas implicitement un projet. Les opérations touchant des fichiers surveillés sont réconciliées avec leurs reviews. Collisions et écrasements silencieux sont refusés.

### R05 — Hub et environnement

Le Hub propose des sections et raccourcis vers documents, dossiers et URLs, aux niveaux global et projet. Pas de boutons exécutant des commandes shell arbitraires. Startup Environment explique les ressources effectivement présentes, leur provenance et leur portée. Un élément présent ou installé n'est pas automatiquement considéré actif dans un agent.

### R06 — Health et navigation

Health expose des problèmes techniques actuels et actionnables. Les documents et dossiers liés restent navigables lorsque leurs relations sont connues. Aucune alerte automatique de dépendance documentaire, et aucun document inchangé ajouté à la review parce qu'un autre document lié a changé.

## Édition et review

### R07 — Version acceptée

La consultation documentaire normale par les agents ne renvoie que les versions acceptées. Une modification en attente ne devient pas lisible via une option de consultation normale. Un document nouveau sans version acceptée ne fournit pas son contenu à ce lecteur. L'agent rédacteur travaille dans sa proposition et conserve le contexte de ses modifications. L'inspection explicite des propositions est une surface distincte de la documentation officielle.

Cette garantie porte sur Context Room : un agent disposant séparément de l'accès au disque peut y lire les fichiers. Context Room ne prétend pas imposer un contrôle d'accès universel à tous les outils de la machine.

### R08 — Autorité humaine

Les changements des agents apparaissent dans la Review Queue pour décision humaine. L'agent peut préparer, soumettre, inspecter et expliquer ; il n'accepte ni ne refuse les fichiers ou propositions par commande. La visibilité dans la file est la notification minimale requise ; des notifications système ne sont pas une exigence implicite.

### R09 — Correction humaine enregistrée

Lorsque l'humain corrige un document dans l'interface de review et l'enregistre, la version corrigée est acceptée sans second clic sur Accepter. Cela ne valide pas les autres fichiers de la proposition ni une version ultérieure. Dans une proposition isolée, cette décision de fichier ne fusionne pas implicitement l'ensemble. Une écriture extérieure dont l'auteur est inconnu n'est pas assimilée à une correction humaine.

### R10 — Parcours des propositions

Préparer un changement crée un espace de travail et donne son emplacement à l'agent. Les brouillons restent retrouvables dans le statut des travaux ; ils ne sont pas encore présentés dans la file de review prête pour l'humain. Soumettre les changements rend la proposition visible. Plusieurs changements liés sont regroupés et vérifiables fichier par fichier avant la décision finale. Le vocabulaire de travail est `begin`, `status`, `submit` ; la syntaxe finale reste un choix d'implémentation.

### R11 — Shared

Shared est un dépôt Git documentaire pouvant accueillir plusieurs projets et plusieurs personnes depuis leurs machines. Sa branche principale contient la vérité acceptée. Chaque proposition prépare ses changements en isolation ; l'acceptation intègre exactement le résultat vérifié. Plusieurs propositions peuvent coexister. Les permissions Git restent applicables ; pas de système de rôles Context Room supplémentaire. L'historique permet un retour explicable sur un changement, sans rendre les conflits ou les erreurs impossibles.

### R12 — Propositions locales

Le local doit offrir un parcours aussi proche de Shared que possible, sans obliger à créer un dépôt documentaire séparé. Direction retenue : un dossier par proposition présente la documentation complète dans son arborescence habituelle ; l'agent n'y fait que les modifications nécessaires. Accepter applique les changements pertinents au projet ; refuser une proposition isolée laisse les fichiers du projet inchangés. La méthode de stockage doit éviter une duplication excessive et être vérifiée sur des corpus volumineux.

### R13 — Changements locaux directs

Les fichiers surveillés modifiés directement sur le disque restent détectés, y compris après un arrêt de Context Room. Créer, modifier, renommer, déplacer et supprimer doivent être couverts. Un événement de surveillance accélère la détection ; il ne remplace pas la comparaison des états réels. Quand un dossier existant devient surveillé, l'humain peut revoir son contenu ou accepter explicitement son état initial.

### R14 — Effet du refus

Refuser annule le changement examiné. Dans une proposition isolée, il n'a jamais été appliqué au projet. Pour une modification locale déjà appliquée, le refus restaure la dernière version acceptée, l'ancien chemin ou le fichier supprimé ; un nouvel élément est retiré de manière récupérable. L'effet est annoncé avant l'action. Un refus ne doit pas écraser un changement plus récent ni s'appliquer à une version différente de celle examinée.

### R15 — Conservation et refus par ancienneté

Les travaux en attente sont conservés sans limite par défaut. L'âge ne prouve pas l'abandon. L'humain peut filtrer par âge et projet et refuser ponctuellement les éléments correspondants. Il peut aussi activer une règle de refus automatique après un délai choisi, désactivée par défaut. Il s'agit d'un véritable refus, pas d'un masquage. La règle explicite vient de l'humain ; elle ne confère pas une autorité générale de review aux agents.

## Agents et documentation

### R16 — CLI agnostique

Tout harness capable d'exécuter des commandes peut utiliser Context Room. Aucune intégration spécifique à Codex ou Claude n'est nécessaire pour consulter Shared. Le CLI organise ses commandes par domaine ; la gestion du produit est automatisable sauf les décisions humaines de review. La partie documentaire cherche et lit ; les changements, propositions, réglages et diagnostics utilisent leurs domaines respectifs.

### R17 — Recherche et navigation

L'agent retrouve le projet depuis son emplacement ou un sélecteur explicite et obtient les passages utiles, leurs sources et leur révision. La même méthode sert au local et à Shared. La recherche doit être complète pour le besoin et économe en tokens. Les documentations peuvent fournir des points d'entrée adaptés à leur projet ; aucune syntaxe de manifeste spécifique n'a été imposée par l'utilisateur.

### R18 — Fraîcheur et diffs

Chaque nouvelle commande Shared vérifie la branche principale distante et utilise la version acceptée la plus récente disponible. Une commande en cours reste cohérente sur une seule révision. Quand une version acceptée change, le CLI indique le changement et présente un diff uniquement pour les documents déjà consultés par cet agent. Les consultations locales suivent la même règle sur les versions acceptées. Le suivi démarre automatiquement ; les lecteurs concurrents ne mélangent pas leurs historiques.

### R19 — Hors ligne

Une copie Shared précédemment acceptée reste lisible lorsque le dépôt est inaccessible. La réponse indique que sa fraîcheur distante n'a pas pu être vérifiée ; elle ne prétend pas être la dernière version. Les mutations distantes ne réussissent pas sans preuve de leur résultat.

### R20 — Skills par projet

Shared contient la documentation et des skills. Les projets peuvent être liés à une sélection de skills ; ceux-ci ne sont pas tous globaux. Aucune catégorie autonome d'instructions d'agents Shared n'est demandée. L'accès via le CLI n'impose pas une installation dans les emplacements natifs de chaque harness.

### R21 — Documentation existante

Context Room s'adapte à l'organisation des utilisateurs. Une documentation existante fonctionne sans réorganisation obligatoire, front matter, identifiants ou métadonnées à ajouter. Les conventions utilisées par ce dépôt sont facultatives pour les autres projets. Les liens et métadonnées déjà présents peuvent enrichir la navigation sans bloquer les usages de base.

### R22 — Formats

Markdown, texte, HTML, Mermaid, images et dessins font partie de la cible. La compatibilité doit pouvoir s'élargir à d'autres formats documentaires. L'édition et l'observation des changements restent dans Context Room pour les formats adaptés. Un éditeur externe ne remplace pas silencieusement cette demande. La matrice des capacités doit distinguer conserver un fichier, l'afficher, rechercher son contenu, le modifier et comparer ses versions ; aucune édition universelle n'est présumée prouvée.

### R23 — HTML rendu

L'humain voit la page HTML rendue, pas son code source. La modification HTML se fait par l'agent ; l'interface humaine n'expose pas un éditeur de code HTML. Context Room signale le changement et permet la review de la page ; un diff de code ne constitue pas l'expérience demandée.

### R24 — Dessin

Une possibilité de dessiner dans Context Room est souhaitée pour les formats qui s'y prêtent. Les outils précis et la conservation d'une source éditable relèvent de la conception technique. Il ne faut pas confondre un PNG de prévisualisation avec tous les objets d'un dessin encore modifiable.

### R25 — Lisière optionnel

Un lien avec Lisière peut permettre d'ouvrir un dessin sur une tablette connectée et de retrouver les modifications sur le Mac. L'intégration est optionnelle ; Context Room reste utilisable sans Lisière. L'ouverture, la synchronisation, la conservation des objets et la coordination des reviews restent à implémenter et à vérifier. Lisière ne doit pas devenir une dépendance obligatoire de l'installation.

### R26 — Responsabilité de maintenance

Déterminer qu'un changement de code exige une mise à jour documentaire relève des instructions de l'utilisateur à son agent, notamment AGENTS.md. Context Room fournit les outils de consultation, préparation et review. Il ne lance pas de sous-agent documentaire, ne déclenche pas de maintenance par LLM et n'ajoute pas de LLM à ses diagnostics déterministes. Le CLI seul est retenu pour cette version, sans MCP nécessaire.

## Migration et réalisation

### R27 — Simplification

Retirer les couches historiques inutiles, conserver des responsabilités lisibles et des contrats cohérents entre CLI, interface, fichiers et réglages. Les anciennes fonctionnalités ne deviennent pas des exigences seulement parce qu'elles existent. Le serveur hébergé et le chercheur documentaire intégré ne font pas partie de la cible minimale. Le retrait des autres couches, notamment Prompt Center et le contrôle distant historique, reste un choix technique à justifier par leurs consommateurs et la préservation de Startup et du parcours tablette.

### R28 — Préservation

Préserver les projets, worktrees, configurations, validations, baselines acceptées, propositions et personnalisations. Les migrations sont versionnées, répétables, sauvegardées et récupérables après interruption. L'absence de perte de données et d'incohérence silencieuse est un critère de réalisation, pas une promesse issue d'un test isolé.

### R29 — Travail confié à l'agent

L'agent déduit les choix techniques, tests, démonstrations et critères de fin de ce cadrage. Il vérifie les limites réelles et ne redemande un choix que si un compromis modifie l'usage souhaité. L'utilisateur a autorisé le dossier complet puis le refactor dans cette tâche ; publication, fusion et déploiement restent des actions séparées.
