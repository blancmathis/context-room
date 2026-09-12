---
context_room:
  id: lifecycle.refactor.architecture
  depends_on:
    - lifecycle.refactor.cadrage
---

# Architecture cible et choix de réalisation

## Summary

Un modèle commun de versions acceptées et de changements alimente deux fournisseurs de propositions, local et Git Shared. Le CLI et l'interface appellent les mêmes opérations déterministes. Les choix ci-dessous sont une conception à vérifier, pas un état livré.

## Defines

La séparation des responsabilités, les invariants de stockage et la résolution technique des cas particuliers du [cadrage](cadrage.md).

## Does not define

Une nouvelle liste de fonctionnalités ni des noms de modules obligatoires. La réalisation réutilise les helpers existants lorsque leur contrat convient.

## Responsabilités

| Responsabilité | Entrées et sorties | Limite |
| --- | --- | --- |
| Registre et périmètres | Projet logique, emplacement exact, rattachement Shared | Aucun parcours Computer transformé en inscription implicite |
| Ressources et versions | Octets, chemin relatif, type, mode, existence, hash | Métadonnées documentaires facultatives ; aucun LLM |
| Documentation acceptée | Recherche, lecture, provenance, liens, diff de consultation | Jamais de contenu pending par lecture normale |
| Changements | Base, espace préparé, manifeste soumis, décisions de fichier, effet final | Fournisseurs local et Shared, mêmes états observables |
| Opérations filesystem | Prévisualisation, contrôles de chemin, application et récupération | Aucun écrasement silencieux ; pas de hard links éditables vers la source |
| Review humaine | Affichage exact, correction, acceptation/refus, règle de refus autorisée | Séparée des commandes agent et des réglages génériques |
| Formats | Détection, aperçu, édition, comparaison | Capacités explicites, pas de faux éditeur universel |
| Interface et CLI | Navigation, commandes par domaine, réponses versionnées | Adaptateurs minces, sans seconde logique métier |
| Diagnostics et récupération | Problèmes actuels, reçus, reprise | Pas d'alerte de dépendance documentaire |

## Propositions locales

Le fournisseur local part d'un manifeste de documentation acceptée, pas d'une copie aveugle d'un arbre contenant déjà des changements externes non validés. Il expose un dossier complet avec la même arborescence. Les racines documentaires multiples sont décrites explicitement ; le code et les secrets hors périmètre ne sont pas copiés.

Le stockage conserve des blobs de base partagés par hash et un espace modifiable par proposition. Sur macOS, une copie à partage de blocs peut réduire l'espace physique si elle est disponible ; un repli en copie indépendante reste nécessaire. Le choix doit être mesuré avant adoption. Des hard links ne conviennent pas : une écriture dans le brouillon ne doit jamais modifier la source ni une autre proposition.

Soumettre calcule et fige un manifeste : base acceptée, contenu proposé, fichiers ajoutés/modifiés/supprimés, chemins et modes. La review porte sur ce manifeste, pas sur un dossier encore modifiable sans contrôle. Une nouvelle soumission invalide les décisions touchées.

### Appliquer une proposition locale

1. Vérifier l'identité de l'emplacement, la base acceptée et les fichiers source actuels.
2. Refuser l'application si un fichier touché diffère de la base attendue ; ne pas écraser une modification directe ou une autre proposition acceptée.
3. Préparer tous les nouveaux octets et une sauvegarde récupérable des anciennes versions.
4. Écrire un journal durable d'opération avant la première modification du projet.
5. Remplacer les fichiers par opérations atomiques unitaires ; une panne au milieu bloque les nouvelles mutations jusqu'à récupération.
6. Mettre à jour les baselines acceptées et le reçu final seulement après vérification de tous les effets.

Une opération multi-fichier sur le filesystem ordinaire n'est pas une transaction atomique universelle pour les lecteurs externes. Le contrat est une application contrôlée et récupérable ; les lectures Context Room sont liées à un snapshot cohérent.

### Modifications directes et refus

Les changements extérieurs forment une review de changement déjà appliqué. Le snapshot accepté reste disponible séparément. Refuser utilise la version réellement revue comme précondition, conserve les octets remplacés dans l'espace de récupération et restaure la baseline. Un fichier modifié depuis la review produit un conflit. Une suppression ou un déplacement portant sur un dossier ne doit pas effacer de nouveaux fichiers non inclus dans la décision.

## Shared et collaborateurs

Réutiliser les mécanismes existants de branches isolées, révisions exactes, vérifications distantes, leases et reçus. La suppression du serveur hébergé n'autorise pas à supprimer ces garanties. Une acceptation simultanée ou un main modifié force une nouvelle comparaison ou une réconciliation vérifiée ; une validation ancienne ne peut autoriser des octets nouveaux.

Un retour sur une modification acceptée prépare une nouvelle proposition inverse. Il ne réécrit pas silencieusement l'historique partagé. Les opérations nécessitant des droits Git expliquent les refus réels du dépôt ; Context Room n'ajoute pas une couche de rôles utilisateurs.

## Autorité et règles automatiques

Le point d'enregistrement de l'interface de review lie correction humaine et validation au même hash. Dans une proposition, ce reçu concerne le fichier ; l'application finale reste distincte. Les écritures externes ont une origine inconnue et restent à reviewer.

Le refus par âge utilise le même moteur que le refus humain. Une règle comprend les projets concernés, le délai, les types de changements et une preuve de choix dans l'interface humaine. Un réglage agent générique ne peut activer ou élargir cette autorité. L'âge se calcule depuis la dernière version soumise ou détectée, pas depuis une date de fichier arbitraire. Les brouillons actifs et les révisions modifiées depuis la sélection ne sont pas rejetés silencieusement.

Le moteur applique les règles lors des réconciliations disponibles, avec le périmètre exact et un reçu. L'application fermée ne promet pas un traitement à la seconde près et n'installe pas implicitement un service supplémentaire. Shared inaccessible, conflit, identité incertaine ou restauration périmée bloquent l'action concernée.

## CLI et lectures

Domaines de travail : projets, docs, changements, propositions, review en lecture, settings, Hub, Startup et diagnostics. Les commandes publiques doivent être découvertes sans charger les alias historiques ni un chercheur LLM. Les réponses identifient cible, source, révision, fraîcheur, données utiles et limites ; les erreurs ne sont pas des réponses documentaires inventées.

La résolution privilégie les sélecteurs explicites, puis l'emplacement enregistré correspondant au dossier courant. Une ambiguïté demande un choix, jamais un projet aléatoire. La navigation documentaire peut utiliser titres, chemins, sections et liens sans front matter.

Chaque commande fixe un snapshot accepté. Un registre de consultation associe le lecteur et ses documents lus à leurs versions exactes. Utiliser un identifiant de conversation exposé par l'environnement lorsqu'il existe, sinon un jeton de consultation explicite retourné par le CLI ; ne jamais partager automatiquement tout l'historique d'un projet entre processus inconnus.

Sans identifiant fourni, le premier appel crée et retourne un jeton dans `readerToken` ; chaque réponse indique l'argument de reprise. Les appels suivants qui reprennent ce jeton retrouvent uniquement ses consultations. Sans reprise du jeton, un nouveau lecteur est créé et la réponse signale l'absence de continuité : l'identité de deux agents n'est pas déductible d'un dossier ou d'un PID éphémère. Aucune commande d'initialisation n'est nécessaire. Les noms propres aux harness ne deviennent pas une condition de lecture.

Une revalidation Shared tente de récupérer la branche principale à chaque commande. Un échec autorise seulement un snapshot précédemment vérifié, marqué non vérifié à distance. Les diffs concernent exclusivement les lectures antérieures du même lecteur, et uniquement les versions acceptées. Les chemins d'une recherche devenue ancienne doivent être résolus ou signalés comme disparus, pas mélangés silencieusement avec une autre révision.

## Formats et édition

| Famille | Cible d'affichage | Cible d'édition humaine | Cible de comparaison |
| --- | --- | --- | --- |
| Markdown et texte | Lecture et structure existante | Éditeur intégré | Diff textuel |
| Mermaid autonome ou inclus | Diagramme rendu | Source textuelle intégrée, rendu actualisé | Diff du texte et rendu |
| HTML/HTM | Page rendue isolée et ressources autorisées | Aucune édition humaine du code | Indication modifiée et versions rendues accessibles |
| PNG/JPEG et dessins | Aperçu image ou scène | Dessin/annotation adaptés, avec annulation et sauvegarde | Avant/après visuel |
| SVG | Rendu isolé | Source ou dessin selon capacités vérifiées | Source et aperçu selon mode |
| PDF et autres documents binaires | Aperçu lorsque le lecteur est validé | Capacité à étudier explicitement, pas un éditeur fictif | Versions visibles lorsque possible, sinon limite expliquée |

Les fichiers inconnus restent identifiables et conservés ; l'interface ne présente pas leur code binaire comme du texte ni leur hash comme un diff sémantique. Les limites sur PDF, formats bureautiques et dessins sources restent des preuves à produire avant une revendication de support. HTML n'exécute pas de contenu dans l'autorité de l'interface hôte. L'adoption de HTML existant ne dépend pas de composants documentaires injectés obligatoires.

## Lisière

Prévoir une frontière d'extension facultative : identifier le dessin et la révision, demander son ouverture sur l'appareil associé et recevoir une modification versionnée. La source éditable et les aperçus sont distingués. Context Room et Lisière ne doivent pas créer deux décisions contradictoires pour la même modification. Aucune liaison n'est annoncée active sur la base de la seule présence de fichiers sur le Mac. Ce lot n'est pas nécessaire pour les parcours sans tablette.
