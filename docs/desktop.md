# Application desktop (host)

Un **compagnon desktop pour l'host**, opt-in, Windows d'abord. Le web reste la
porte d'entrée du produit ; l'app desktop s'adresse à celui qui émet souvent et
veut lever les plafonds que le navigateur lui impose (audio par application,
sélecteur de source maison, HDR correct…). Elle **ne remplace pas** le web : elle
le complète pour un seul rôle.

> Ce document est le point d'entrée de la version desktop : ce qu'elle fait,
> pourquoi Electron, comment elle s'articule avec le reste du produit. Pour le
> cœur média (mesh, codecs, tuning), voir [`webrtc-media.md`](./webrtc-media.md) ;
> pour le front web, [`frontend.md`](./frontend.md) ; pour le déploiement,
> [`deployment.md`](./deployment.md).

## Principes directeurs

1. **Un client comme un autre.** Même signaling, même protocole, même mesh
   ([`README.md`](./README.md)). Un host desktop et un host web sont
   **indiscernables** pour un viewer. On ne forke pas le produit, seulement le
   client. Aucun viewer ne sait — ni n'a besoin de savoir — que l'host est en
   desktop.
2. **Host uniquement.** Le viewer garde **zéro friction** : il clique un lien,
   ça marche dans son navigateur. Le web fait déjà tout ce dont un viewer a besoin
   (PiP, plein écran, stats, qualité par-viewer). Une app viewer n'ajouterait que
   de la friction sur le rôle qui doit en avoir le moins.
3. **Windows d'abord.** C'est là que vivent le gaming, Discord, et la seule voie
   propre vers l'audio par application. macOS et Linux viendront après, si l'usage
   le justifie (cf. [Plateformes](#plateformes-à-venir)).
4. **La récompense justifie le téléchargement.** Le critère qui juge chaque
   fonctionnalité : _celui qui prend deux minutes pour installer l'app est-il
   récompensé ?_ Si une fonctionnalité se résume à « pareil mais dans une fenêtre
   sans barre d'URL », elle n'a pas sa place ici.

### Ce qui ne change pas

Écrit noir sur blanc pour éviter que « desktop » serve de prétexte à rouvrir des
décisions closes :

- **Mesh, zéro média serveur, pas de SFU, pas de TURN** — inchangé.
- **Le plafond d'upload reste physique.** L'encodage hardware allège le GPU/CPU,
  pas la bande passante montante ; 4 viewers en 4K resteront 4 viewers en 4K.
- **Le signaling ne bouge pas.** Aucune ligne de `signaling/` à changer.
- **Le hack `x-google-start-bitrate`** (`peer.ts`) : même Chromium, même
  comportement.

## Fonctionnalités

Chaque fonctionnalité correspond à un plafond du navigateur qu'on lève. Vue
d'ensemble, puis le détail des trois qui portent le produit.

| Fonctionnalité                  | Plafond web levé                                                   | Phase        |
| ------------------------------- | ------------------------------------------------------------------ | ------------ |
| **Audio par application** ✅     | `getDisplayMedia` capture le mix système entier, ou rien           | 2 — livré    |
| **Sélecteur de source natif** ✅ | Picker Chrome imposé, aucune API web ne liste les fenêtres         | 2 — livré¹   |
| **Réglages mémorisés** ✅        | Rien ne survit proprement d'une session à l'autre                  | 2 — livré    |
| **Wake lock fiable** ✅          | `navigator.wakeLock` est relâché dès que la fenêtre est masquée    | 2 — livré    |
| **Notifications natives** ✅     | Pas d'alerte hors fenêtre : viewer qui rejoint/quitte, mise à jour | 2 — livré    |
| **Encodage hardware** ⚠️         | *(faux plafond — c'était notre ordre de codecs, cf. spike)*        | 3 — livré NVIDIA/Windows³ |
| **Tone-map HDR correct**        | `getDisplayMedia` écrase le HDR par un clamp brutal, sans tone-map | 3 — natif    |
| ~~FPS élevé garanti (120/144)~~ | *(faux plafond — mesuré à 119 fps en 1080p, cf. spike)*            | ~~3~~ — n/a³ |
| ~~Contrôle du curseur~~         | —                                                                  | abandonné³   |

La **phase 1** n'apporte aucune de ces fonctionnalités : elle emballe l'app web
actuelle dans Electron + page `/download` + auto-update. ¹ En phase 1, faute de
picker Electron sur Windows, la source était **imposée à l'écran principal** ;
cette béquille est levée depuis que le sélecteur existe (cf.
[Contraintes Electron](#contraintes-electron-découvertes-au-test-phase-1)).
² Envisagé en phase 2, écarté sur vérification : **Electron 43.2 n'expose rien**
pour le curseur de capture — ni sur `desktopCapturer`, ni dans les options de
`setDisplayMediaRequestHandler`. Le levier (`IsCursorCaptureEnabled` de WGC) vit
sous Chromium, hors de portée du JS.
³ **Trois des quatre lignes de la phase 3 sont tombées au spike** (2026-08-03).
Elles étaient présentées comme partageant un même prérequis lourd — reprendre la
main sur les frames vidéo. À la mesure, deux n'avaient pas ce prérequis du tout et
la troisième n'avait pas de valeur. Détail :
[Capture native](#capture-native-le-spike-a-r%C3%A9duit-le-p%C3%A9rim%C3%A8tre-%C3%A0-une-seule-feature).
Détail des phases : [Chemin d'exécution](#chemin-dexécution).

> **Abandonnés après usage réel (2026-08-01)**, pas reportés :
> **les raccourcis globaux** — le contrôle sans alt-tab n'a jamais manqué en
> session, et des hotkeys système entrent en conflit avec les jeux, ce qui est
> exactement le contexte visé ; **l'avertissement HDR** — un bandeau « coupez
> votre HDR » est un aveu, pas une fonctionnalité, et le seul vrai correctif est
> le tone-map de la phase 3. Tous deux sont retirés de `/download`, qui les
> annonçait.

> **Hors périmètre**, définitivement : la composition de scène (écran + webcam +
> overlays) — c'est OBS, on partage un écran — et l'ouverture de port /
> découverte LAN — on est une app de partage **à distance**, la traversée NAT par
> STUN suffit ([`webrtc-media.md`](./webrtc-media.md)).

### Audio par application

Le cœur du produit desktop, et la frustration n°1 vécue en web : impossible de
muter Discord, donc en vocal les viewers s'entendent en double.

#### Le principe : l'audio suit la source vidéo

En web, les trois modes de partage ont trois comportements audio incohérents,
dont un cassé :

| Source partagée   | Web aujourd'hui                   | Desktop                                            |
| ----------------- | --------------------------------- | -------------------------------------------------- |
| Onglet navigateur | audio de l'onglet seul            | ⚠️ **régression** — voir plus bas                  |
| Écran             | tout le son système, sans recours | tout le système **moins les apps décochées** ✅    |
| **Fenêtre / app** | **rien, ou tout le système** ❌   | **le son de cette app, et rien d'autre** ✅        |

**L'audio suit la source vidéo**, automatiquement :

- **Source = une fenêtre** → on capture l'arbre de processus de cette app **et
  rien d'autre**, sans rien configurer. C'est appliqué au moment du choix de la
  source, pas au moment d'ouvrir les réglages. À la première ouverture du panneau,
  les cases se règlent sur ce qui est déjà capturé : cette app cochée, les autres
  décochées.
- **Source = un écran** → tout le système, moins ce qu'on décoche.

**Le lien fenêtre → process est gratuit** : l'identifiant `desktopCapturer` d'une
fenêtre est `window:<HWND>:<n>`, et ce HWND est celui que `MainWindowHandle`
expose — vérifié sur 6 fenêtres sur 6, Discord compris. La résolution vit dans le
main process, seul endroit qui détient l'identifiant à jour au moment du besoin.

#### Le modèle : une case par app

Une case à cocher par app, cochée = les viewers l'entendent — le modèle de la
maquette. WASAPI ne prend **qu'un seul arbre de processus à la fois**, en
inclusion **ou** en exclusion ; c'est une contrainte par *session*, pas par
machine, donc on en ouvre plusieurs. `audioSpecFor` (dans `src/lib/host.ts`)
choisit le côté le moins cher :

| Apps décochées | Ce qui tourne                              | Pourquoi                                                                |
| -------------- | ------------------------------------------ | ----------------------------------------------------------------------- |
| aucune         | rien du tout                               | la piste loopback de `getDisplayMedia` porte déjà tout, gratuitement     |
| une            | **exclusion** de cette app                 | seul mode sans angle mort — voir juste en dessous                        |
| deux ou plus   | une session **inclusion** par app restante | on reconstruit le mix par l'autre bout                                   |
| toutes         | une capture **vide**                       | le silence, et surtout **pas** un repli sur la piste loopback            |

Ce dernier cas est le piège : répondre « pas de capture » quand tout est décoché
renverrait les viewers sur la piste loopback, donc **démuterait tout** — le pire
résultat possible, atteint par le geste le plus naturel. Une inclusion vide est
une capture bien vivante qui ne contient rien.

#### La règle qui tient tout : une seule vérité, la capture vivante

Les cases **ne mémorisent pas une intention**. Elles se lisent depuis la capture
que le shell exécute réellement (`isAudible`) : décoché = *aucune session ne
porte cette app*. Un second état « ce que l'utilisateur voulait » dériverait tôt
ou tard de ce qui tourne, et **toutes les pannes de cette feature sont inaudibles
pour le host** — il croit son vocal coupé, les viewers l'entendent. Il n'y a donc
qu'une source, et c'est celle qui produit le son.

Trois conséquences, toutes voulues :

- **Un refus ne casse rien.** Le main résout toutes ses cibles *avant* d'arrêter
  quoi que ce soit : un clic qu'il ne peut pas honorer laisse la capture
  précédente en place, les cases restent donc vraies. Le panneau dit juste que le
  changement n'est pas passé.
- **Pas de mise à jour optimiste.** Le clic attend l'aller-retour (~240 ms) et
  n'affiche que du confirmé.
- **Couper le son système oublie les coches.** Il n'y a plus de capture à lire,
  donc plus rien de coupé ; rallumer repart de « les viewers entendent tout ».
  C'est le prix de la règle, et il est petit.

**Rallumer ré-acquiert, ça ne se contente pas de rallumer le drapeau.** Le
correctif d'un point du backlog, et il en a fait tomber un second, jamais
remonté :

| Source partagée            | Avant                                              | Maintenant                            |
| -------------------------- | -------------------------------------------------- | ------------------------------------- |
| Écran (natif ou non)       | **silence**, avec « system » allumé au panneau      | une piste loopback est demandée        |
| Fenêtre, propriétaire résolu | **tout le bureau**, panneau nommant toujours l'app | la session par app est réarmée         |
| Fenêtre, sans propriétaire | tout le bureau, annoncé par le hint                 | inchangé — dégradation assumée         |
| Caméra                      | rien à rallumer, les cases restent la seule voie   | inchangé, et **délibérément** : voir plus bas |
| Web (pas de `window.native`) | silence si l'audio n'a pas été coché au prompt     | un **second** sélecteur d'écran s'ouvre |

Le premier cas : `buildOutgoing` lit la piste système dans le flux de capture, et
elle n'y est que si le toggle était **déjà** allumé au moment du `getDisplayMedia`
— le chemin natif, lui, ne produit jamais d'audio. Le second est pire, parce qu'il
est *audible chez les autres et pas chez soi* : sur une fenêtre, main répond
`audio: 'loopback'` comme partout ailleurs, donc le mix complet du bureau dort
dans le flux, inutilisé tant que la session par app tourne. Couper le son système
détruit cette session, la rallumer laissait `buildOutgoing` retomber sur ce mix.
Un clic sur « system » et le vocal Discord partait dans le stream.

**La caméra ne demande rien, exprès.** `ss:select-source` ne mémorise que les ids
`screen:`/`window:`, donc un `getDisplayMedia` serait refusé — et un refus rééteint
le toggle, ce qui **grise les cases par app**, c'est-à-dire le seul chemin par
lequel un partage caméra a jamais du son. Laisser le drapeau allumé sans piste est
le comportement documenté de `captureCamera` : silence jusqu'à ce qu'une case soit
cochée. Demander aurait remplacé ça par un interrupteur impossible à allumer.

Sur le desktop la demande ne montre aucun prompt : le shell répond depuis la source
déjà approuvée. Sur le **web**, si : c'est un second sélecteur, et le host peut y
choisir une autre surface que celle qu'il partage — les viewers entendraient alors
une source dont ils ne voient pas l'image. C'est aussi le seul rattrapage possible
pour qui a oublié de cocher « Partager l'audio » dans le premier prompt.

Deux réserves, toutes deux vérifiées :

- **`selectedSourceId` ne vit pas toute la session.** `forgetPick` l'efface sur
  `display-added`/`display-removed`. Brancher un écran en cours de partage, puis
  cliquer « system » → refus → le toggle claque et se rééteint, sans explication.
  Assumé : le toggle qui refuse de rester allumé *est* le signal, et il ne ment pas.
  Un message actionnable (« re-choisis la source ») reste à écrire — voir le
  `ponytail:` dans `toggleSystemAudio`.
- **« avant tout `await` » n'est vrai que sur le chemin écran.** Sur une fenêtre
  refusée, le repli traverse d'abord l'aller-retour IPC de `setAudioCapture`. Le
  budget Chromium est de ~5 s et l'aller-retour très en dessous, mais ce n'est plus
  une garantie d'ordre, c'est une marge.

Mesuré côté harness : la seconde capture **du même écran** (vérifié par
`display_id`, pas supposé) ne perturbe pas la session WGC en cours — 30 images sur
les 400 ms où les deux coexistent réellement, session non fermée.

Le passage de 1 à 2 apps coupées **change la sémantique en silence**, et c'est la
limite principale du modèle. Le panneau l'annonce pendant toute la durée où c'est
vrai (dérivé du mode réellement actif, pas d'un décompte de coches).

Limites assumées, toutes constatées :

- **En mode inclusion, la liste est un instantané.** L'inclusion ne connaît que
  les apps nommées : une app **lancée après** est muette, les apps sans fenêtre et
  les sons propres de Windows aussi. Elle apparaît alors **décochée** — ce qui est
  la vérité — et la cocher l'ajoute. Rien ne se ré-arme dans le dos du host. Avec
  **une seule** app coupée, l'exclusion n'a pas ce problème : c'est exactement
  pour ça que le cas particulier existe.
- **Une app coupée qui se minimise en tray garde sa ligne.** Elle sort de
  `Get-Process | Where MainWindowHandle` alors que son process, et sa session,
  tournent très bien. La ligne survit à la disparition du listing, sinon le host
  n'aurait plus rien à voir ni à défaire — et le tray est l'état le plus courant
  de Discord. Sortir du listing n'est donc **pas** un signal d'obsolescence.
- **Une app par nom d'exécutable.** Deux fenêtres de la même app (deux profils
  Chrome, deux Notepad) sont deux PID racines sous un même nom ; la liste n'en
  montre qu'un, et c'est cet arbre-là qui est visé.
- **Seules les apps avec une fenêtre visible sont listées** — c'est ce qui donne
  le PID racine gratuitement (voir Technique). Discord réduit dans la barre des
  tâches en sort donc, ce qui est son état le plus courant. L'UI le dit.
- **Toutes les fenêtres n'ont pas de process propriétaire résoluble.**
  `MainWindowHandle` ne nomme **qu'une** fenêtre par process : une deuxième
  fenêtre de haut niveau (un pop-out Chrome, un second éditeur) n'a aucune
  correspondance. Partager celle-là bascule sur le son système complet, et l'UI
  l'annonce plutôt que de prétendre isoler l'app.
- **Si une app capturée redémarre** (Discord se met à jour tout seul), son PID
  change et la session pointe sur un mort. C'est le **seul** cas qui ré-arme :
  PID vu dans le listing ≠ PID de la session → on renvoie **le même spec**, jamais
  une re-dérivation qui pourrait viser autre chose. Entre les deux, l'app redevient
  audible. Pas de surveillance de process : mesuré, la capture **survit** à la mort
  de la cible et le reste du son continue de passer — les viewers ne tombent jamais
  dans le silence.
- **Pas de pré-décochage des clients vocaux**, contrairement à la maquette. La
  liste ne peut pas être juste (`DiscordCanary`, Vencord, Teams…), elle est fausse
  quand on partage justement un appel Discord, et son mode d'échec est
  *inaudible*. Ça n'économiserait qu'un clic, dans un panneau déjà ouvert.

**Coût de N sessions** : mesuré, 16 sessions concurrentes démarrent en 5 ms (0
échec), tiennent 4,1 Mo de RSS et s'arrêtent en 3 ms — sur une machine réelle qui
compte 8 apps fenêtrées après déduplication. Le volume IPC ne suit pas le nombre
de sessions mais le nombre d'apps qui **jouent** réellement (l'addon jette les
buffers silencieux) : sur ces 16 sessions, 2 émettaient.

```
// ponytail: cases à cocher, pas de mixer par app. Des sliders de volume par
// application, c'est une table de mixage — c'est OBS, pas nous. Si la demande
// arrive vraiment, le tout-ou-rien par app en est le sous-ensemble, rien à jeter.
// ponytail: pas de plafond sur le nombre de sessions, cf. la mesure ci-dessus.
```

#### Technique

- **Capture** : WASAPI process loopback
  (`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`, Windows 10 build 20348+), via
  `loopback-capture` (C++ N-API — successeur de `application-loopback`, déprécié).
  `start(pid, includeProcessTree, cb)` : le booléen à `false` sélectionne
  l'exclusion. Une instance = une session ; le main en tient une **liste**, et
  chaque instance y entre au moment où elle démarre — c'est la seule chose capable
  d'arrêter une session orpheline. Format figé dans le C++ : **PCM 48 kHz, 16 bits, stéréo,
  entrelacé**, par paquets de 1920 octets = 10 ms (~100 callbacks/s). Le 48 kHz
  tombe pile sur l'`AudioContext` d'`audio.ts` : **aucun rééchantillonnage** nulle
  part. L'addon **jette les buffers silencieux** (seuil −70 dB) : le flux n'est
  pas continu, un consommateur qui attend des données en permanence se fige.
- **Énumération** : `Get-Process | Where MainWindowHandle -ne 0` (PowerShell, un
  spawn de ~240 ms à l'ouverture du panneau). Le filtre sur la fenêtre visible
  donne **exactement le PID racine** — vérifié : le Discord fenêtré est le parent
  de ses cinq autres process. `tasklist /V` ferait pareil mais met **15 s** (il
  résout les comptes utilisateur).
- **Injection dans WebRTC** : chaque paquet de 10 ms est ordonnancé comme un
  `AudioBufferSourceNode` dans un `MediaStreamAudioDestinationNode`, puis mixé par
  l'`audio.ts` existant, qui le reçoit comme une piste système ordinaire — **il
  n'a pas été touché**. Pas d'`AudioWorklet` : il faudrait un fichier séparé dans
  `public/` que Vite ne bundle pas (donc non testable), et l'abandon des buffers
  silencieux rend l'ordonnancement *plus* simple qu'un worklet, qui devrait
  synthétiser du silence. **Ne pas** passer par `MediaStreamTrackGenerator`
  (breakout box) : non-standard, Chromium seul, refusé par Mozilla — et il
  n'existe pas d'`AudioTrackGenerator`. Chaque paquet est **étiqueté du nom de son
  app** et ordonnancé sur son propre curseur : plusieurs sessions arrivent
  entrelacées sur un seul canal IPC, et un curseur partagé ferait qu'un paquet sur
  deux tomberait dans le passé — un bégaiement permanent sur tous les flux. Ils se
  mélangent dans le graphe audio, où ils alimentent le même nœud de destination.
- **Packaging** : `extraResources` copie le **`.node` nu**, requis par chemin
  absolu. Surtout pas `require('loopback-capture')` : son `dist/index.cjs` passe
  par le paquet `bindings`, donc l'embarquer traînerait un `node_modules` dans
  l'installeur — et une CI verte livrerait un binaire qui plante. `app.asar` reste
  à trois fichiers.

#### La régression à assumer : les onglets de navigateur

Le loopback WASAPI capture un **process**, or un navigateur rend l'audio de tous
ses onglets dans un même process de service audio. Donc **partager un onglet
Chrome depuis l'app donnera le son de tout Chrome**, là où le web isole l'onglet.
C'est le seul point où le navigateur fait mieux, et aucun framework n'y change
rien. **Pas encore mitigé** : l'UI ne signale pas qu'une source est une fenêtre de
navigateur. À faire si ça mord.

#### Spike (phase 0) — répondu, mesuré

- **Le risque n°1 n'existe pas.** On craignait qu'en ciblant le PID racine d'une
  app multi-process (Discord, Chrome), le son rendu par son process de service
  audio séparé échappe à l'exclusion. Mesuré sur une vraie app Chromium :
  INCLURE l'arbre du racine = 396 paquets, l'EXCLURE = **0**. La sémantique
  d'arbre couvre bien le service audio. Discord étant une app Electron, le cas
  motivant est couvert.
- **Résoudre l'app → PID racine est gratuit** : le filtre « a une fenêtre
  visible » le donne (voir Technique). Le redémarrage est absorbé à la réouverture
  du panneau.
- **Pas d'énumération WASAPI des apps qui émettent** : on liste les apps avec une
  fenêtre, pas celles qui jouent du son. Suffisant — on cherche Discord, pas un
  VU-mètre.
- L'addon **tourne sous Electron**, pas seulement sous Node.

### Sélecteur de source natif

Le web impose la boîte de dialogue de Chrome ; la maquette
([`mockup.html`](./mockup.html)) avait sa propre grille. Le desktop la rend
possible :

- `desktopCapturer.getSources` (main process Electron depuis la v17) retourne les
  écrans et fenêtres avec **vignettes** (`thumbnail`) et **icônes d'application**
  (`appIcon`, via `fetchWindowIcons`).
- Notre grille : vignettes, icônes, recherche — l'UI de la maquette, telle quelle.
  Les vignettes sont un **instantané pris à l'ouverture**, pas un aperçu live :
  rafraîchir voudrait dire re-capturer tous les écrans et fenêtres en boucle
  (mesuré : ~540 ms l'appel avec vignettes, 9 sources). Réouvrir le sélecteur
  suffit.
- Le choix est appliqué via `setDisplayMediaRequestHandler`, qui **intercepte** la
  demande de capture et lui passe la source retenue — donc **pas de re-consentement
  navigateur**. En web, `surfaceSwitching: 'include'` permettait déjà de changer de
  source sans re-prompt ; ici on maîtrise tout le geste.

C'est aussi la fonctionnalité qui **exclut Tauri / Wails / Deno** : aucun n'a
d'équivalent `desktopCapturer` (cf. [Techno](#techno--electron)).

**Livré (phase 2).** `electron/src/main.ts` expose `ss:sources` (liste + vignettes
+ icônes) et `ss:select-source` (nomme le choix) ; `src/lib/source-picker.ts`
tient la grille. Trois pièges rencontrés à l'écriture, tous vérifiés sur machine :

- **`ss:select-source` doit être `invoke`, pas `send`.** L'identifiant et l'appel
  `getDisplayMedia` empruntent deux pipes IPC différents : rien ne les ordonne. En
  fire-and-forget, ça partage la source précédente une fois de temps en temps.
- **Le handler relit les sources**, il ne réutilise pas celles envoyées à la
  grille : une fenêtre peut se fermer entre la liste et la confirmation, et un
  `DesktopCapturerSource` périmé donne une piste morte. Relecture en
  `thumbnailSize: {0,0}` (Electron saute la capture d'image ; ~310 ms au lieu de
  ~540 ms).
- **Aucun repli, jamais.** Une source choisie qui a disparu fait échouer la
  capture ; une demande sans source choisie échoue aussi. `setDisplayMediaRequestHandler`
  **est** le consentement — ce qu'il renvoie part sans prompt système — donc il ne
  répond que ce que l'utilisateur a désigné. L'ancien repli « rien de choisi →
  écran principal » était inatteignable par l'app (`capture()` passe toujours par
  le sélecteur) : il ne servait plus qu'à du code qui n'est pas le nôtre, pour le
  plus large partage possible.

**Si la source disparaît en cours de partage** (fenêtre fermée), rien de spécial
n'a été ajouté : on compte sur `ended`, que `host.ts` câble déjà sur `stopSource`
— l'host retomberait sur « choose source », la room et les viewers survivant, les
viewers passant en écran d'attente, exactement comme au « Stop sharing » du
navigateur (ce chemin-là, lui, est couvert en e2e). **Non vérifié** en revanche :
qu'une piste WGC émette bien `ended` quand la fenêtre se ferme sous Windows,
plutôt que de rester vivante sur un cadre noir. À tester à l'occasion.

Trois détails de plateforme constatés : `appIcon` peut être **non-null mais vide**
(rendu en `<img>` cassé si on ne teste pas `isEmpty()`) ; `screen.getAllDisplays()`
raisonne en **DIP** — un 2560×1440 à 150 % s'annonce 1707×960 si on n'applique pas
`scaleFactor` ; et `nativeImage.toDataURL()` encode en **PNG sans perte**,
synchrone sur le thread main, ce qui est absurde pour une vignette (mesuré sur un
écran : 120 Ko en PNG contre **10 Ko en `toJPEG(70)`**, ×12). Une session Windows
réelle compte 30-60 fenêtres — l'icône garde PNG, elle a besoin de l'alpha.

### HDR

Une source HDR partagée arrive **surexposée, hautes lumières cramées** chez le
viewer : ciel et zones claires écrasés à blanc, irrécupérables.

**Cause, structurelle.** Le capteur `getDisplayMedia` de Chromium capture dans un
buffer **8 bits BGRA SDR** et écrase le HDR par un simple **clamp à [0,1]**, sans
aucun tone-mapping — tout ce qui dépasse le blanc SDR s'effondre sur la même
valeur haute. C'est câblé dans le capteur WebRTC (`wgc_capture_session.cc` demande
explicitement du BGRA8) et la spec W3C Screen Capture prévoit elle-même ce clamp.
**Confirmé sur Windows 11 24H2 + Chrome à jour : jamais corrigé, sur aucune
version.**

> Piège vérifié : la bascule Chromium vers Windows Graphics Capture (avril 2025)
> a corrigé un **autre** symptôme — les couleurs _ternes / désaturées_ (mauvais
> espace colorimétrique) — pas les hautes lumières cramées. Deux bugs distincts ;
> le second est intact et le restera (limitation structurelle, pas un bug ouvert).

**Contrainte de fond : le flux WebRTC est SDR 8 bits, point.** Aucun chemin
HDR / 10 bits / BT.2020 n'est négociable sur une `RTCPeerConnection` en 2026 (VP9
profil 2, AV1 Main10, HEVC Main10 : capacités codec, jamais offertes dans le SDP
WebRTC). Donc **il faut tone-mapper en SDR avant d'entrer dans la peer
connection** — la question n'est pas _si_ on convertit, mais _comment_. Le web
fait un clamp brutal ; nous, on peut faire mieux — mais une seule façon compte :

**Tone-map correct (phase capture native).** Faire ce que fait OBS : capturer la
surface native (Windows Graphics Capture en `R16G16B16A16_FLOAT` / scRGB, le HDR
intact), appliquer **notre** tone-map HDR→SDR avec un « SDR white level » réglable
(BT.2390 est le standard de référence), puis injecter les frames.
**Web-impossible par construction**, durable — mais couplé au chantier lourd
ci-dessous.

> **L'avertissement HDR est abandonné** (2026-08-01). Le plan prévoyait un
> pansement de phase 2 : lire l'état HDR courant du compositeur via
> `DXGI_OUTPUT_DESC1` (`IDXGIOutput6::GetDesc1`, champ `ColorSpace`) — ce que le
> web ne sait pas faire, `matchMedia('(dynamic-range: high)')` ne donnant que la
> **capacité** de l'écran, jamais son état — et afficher « votre HDR est allumé,
> coupez-le (`Win+Alt+B`) ». Techniquement juste, produit médiocre : ça demande à
> l'utilisateur de dégrader son propre écran pour arranger le nôtre, et ça coûte
> un binding natif de plus pour du texte. Si le HDR gêne vraiment, la réponse est
> le tone-map ci-dessus, pas un bandeau.

### Capture native : le spike a réduit le périmètre à une seule feature

La phase 3 était décrite comme **une brique commune** — sortir du pipeline
`getDisplayMedia`→track de Chromium et reprendre la main sur les frames (WGC/DXGI →
traitement → injection) — débloquant d'un coup quatre fonctionnalités. Un spike de
pure mesure (2026-08-03) avant toute ligne de C++ en a tué trois. Aucune n'est
tombée pour la raison qu'on attendait.

| Ligne annoncée         | Ce que la mesure a dit                                                                                                                            | Devenu                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| **Encodage hardware**  | Le blocage n'était **pas** la capture : c'était `CODEC_PREFERENCE` (VP9 en tête). **NVENC n'encode pas VP9**, jamais. H.265 et H.264 atteignent le MFT NVIDIA sur une track `getDisplayMedia` ordinaire. | **Livré** — un tableau réordonné |
| **FPS garanti 120/144**| `getSettings().frameRate` rend bien **120**, et VP9 *software* tient **119 fps en 1080p avec 0 s de limitation CPU**. Le plafond réel était la source (un bureau immobile produit ~28 fps) et le débit. | **Faux problème**          |
| **Contrôle du curseur**| En jeu, le curseur est rendu **par le jeu**, pas par le curseur matériel de l'OS : `IsCursorCaptureEnabled` n'y changerait rien. Ne sert qu'à le retirer en bureautique, ce que personne n'a demandé. | **Abandonné**              |
| **Tone-map HDR**       | Inchangé : le clamp arrive **au capteur**, aucun post-traitement JS ne récupère quoi que ce soit. Seule ligne réellement web-impossible.            | **Reste** — cf. [HDR](#hdr) |

```
// ponytail: la phase 3 promettait 4 features pour une brique. Après mesure il
// reste 1 feature pour 1 brique, et 2 des 3 disparues se sont livrées en
// réordonnant un tableau. Mesurer avant de construire a économisé le chantier.
```

**L'erreur d'analyse, pour mémoire** : on soupçonnait le *backing* des frames —
Chromium retombant en software sur une track injectée dont les `VideoFrame` sont
CPU-backed. C'était la mauvaise variable. La bonne était le codec, et elle se
testait sans écrire une ligne de natif. Chiffres, tableau des viewers et limites du
banc : [`webrtc-media.md`](./webrtc-media.md) § Codec.

#### Le pilote OBS : la valeur, prouvée avant le C++ (2026-08-03)

Avant d'écrire une ligne de natif, on a fait faire le travail à OBS — qui exécute
exactement le pipeline visé (WGC scRGB → tone-map → SDR) — et mesuré le résultat
avec le même outil des deux côtés (`tools/hdr-acceptance.mjs`) :

| Sur la même source, à la même seconde | Chromium | OBS (WGC + tone-map) |
| -------------------------------------- | -------- | -------------------- |
| Hautes lumières écrêtées à blanc pur   | **81,1 %** | **0 %**            |
| Valeurs de luma distinctes             | 21       | *(rien au-dessus de 235)* |
| Luma max                               | 255      | 209                  |

**La prémisse est vérifiée** : le HDR n'est pas détruit par WGC, il l'est par le
convertisseur de Chromium — donc l'information est là et un tone-map la récupère.
Deux effets de bord relevés : le tone-map remonte aussi les **noirs** du contenu SDR
autour (49,7 % de la frame sous 16 devient 0,7 %), et la plage haute reste
inutilisée avec les réglages par défaut. C'est le « niveau de blanc SDR », le bouton
de calibration que **seul un œil peut régler**.

Sous-produit gardé : le sélecteur accepte désormais les **caméras**
(`listCameras` dans `source-picker.ts`, capture par `getUserMedia`). Une source
caméra n'apporte **aucun son** — les viewers n'entendent rien tant qu'aucune app
n'est cochée dans le panneau audio, qui passe par WASAPI indépendamment de la vidéo.

#### Les portes du chantier natif, mesurées

- **G1 — une track injectée atteint-elle l'encodeur matériel ? ✅ Oui.** La question
  la plus lourde depuis qu'on préfère H.265, qui **n'a aucun repli logiciel** dans
  Chromium : une track qui n'atteint pas NVENC ne dégrade pas, elle peut **noircir**.
  Mesuré sur la *même* source WebGL injectée : H.265 à **2,5 ms/frame**, VP9 à
  **15,5** — un facteur 6,2, impossible en software. Vrai pour les frames CPU
  (`VideoFrame` depuis un `ArrayBuffer`) **comme** GPU. À noter : Chromium 150
  n'expose pas `VideoTrackGenerator`, seulement `MediaStreamTrackGenerator`.
- **G2 — le coût de transport d'une frame. ❌ L'IPC ne suffit pas.** Mesuré à
  **~102 Mo/s** (`webContents.send`, frames de 3,1 Mo : 0 perdue, mais 30,5 ms entre
  chacune au lieu de 16,7 — la file grandit sans borne). Un addon dans le main
  process plafonne donc à **720p60 ou 1080p30** ; 1080p60 exige 187 Mo/s, la 4K60
  en exige 746. Détail utile : **Electron convertit un `Buffer` en `Uint8Array`** à
  la traversée, il y a bien recopie et non transfert.

  **Décision : l'addon vivra dans le preload, avec `sandbox: false`.** Aucune
  traversée, donc aucun plafond. Ce qu'on accepte, en toutes lettres : on retire le
  bac à sable OS du process qui parse les **SDP, ICE et messages `control` venus de
  viewers arbitraires**. La page reste verrouillée sur `app://`, `contextIsolation`
  et `nodeIntegration: false` restent en place — le vecteur n'est pas la page, c'est
  ce parseur-là. L'alternative était de livrer une capture native **moins fluide**
  que le `getDisplayMedia` actuel (mesuré à 119 fps en 1080p), ce qui vidait la
  feature de son sens.

#### Ce qui est construit

`electron/native/` — addon N-API brut (pas de `node-addon-api` : une fonction ne
justifie pas une dépendance). `pnpm build:native` fige le couple
`--target` / `--dist-url`, et ce n'est pas cosmétique : un addon compilé contre
l'ABI de Node se charge sous `node` et **échoue dans Electron**, le seul endroit où
il tourne.

> **L'addon doit être empaqueté, et il ne l'était pas.** `streamshare_capture.node`
> ne figurait dans aucun `extraResources`, et ni `dist` ni `release` n'appelaient
> `build:native`. Tout build installé prenait donc le `catch` du chargeur, écrivait
> une ligne dans la console et **perdait le HDR sans que rien n'échoue** — la panne
> exacte que l'en-tête de `native-addon.ts` prétendait empêcher. Corrigé et vérifié :
> le fichier est présent dans `resources/` de l'app packagée.
>
> Note d'environnement : `electron-builder` échoue en `EPERM` quand il écrit dans
> `release/` sur `H:` (au dépaquetage d'Electron, avant nos ressources). Pour
> vérifier, sortir ailleurs :
> `pnpm exec electron-builder --dir --config.directories.output=C:\Temp\ss-pack`.

Première pièce, l'**interrupteur** : `IDXGIOutput6::GetDesc1` rend l'espace
colorimétrique *courant* du compositeur (`G2084` = HDR allumé). Le web ne sait pas
répondre à ça — `matchMedia('(dynamic-range: high)')` donne la **capacité** de
l'écran, jamais son état. Le drapeau remonte **par source** dans `ss:sources`, parce
que partager l'écran SDR d'une machine qui en a aussi un HDR ne doit pas emprunter
le chemin natif.

L'association écran Electron ↔ sortie DXGI vit dans `nativeDisplayFor`
(`config.ts`, testée) : Electron n'expose jamais le nom de périphérique Windows d'un
`Display`, et DXGI ignore l'id d'Electron, donc **le rectangle du bureau est la
seule chose que les deux connaissent**. On associe par **origine** et non par
taille — deux écrans ne partagent pas une origine, alors que deux moniteurs
identiques partagent une taille. Extraite et testée parce que son mode de panne est
**silencieux** : rendre `null` pour un écran réellement en HDR laisserait l'app sur
le chemin clampé, avec un sélecteur d'apparence normale et aucune erreur nulle part.

Deuxième pièce, la **capture** : `Direct3D11CaptureFramePool::CreateFreeThreaded`
en `R16G16B16A16Float` (scRGB — les hautes lumières arrivent **au-dessus de 1.0** au
lieu d'être clampées), tone-map en HLSL sur le GPU, readback BGRA8. Le pool
free-threaded livre sur un thread du pool WinRT, ce qui évite d'avoir à faire tourner
un `DispatcherQueue`.

**Et c'est la contrainte structurante de ce fichier.** `ID3D11DeviceContext` n'est
pas thread-safe (le *device* l'est, le contexte immédiat non), rien ne promet que
deux `FrameArrived` ne se chevauchent pas, et `stopCapture()` arrive du thread JS
pendant tout ça. Retirer le handler arrête les **nouvelles** livraisons ; ça ne
**joint** pas celui qui tourne déjà, et ça ne débloque surtout pas celui qui attend
dans `Map()`. Libérer le device sous ses pieds est un use-after-free avec une
fenêtre assez large pour toucher un utilisateur et assez étroite pour manquer un
banc. Donc : un mutex sérialise **tout** le chemin de frame et la destruction, et
`Stop()` retire le handler **avant** de prendre le verrou — c'est le verrou qui
attend la frame en vol, et le prendre d'abord se bloquerait contre elle.
Les statistiques ont leur propre verrou, pour que les lire ne freine jamais la
capture.

Deux détails qui se voient à l'image : la texture du pool est seulement **au moins**
aussi grande que le contenu, donc le shader échantillonne un sous-rect (sinon
l'image s'étire entre un changement de résolution et le `Recreate` qui suit — c'est
-à-dire pile quand un jeu passe en plein écran) ; et `sdrWhiteNits` est accompagné
de `sdrWhiteMeasured`, parce que le repli à 80 est un nombre parfaitement crédible
et que rien ne distinguerait sinon une mesure d'un échec de lecture.

##### Les portes, mesurées (`tools/wgc-latency.cjs`)

La sonde **sort en code non nul** si une porte lâche. Deux propriétés sans
lesquelles ce ne serait qu'un rapport :

1. **L'absence de donnée échoue.** La première version faisait l'inverse : sans
   aucune frame, `gpuAvg + copyAvg` valait 0 (sous le budget), `failed` valait 0
   et `!image` court-circuitait l'écrêtage à `true`. Trois feux verts sur une
   capture vide — et c'est exactement le run qu'elle a validé une fois.
2. **La sonde crée son propre mouvement.** WGC ne livre que sur changement : sur
   un bureau immobile on mesure ~24 fps, parfois 0,2. Elle ouvre donc une petite
   fenêtre qui repeint à la fréquence de l'écran, en gris sombres pour ne pas
   polluer les statistiques de hautes lumières.

Mesuré sur **255 frames à 51 fps**, écran 2560×1440 HDR :

| Porte | Seuil | Mesuré |
| ----- | ----- | ------ |
| Assez de frames pour conclure | ≥ 20/s | **255 en 5 s** |
| Écran réellement en HDR | vrai | `\\.\DISPLAY1` |
| **Pire** frame dans le budget | < 16,7 ms | **10,81 ms** (moyenne 7,51) |
| Échecs du chemin GPU | 0 | **0** |
| Frame sautée par le pool (`gap`) | ≤ 40 ms | **20,9 ms** |
| Hautes lumières écrêtées | ~0 % | **0 %** |
| Détail des hautes lumières | ≥ 8 valeurs | **10** sur 157 906 px |
| Survit à un `stop()` en pleine frame | 8/8 | **8/8** |

La porte du budget prend le **maximum**, pas la moyenne : un budget par frame se
viole avec une seule frame à 40 ms, et une moyenne l'efface.

La dernière porte vise le use-after-free décrit plus haut : elle arrête la capture
à huit instants différents pendant que les frames arrivent, et appelle `stop()` deux
fois. Son symptôme d'échec n'est pas une assertion, c'est un process mort — pas de
JSON, pas de verdict.

Et l'ensemble est falsifiable, vérifié en le cassant : `SS_SDR=80` (le mauvais blanc
SDR) donne **70,2 % d'écrêtage** et un code de sortie 1.

> **Ce que ces chiffres ne disent pas.** Le GPU est par ailleurs oisif : personne
> ne joue pendant la mesure. Or le seul contexte où quelqu'un a du HDR à partager
> est précisément un GPU chargé, et `Map()` y attend derrière le travail du jeu.
> Le « il reste ~6 ms pour l'encodeur » ne suit que si capture et encodage sont
> concurrents — ce que rien ici ne mesure encore. La porte reste utile (elle échoue
> si le chemin GPU se dégrade), elle n'est pas une garantie de fluidité en jeu.

> **« 0 % d'écrêtage » seul ne prouve presque rien.** L'épaule est asymptotique :
> pour sortir 255 il faut ~1,96× le blanc SDR, soit 940 nits sur une dalle qui
> plafonne à 760. N'importe quelle courbe compressive monotone passerait cette
> porte, y compris une qui écrase toutes les hautes lumières sur deux valeurs.
> C'est `distinctHighlightLuma` qui départage — d'où la dernière ligne du tableau.

##### Le niveau de blanc SDR : le placeholder mentait de 6×

`sdrWhiteNits` n'est plus codé en dur. Il vient de `DisplayConfigGetDeviceInfo` /
`DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL` — DXGI ne le donne pas, et il faut
traduire un nom GDI en couple adaptateur/cible pour l'obtenir. Sur la machine de
dev il vaut **480 nits**, pas 80. Ce n'est pas un détail de calibration, c'est le
diviseur dont dépend toute la courbe :

| Blanc SDR utilisé | Écrêtage | Luma max |
| ----------------- | -------- | -------- |
| 80 (l'ancien placeholder) | **70,1 %** | 255 |
| 160 | 41,2 % | 255 |
| **480 (mesuré)** | **0 %** | 244 |

##### La courbe : épaule exponentielle, pas Reinhard

Premier jet en Reinhard étendu. Mesure : blanc SDR rendu à **219 au lieu de 255**,
luma moyenne 11. Reinhard est un opérateur *scene-referred* — il assombrit les 99 %
de l'image qui n'ont jamais été HDR pour faire de la place aux 1 % qui le sont.

Remplacé par `1 - (1-k)·exp(-(c-k)/(1-k))` au-dessus d'un genou fixe à 0,75 :
identité en dessous (un bureau SDR fait un aller-retour **inchangé**), asymptote
vers 1 au-dessus, et C¹ au genou donc aucune bande visible. Face au pilote OBS que
l'utilisateur avait validé : même 0 % d'écrêtage, **plus** de plage haute conservée
(luma max 244 contre 209) et, contrairement à OBS, les noirs ne sont **pas**
remontés.

> Ce que la sonde ne dit pas : le genou à 0,75 et le blanc SDR restent des réglages
> qu'aucune mesure ne peut trancher à la place d'un œil. Le blanc SDR est **réglable
> depuis la modale** (§ Le blanc de référence, réglable) ; le genou reste fixe, faute
> d'un utilisateur capable de raisonner sur une forme de courbe.

#### G3 — la frontière preload → page, et la sortie vers l'encodeur

L'addon tourne dans le **preload** (c'est ce que `sandbox: false` avait acheté).
Restait une frontière : `contextIsolation: true` sépare le preload de la page en
deux contextes V8, et `contextBridge` **clone** tout ce qui passe. Mesuré
(`tools/bridge-bench.cjs`) :

| Voie | 1080p (8,3 Mo) | 1440p (14,7 Mo) |
| ---- | -------------- | --------------- |
| `contextBridge` (clone) | 7,98 ms/frame | 11,55 ms/frame |
| `postMessage` + **transfert** | **1,17 ms/frame** en régime 60 fps | — |

`postMessage` accepte une liste de transfert, `contextBridge` non. La `VideoFrame`
est donc construite **dans le preload** et *déplacée* vers la page, sur un
`MessagePort` dédié — pas `window.postMessage`, pour ne pas réveiller tous les
écouteurs de la page 60 fois par seconde et pour que rien d'autre ne puisse
injecter une frame. L'écriture dans la track coûte 0,019 ms.

> Une `VideoFrame` tient un buffer matériel. En laisser filer une trentaine bloque
> le renderer — mesuré, en dur, la première version du banc s'est plantée dessus.
> Chaque chemin de `native-video.ts` écrit la frame (la track la ferme) ou la ferme
> lui-même.

**Acceptance de bout en bout** (`tools/native-track.cjs`, qui charge le *vrai*
preload et importe le *vrai* `src/lib/native-video.ts`) :

| Porte | Mesuré |
| ----- | ------ |
| Addon chargé dans le preload | ✅ |
| Track vivante, reçue par un pair | ✅ |
| Frames encodées | **367 sur ~7 s** (≈52 fps) |
| Résolution | **2560×1440**, pleine |
| **L'image est réelle et bouge** | ✅ |
| Aucune perte silencieuse | `failed=0 undelivered=0 orphaned=0` |
| **Arrêt puis redémarrage** | ✅ |
| Encodeur matériel | **H265** |
| Contre-pression | **0** |
| `stop()` arrête vraiment | ✅ |

> La fenêtre est de ~7 s (1 s d'échantillon + 6 s), pas 6 : `framesEncoded` est
> cumulatif depuis l'ouverture du pair. Le premier jet de ce tableau divisait par 6
> et annonçait 55 fps.

Trois choses que cette mesure a corrigées :

- **Les pertes venaient du démarrage, pas du débit.** 9,8 % de frames perdues au
  total ; en séparant les phases : **37 pendant la seconde de négociation SDP, puis
  0 sur les six suivantes**. Un balayage de la profondeur de file (1, 2, 3) donnait
  le même taux — la preuve que ce n'était pas de la mise en file. La file reste donc
  à **1**. Réutiliser le buffer de frame a ensuite supprimé jusqu'à cette rafale : le
  chiffre actuel est 0 de bout en bout.
- **Ce n'est pas « la plus récente gagne ».** Formulation fausse, écrite quatre fois
  avant qu'une revue ne la lise contre l'API : une file pleine fait rejeter la frame
  **entrante**, pas celle déjà en file. La propriété réelle est « on ne met jamais en
  file » — sous charge soutenue on livre donc une frame de retard. C'est toujours le
  bon compromis contre une file qui, elle, transforme un à-coup en latence définitive.
- **`encoderImplementation` n'existe pas sous Electron 43.** Ni
  `powerEfficientEncoder` — absents de l'objet stats, pas vides (vérifié via
  `Object.keys`). L'encodage matériel s'établit donc par élimination : Chromium n'a
  **aucun** encodeur HEVC logiciel. La porte est *sautée* — et non rouge — sur une
  machine sans H.265 matériel : elle testerait la machine, pas le code.

Et une porte qui manquait entièrement : **rien ne vérifiait que l'image contenait
quelque chose**. Toutes les autres sont satisfaites par un flux noir ou par une image
figée — c'est exactement la forme que prend la panne du buffer réutilisé. Le harness
tire maintenant deux frames de la track *reçue*, à une seconde d'intervalle, et exige
qu'elles soient non nulles et différentes.

##### Partager une app, pas seulement un écran

Le HDR marchait sur un écran entier et **pas** sur une fenêtre de ce même écran. Ce
n'était pas le tone map : `desktopCapturer` ne rapporte **aucun `display_id` pour une
fenêtre** (mesuré : 0 sur 4), donc rien ne la reliait à une sortie HDR, `hdr` restait
faux, et chaque partage d'app repartait sur `getDisplayMedia`, qui clampe.

WGC sait capturer une fenêtre seule, mais encore fallait-il savoir **dans quel espace
colorimétrique**. Mesuré avant d'écrire la feature (`tools/window-hdr-probe.cjs`) — une
fenêtre gris moyen `#808080`, capturée à travers le même tone map, même diviseur :

| | mesuré | prédit |
|---|---|---|
| sur l'écran HDR (480 nits) | **128** | 128 si scRGB |
| sur l'écran SDR (80 nits) | **53** | 56 si déjà composité |

L'espace **suit l'écran**. Le tone map n'a pas changé d'une ligne ; en revanche le
diviseur doit suivre la fenêtre quand elle change d'écran — sinon il est faux d'un
facteur 6, ce qui est exactement le bug qu'on répare.

> Le premier témoin échantillonnait le rectangle de la fenêtre dans une capture
> d'**écran** et n'y trouvait que le bureau. La raison vaut d'être notée : **WGC rend la
> surface propre d'une fenêtre, qu'elle soit visible ou non** — donc la géométrie ne
> prouve rien ici. Le témoin retenu est le différentiel ci-dessus.

Deux comportements qu'un écran n'a jamais, mesurés eux aussi :

- **Fenêtre réduite** : zéro frame, et l'item n'est **pas** signalé fermé. Sans un
  drapeau explicite, la page ne peut pas la distinguer d'une capture morte et le
  répéteur terminerait le partage au bout de 2 minutes — pour un hôte qui a juste rangé
  une fenêtre. `minimized` remonte dans les stats et gèle le compteur d'abandon.
- **Fenêtre fermée** : `GraphicsCaptureItem::Closed` **se déclenche**, donc le partage se
  termine proprement par le chemin qui existait déjà.

**Le changement de source passe par un noir, et il faut le tenir court.** Deux sessions
WGC ne peuvent pas coexister, donc passer d'une source native à une autre impose de
tuer l'ancienne avant de démarrer la nouvelle — et entre les deux, l'aperçu tient une
piste morte. Le symptôme remonté du terrain était exactement ça : écran noir, avec le
nom de la source précédente encore affiché (un GUID, à l'époque où c'était `track.label`
qui le fournissait). L'arrêt se faisait **avant** l'aller-retour `getDisplayMedia` de
l'audio, ce qui étirait le noir sur toute sa durée ; il se fait maintenant juste avant
le démarrage. Mesuré (porte du harness) : **178 à 256 ms**, soit le coût du
`startCapture` lui-même.

> Et le nom affiché ne vient plus de `track.label` : un `MediaStreamTrackGenerator` est
> étiqueté d'un GUID, que la scène affichait tel quel — pendant que le panneau de
> réglages, qui retombait sur le même label, annonçait « no source selected » sous un
> partage bien vivant. C'est le nom du sélecteur qui sert, sur les deux chemins.

**Une fenêtre s'approuve par son handle *et* son pid.** Windows recycle les handles :
la liste est prise à l'ouverture du sélecteur, et le temps que l'utilisateur confirme,
la fenêtre cliquée peut avoir disparu en laissant son numéro à une autre. `IsWindow()`
répondrait oui et on capturerait une fenêtre que personne n'a choisie — sans prompt de
l'OS derrière ce chemin pour rattraper. Le pid est relu au moment d'approuver ; s'il a
changé, on refuse. Les deux chemins voisins font déjà l'équivalent (`getDisplayMedia`
re-liste avant de confirmer, l'audio par app re-résout à chaque appel) ; celui-ci ne le
faisait pas, et c'était le seul sans garde-fou système.

Le diviseur reste la propriété du **renderer**, parce que la valeur envoyée est « ce que
rapporte l'écran × la correction de l'hôte » et que l'addon ignore la correction.
L'addon publie donc le blanc courant dans `captureStats()`, relu à chaque appel — 0,286 ms
pour l'interrogation complète des écrans, soit 0,06 % d'un cœur au rythme de 2 Hz auquel
le répéteur sonde déjà. Bénéfice gratuit : bouger le **curseur SDR de Windows** en cours
de partage est désormais pris en compte, sur les deux chemins, ce que rien ne détectait.

##### La porte de consentement du chemin natif

`setDisplayMediaRequestHandler` est documenté dans `main.ts` comme **étant** la porte
de consentement. Le chemin natif ne le traverse jamais : il pilote l'addon
directement. Autrement dit, tel qu'écrit d'abord, un XSS dans le bundle suffisait à
lancer une capture plein écran sans prompt et sans indicateur.

**La page ne nomme plus aucun écran.** Premier essai : elle recevait le `deviceName`
dans la liste des sources, le repassait à `startNativeCapture`, et le preload le
comparait à ce que `ss:select-source` avait mémorisé. L'association id → nom DXGI
était donc **dérivée deux fois** — dans `ss:sources` par `display_id`, dans
`ss:select-source` en reconstruisant `screen:${id}:0`.

> **Et la deuxième ne matchait jamais.** Mesuré sur Windows / Electron 43 :
> `desktopCapturer` rapporte `screen:0:0` et `screen:4:0`, quand les ids de `Display`
> valent 3646719705 et 3701595930. Le segment du milieu est un index de device, pas
> l'id d'écran — et il n'est même pas séquentiel. `approvedDeviceName` valait donc `''`
> en permanence, `startNativeCapture` refusait à tous les coups, et **le chemin HDR
> natif était inatteignable dans l'application** : chaque partage retombait sur
> `getDisplayMedia` avec un `console.error` pour toute trace. Il n'a jamais tourné
> qu'sous `tools/native-track.cjs`, qui s'auto-approuve. Ce n'est pas un durcissement
> théorique, c'est la réparation d'une fonctionnalité morte — et personne ne l'a vu
> parce que le repli est exactement le comportement normal en SDR.

Maintenant `startNativeCapture()` ne prend **pas** d'écran : le preload demande à main
lequel il a le droit de capturer, et main répond depuis la table construite en même
temps que la liste montrée au sélecteur. `hdr: true` suffit à dire « main tient une
sortie pour cette source ».

> Ce que ça ne fait **pas** : durcir la porte contre un renderer compromis.
> `selectSource(id)` reste exposé, donc du code hostile dans notre propre bundle
> désigne un écran par id au lieu de le désigner par nom — même capacité, autre
> monnaie. Ce qui disparaît vraiment, c'est la seconde dérivation et son mode de panne
> silencieux, et la fuite des noms DXGI vers une page qui n'en a aucun usage. Le vrai
> verrou reste que le bundle ne soit pas compromis.

La liste est oubliée quand les écrans changent et quand le renderer navigue ou
recharge : les noms DXGI sont des noms de **slot**, `\\.\DISPLAY2` peut désigner un
autre panneau après un débranchement, et un consentement ne doit pas survivre à la
page qui l'a donné (avant, il survivait au rechargement — c'est le seul vrai gain de
sécurité du lot).

Sur `display-added` / `display-removed`, **le choix est oublié aussi**. N'oublier que
la liste serait un demi-correctif : le sélecteur re-liste dès qu'il s'ouvre, avant le
moindre clic, et l'ancien id serait alors approuvé contre la nouvelle disposition — un
index `screen:N:0` ne désigne pas forcément le même moniteur une fois qu'un écran est
parti. Pas sur `display-metrics-changed`, qui se déclenche aussi pour un changement de
zone de travail : les ids nomment toujours les mêmes panneaux.

> Couverture unitaire : `pickerSources` et `approvedTargetFor`
> (`electron/src/config.test.ts`) — le HDR par source, la table réduite aux écrans HDR
> appariés, une fenêtre qui rapporterait un écran, un id jamais listé, une liste
> invalidée.

**Et le câblage, lui, est enfin exercé.** C'était le point aveugle du projet : rien ne
chargeait `electron/src/main.ts`, ce qui a laissé passer un `screen.on()` au niveau
module (interdit avant `app.ready`) — suite entièrement verte, application morte au
lancement. Deux scripts comblent ça, tous deux sur le **vrai** bundle sous Electron :

- **`tools/main-boots.cjs`** — l'app démarre-t-elle ? Charge `out/main.cjs`, attend une
  fenêtre sur `app://`. Vérifié capable d'échouer en réintroduisant le bug.
- **`tools/consent-gate.cjs`** — 10 portes qui pilotent la vraie page à travers le vrai
  preload : refus sans choix, refus sur un id jamais listé, refus sur une fenêtre,
  refus après rechargement, aucun nom DXGI dans le payload, et surtout **un écran HDR
  qui démarre pour de bon** (68 frames, 2560×1440, `closed=false`). Une porte de refus
  passe au vert pour n'importe quelle raison, donc la suite a été mutation-testée : en
  faisant approuver n'importe quel id, exactement les deux portes concernées tombent.
  Ce test a d'ailleurs trouvé un défaut dans lui-même — une capture laissée en cours
  fait répondre « capture already running » aux étapes suivantes, ce qui se lit comme
  un refus ; chaque tentative nettoie maintenant derrière elle.

#### Branché dans le produit

`capture()` route vers le natif quand l'écran choisi est en HDR, et retombe sur
`getDisplayMedia` à la moindre erreur. Trois choses ont été décidées par la mesure
plutôt que par l'intuition :

- **Le cap de résolution ne s'appliquait pas.** `getSettings()` sur une track générée
  rend `{deviceId, resizeMode}` — ni largeur ni hauteur — **tant qu'aucune frame n'y a
  été écrite**. Elle finit par rapporter `width`/`height`/`frameRate` (mesuré dans
  l'app en marche : 2560×1440 à 2,07 fps), mais trop tard : `applyVideoQualityTo`
  s'exécute avant la première frame, lisait donc 0, `effectiveScale` rendait 1, et
  toute l'échelle ne faisait **rien**. La hauteur vient maintenant de la première frame
  reçue ; `videoHeight` du `<video>` serait arrivé un événement trop tard lui aussi.
- **Le cap de fps ne peut pas passer par `applyConstraints`** — la track le refuse
  (`OverconstrainedError`). Il vit dans l'addon, avant le tone-map : une frame
  refusée ne coûte ni GPU ni readback. Mesuré : 9/s pour un cap à 10, 84 refusées.
- **Le chemin natif ne produit que de la vidéo.** L'audio système est demandé
  séparément, sa jumelle vidéo arrêtée — une piste loopback reste `live` et non mutée
  après ça. Et la demande passe **avant** `startNativeCapture` : `getDisplayMedia`
  exige une activation utilisateur transitoire, et démarrer l'addon (compilation du
  shader, device D3D) est synchrone et peut manger la fenêtre sur une machine froide.

##### Le répéteur, et ce qu'il a failli cacher

WGC ne livre que sur changement. Sans rien, l'encodeur n'a pas d'entrée sur un écran
immobile, ne peut pas répondre à une demande de keyframe, et **un viewer qui rejoint
pendant que l'hôte lit un document reste sur du noir**. D'où une frame répétée toutes
les 500 ms.

Mais un répéteur sans limite rend une capture **morte** indistinguable d'un écran
immobile : `Win+Alt+B` coupe le HDR, WGC s'arrête, et le flux continue d'afficher la
dernière image avec des stats vertes et un badge « live ». Il s'arrête donc dès que
l'addon signale `closed`, ou après `MAX_REPEATS` répétitions consécutives, et termine
la track — ce que `host.ts` écoute déjà comme « la source a disparu ».

`closed` est le vrai signal, immédiat et fiable ; le compteur n'est que le filet pour
un addon qui cesse de produire en se déclarant sain. Il valait 20 (10 s), et c'était
faux **du mauvais côté** : « rien ne change » est un état réel — un document en plein
écran, sans caret ni souris, peut passer des minutes sans une seule frame, l'horloge
de la barre des tâches ne bougeant qu'une fois par minute. Un faux positif **tue un
partage qui marche** ; un vrai positif tardif ne fait que retarder un arrêt que
l'utilisateur va déclencher lui-même. D'où 240 (2 min). Le vrai correctif serait un
signal de santé venant de l'addon, pas un nombre plus grand.

Et la détection tourne **avant** le garde « rien à répéter ». Une capture peut mourir
sans avoir jamais produit de frame — HDR coupé entre le choix de la source et la
première image — et traiter ça comme « rien à faire » laissait l'hôte sur un preview
**noir** étiqueté live, indéfiniment.

> Deux erreurs de conception attrapées en revue, toutes deux silencieuses : les frames
> répétées portaient **le même timestamp** (rebasées sur une frame source qui ne bouge
> pas), et la porte « écran immobile » passait au vert alors que le répéteur ne faisait
> rien — un bureau réel n'est jamais parfaitement immobile. La porte compare maintenant
> *encodées* et *capturées* : le surplus ne peut venir que des répétitions.

> **Et « terminer la track » ne se fait pas comme on croit.** `generator.stop()` met
> `readyState` à `ended` **sans émettre l'événement** — mesuré, et conforme à la spec
> (`ended` n'est pas émis quand c'est l'application qui appelle `stop()`). Le répéteur
> l'appelait : la capture morte était détectée, la track mourait, et `host.ts`
> n'apprenait rien — le bug même que le répéteur existe pour éviter. Seul l'arrêt
> **côté source** notifie, donc `writer.close()`. La distinction est portante dans les
> deux sens : un arrêt délibéré (`NativeCapture.stop()`) doit rester silencieux, sinon
> l'`ended` tombe pendant l'`await` de `capture()` et `stopSource()` s'exécute à chaque
> changement de source — la diffusion se dé-met en pause toute seule et les mutes
> per-app partent avec. Les deux sont tenus par des tests qui échouent sans le
> correctif (vérifié en le retirant).

**Ce qui reste vrai et non mesuré**, pour la suite du chantier natif :
- **WGC ne livre que sur changement.** Un bureau immobile rend ~24 fps, et 0,2 fps
  quand plus rien ne bouge. C'est une qualité (aucun encodage gaspillé) mais le
  chemin natif doit répéter la dernière frame si l'encodeur a besoin d'une cadence.
- **Le chemin GPU sous charge réelle.** Voir l'encadré du tableau : tout est mesuré
  GPU oisif.
- **La porte « écran immobile » du harness ne parle plus que quand elle le peut.**
  Sur cette machine, le même run donne 3 frames ou 52 sur la même fenêtre de 2,5 s,
  mover caché dans les deux cas — et couvrir tout l'écran capturé d'une fenêtre opaque
  toujours-au-dessus n'y change rien (38→39, 45→48). La cause n'est pas identifiée.
  La porte est donc **skippée** quand l'écran n'est jamais devenu immobile, comme celle
  du H.265 : sinon elle mesure la pièce. La logique du répéteur, elle, est couverte de
  façon déterministe en e2e (frames comptées sur la track elle-même).
- **Deux portes du harness varient avec la charge** (cadence encodée, résolution
  pleine) : sur une machine occupée l'encodeur descend à 1080p ou sous 20 fps. Elles
  alternent d'un run à l'autre sur du code identique.
- **Le routage est couvert depuis `e2e/desktop-hdr.spec.ts`**, mais seulement
  au-dessus du port. `fakeNative(page, { nativeCapture })` imite le contrat du
  preload — un `MessageChannel`, un `window.postMessage` synchrone, des `VideoFrame`
  transférées depuis un canvas — et le reste est du vrai code : le picker, `host.ts`,
  `native-video.ts`, le `MediaStreamTrackGenerator`. Ce qu'aucun de ces tests ne
  touche : l'addon, Electron, et le câblage IPC.
- **Le refus de la porte reste silencieux** : si main n'a aucune sortie DXGI pour la
  source choisie, `startNativeCapture` refuse et on retombe sur le chemin clampé —
  avec juste un `console.error`. La logique de la porte est testée unitairement
  (ci-dessus), pas son effet visible côté utilisateur.
- **`startCapture` bloque 171 ms** (device D3D, deux compilations HLSL au runtime,
  pool, session). Dans le preload c'est le thread du renderer, donc le clic sur
  « partager » les paiera. À passer en `napi_async_work`, ou à précompiler les
  shaders avec `fxc` au build.
- **Le repli quand l'item se ferme.** `GraphicsCaptureItem::Closed` est abonné et
  remonte dans `captureStats().closed` (écran débranché, session RDP, HDR coupé au
  `Win+Alt+B`). `onSourceEnded` le **lit** désormais et arrête le partage avec une
  raison affichée sur la scène vide. Ce qui reste à faire est la reprise : rebasculer
  tout seul sur `getDisplayMedia` plutôt que de rendre la main à l'utilisateur.
- **La maintenance.** `loopback-capture` (audio) est le problème de quelqu'un
  d'autre ; celui-ci est le nôtre : node-gyp en CI, prebuilds, un pin d'ABI à chaque
  majeure d'Electron. Et le `--target` du script de build doit suivre la
  devDependency `electron`, sinon l'addon se charge en dev et pas en packagé.
- **WGC est Windows-only.** Cette brique est 100 % non portable ; la seconde moitié
  de la phase 3 (macOS/Linux) repart de zéro là-dessus — ce n'est pas un addon qu'on
  construit, c'est le gabarit de trois.

### Confort système

- **Réglages mémorisés** ✅ : preset, résolution, fps, bitrate, son système, dans
  `localStorage` (`parseQuality` / `serializeQuality`, `settings.ts`). Ce n'est pas
  un chantier natif, donc le web en profite aussi — mais le store est **par
  origine**, donc `app://bundle` et le site gardent des réglages séparés. Trois
  décisions qui tiennent la feature :
  - **Le micro n'est jamais restauré**, même s'il a été activé. C'est le seul
    réglage à dimension vie privée : le remettre à `true` déclencherait
    `getUserMedia` — et allumerait le témoin micro de l'OS — dès la première
    capture d'une session où personne ne l'a demandé. Deux clics est l'erreur la
    moins chère.
  - **On persiste la résolution _demandée_, pas la résolution rabotée.**
    `clampResolution` abaisse le plafond pour tenir dans la source ; or on partage
    surtout des **fenêtres**, jamais hautes de 2160. Sauver la valeur rabotée
    figerait le plafond à 720p pour toutes les sessions suivantes, y compris sur un
    écran 4K, sans rien à l'écran pour l'expliquer. D'où `pickedResolution`.
  - **Validation champ par champ**, avec repli sur le défaut du seul champ fautif.
    L'argument n'est pas l'utilisateur hostile mais **notre propre schéma** : une
    app qui se met à jour toute seule relit un store écrit par une version
    antérieure d'elle-même. Le jour où `120` quitte l'échelle de fps, un parse
    tout-ou-rien jetterait aussi un bitrate et un preset parfaitement valides.
- **Wake lock fiable** ✅ : `powerSaveBlocker` natif (`prevent-display-sleep`), qui
  remplace le `navigator.wakeLock` du web pendant une session — host **et** viewer.

  Le mot important n'est pas « best-effort », c'est **« lié au document »**. Mesuré
  sur la coquille : sous `app://`, `navigator.wakeLock` fonctionne parfaitement et la
  permission est accordée — mais le sentinel passe à `released: true` **dès que la
  fenêtre est masquée**, et n'est repris qu'au retour à la visibilité. Or le cas
  qu'on veut couvrir est exactement celui-là : le host réduit l'app et s'éloigne
  pendant que ses amis regardent. Un flux WebRTC sortant ne compte pas comme activité
  pour le minuteur d'inactivité de Windows. (Le cas « il réduit pour jouer » est plus
  faible : un jeu en plein écran tient déjà l'écran allumé tout seul.)

  `prevent-display-sleep` n'est pas lié à un document, donc il survit ; il implique
  aussi `prevent-app-suspension`.

  **Pas de nouveau mode dans la classe `WakeLock`** : une factory `createWakeLock()`
  rend soit la classe existante, soit un objet de deux lignes qui bascule le blocker.
  Tout ce qui justifie cette classe — le sentinel, la garde d'acquisition, la
  ré-acquisition sur `visibilitychange` — est mort sur le chemin natif, et la garder
  à l'écart laisse la classe **et ses tests** strictement inchangés.

  Un piège mesuré, encodé dans le code : `powerSaveBlocker.start()` rend l'id **0**
  pour le premier blocker. Une garde en `if (id)` conclurait que rien n'est tenu et
  en démarrerait un nouveau à chaque demande — d'où le `=== null` explicite. Les
  blockers s'empilent (ids 0 et 1 vivants simultanément), et `stop()` sur un id
  inconnu ne lève pas.

  Le blocker est relâché à la fermeture de la fenêtre, au crash du renderer, à la
  navigation et au quit : un verrou qui survit à sa session garde la machine éveillée
  sans aucune UI pour le révéler. Un seul blocker pour le process suffit —
  `teardown()` (`app.ts`) détruit un contrôleur avant d'en construire un autre, donc
  host et viewer sont mutuellement exclusifs et rien n'a besoin de compter les
  références.

  **Le piège côté viewer, trouvé en revue.** `destroy()` — donc `release()` — ne
  tourne que sur un **clic** (les boutons « retour à l'accueil »). Un viewer dont le
  host arrête de partager atterrit sur l'écran « ended » sans rien toucher : le
  verrou restait tenu. Avec `navigator.wakeLock` ce bug était inoffensif, le sentinel
  mourait dès la fenêtre masquée — le blocker natif est justement construit pour ne
  pas mourir là, ce qui transformait une fuite dormante en machine qui ne dort plus.
  La libération est donc accrochée au rendu des états terminaux (`ended`, `error`),
  à côté de la sortie du Picture-in-Picture, qui est la même classe de ressource.
- **Notifications natives** ✅, et **seulement ces trois** :
  1. un viewer **rejoint** le stream ;
  2. un viewer **quitte** le stream ;
  3. une **nouvelle version est détectée** — en plus de celle qu'`electron-updater`
     émet déjà quand la mise à jour est *prête à installer*. Deux moments
     distincts : « on l'a vue » et « elle est téléchargée ».

  **Pas d'IPC** : le renderer appelle directement l'API HTML5 `Notification`,
  qu'Electron mappe sur un toast Windows natif. Mesuré sous `app://bundle` :
  `Notification.permission` vaut déjà `granted`, aucun prompt. Le canal IPC prévu
  au plan aurait été un préload, un handler et une garde d'origine pour atteindre
  une API déjà présente. La notification de mise à jour, elle, n'a pas de renderer :
  elle se crée dans le main, sur `autoUpdater.on('update-available')`.

  Deux portes, et il faut être clair sur ce que la seconde fait : elle ne **limite
  pas** les dégâts, elle les **sélectionne**. Un host non focalisé est en général un
  host dont l'écran est regardé par toute la room, donc chaque toast s'affiche dans
  le stream, pseudo compris. Assumé — la sidebar montre déjà ces noms — et c'est la
  raison pour laquelle la liste d'événements reste aussi courte.
  - `window.native` : silence total sur le web (pas de prompt de permission).
  - `document.hasFocus()` : rien quand le host regarde déjà son app.
  - **Le kick ne notifie pas** : le host vient de le décider, le lui annoncer est du
    bruit. C'est le seul appelant du drapeau `silent`.
  - **La reconnexion, si.** Envisagé de la silencer, puis écarté : `reconcileRoster`
    diffe contre la vérité du serveur, et les viewers gardent leur lien P2P pendant
    un blip — le diff est donc vide sauf si quelqu'un est réellement arrivé ou parti
    pendant la coupure, c'est-à-dire précisément le moment où le host n'a aucun
    autre moyen de l'apprendre. La rafale après une longue coupure est absorbée par
    le `tag` partagé, qui remplace le toast précédent au lieu de l'empiler.

**Pas de tray.** Aucune icône de barre système, aucune réduction en arrière-plan :
fermer la fenêtre **quitte l'application** (cf. [Décisions](#décisions)). Un tray
n'ajouterait qu'un état « app cachée mais vivante » qu'on ne veut pas, et sans
raccourcis globaux (abandonnés) il n'y aurait de toute façon rien à y piloter.

## Techno — Electron

> Décidé après comparatif sur doc officielle (**2026-07-20**). Versions de
> référence : Electron **43.x** (Chromium 150, Node 24), Tauri **2.11**, Wails
> **2.13** / v3 alpha, Deno **2.9**.

**Critère n°1 : réutiliser `src/lib/` tel quel.** Le protocole est écrit et testé,
et le tuning WebRTC a coûté cher (`setCodecPreferences` H.265>VP9>AV1>H.264>VP8,
`setParameters` par viewer, `tuneOpus` stéréo 128k, mixage WebAudio). Une techno
qui oblige à revalider tout ça est disqualifiée, quel que soit son poids disque.

**Le constat qui tranche : Tauri, Wails et Deno Desktop (backend par défaut)
utilisent tous le webview _système_** (WebView2 / WKWebView / WebKitGTK). Ce n'est
pas trois paris différents, c'est le même — avec un langage hôte différent — donc
**les mêmes trous** :

| Critère                                   | **Electron**                         | Tauri / Wails / Deno (webview système)                                           |
| ----------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------- |
| Moteur                                    | Chromium embarqué, identique partout | webview système, **un moteur différent par OS**                                  |
| Taille / RAM                              | ~50-120 Mo / ~130-250 Mo             | **~5-12 Mo / ~30-85 Mo** ✅                                                      |
| `getDisplayMedia` Windows                 | ✅                                   | ✅ (WebView2 = Chromium)                                                         |
| `getDisplayMedia` macOS                   | ✅                                   | ❌ cassé (bug WebKit 271688, ouvert depuis 2024)                                 |
| `getDisplayMedia` Linux                   | ✅                                   | ❌ WebRTC absent de WebKitGTK des distros                                        |
| **Grille de sources** (`desktopCapturer`) | ✅ vignettes + `appIcon`             | ❌ pas d'équivalent ; picker système imposé                                      |
| Audio loopback / par process              | intégré (loopback) + addon N-API     | à écrire en natif (Rust / Go / FFI)                                              |
| Injection frames natives → WebRTC         | natif (Chromium)                     | frames à pousser dans la webview : ~200 ms/10 Mo sur Windows, hors budget 60 fps |

**Verdict : Electron.** En une phrase : _les alternatives économisent ~150 Mo de
disque et nous font payer la capture d'écran, l'audio, le support macOS/Linux et
(pour le fork capture native) la pile WebRTC entière._ Les ~150 Mo heurtent le
principe « léger » du [`README.md`](./README.md), mais ce principe protège le
**service web** (front statique, micro-signaling) ; une app opt-in téléchargée une
fois n'est pas dans ce budget.

Electron est aussi le seul qui **renforce** les features lourdes : le tone-map HDR
et l'encodage hardware exigent capture native **+ réinjection dans la peer
connection**, terrain où Chromium + N-API est le plus à l'aise et où les webviews
système butent.

> **Ce qui rouvrirait le débat**, à re-tester dans ~2 ans : bug WebKit 271688
> corrigé, **et** WebRTC activé dans WebKitGTK des distros, **et** WebView2 dotée
> d'une vraie API de sélection de source. Piste à surveiller : `deno desktop
--backend cef` (Chromium embarqué, piloté en TypeScript) — s'il se stabilise et
> gagne le loopback audio par process, c'est le successeur naturel.

## Architecture

L'app charge le build web existant dans une fenêtre Electron. Une **seule
frontière** avec le natif : `window.native`.

```
electron/                     # sous-projet autonome (lockfile propre, hors workspace, cf. signaling/)
  src/main.ts                 # BrowserWindow, scheme app://, CSP, nav-lock, auto-update
  src/preload.ts              # contextBridge → window.native
  src/config.ts               # PUR (sans import electron) : origine, CSP, nav — testé
  src/audio/                  # (phase 2) addon N-API : WASAPI process loopback
  build/icon.png              # 512×512, converti en .ico par electron-builder
  electron-builder.yml        # NSIS + GitHub Releases
src/                          # INCHANGÉ. astro build → dist/, servi par la fenêtre Electron
  lib/host.ts                 #   → utilise window.native si présent, getDisplayMedia sinon
```

**Le front seul est embarqué.** L'`app.asar` ne contient que **trois fichiers** —
`out/main.cjs`, `out/preload.cjs`, `package.json` — le build Astro arrivant à côté
via `extraResources: ../dist`. Aucun `node_modules` n'est packagé : `electron-updater`,
seule dépendance runtime, est bundlé dans `main.cjs` (cf.
[CI / packaging](#ci--packaging), où cette exclusion n'est pas cosmétique).
**Le serveur de signaling n'est pas embarqué** et ne le sera jamais : l'app est un
client qui parle au signaling déployé (par défaut `https://stream.joanybuclon.com`,
surchargeable via `SS_APP_ORIGIN` pour viser un dev/staging).

**Un seul test, partout : `window.native` présent ou non.** Absent →
comportement web actuel à l'identique. Présent → sources natives, audio par
process, avertissement HDR. Pas de fork de codebase, pas de build conditionnel.

```
// ponytail: un seul point de branchement (window.native?), sinon on maintient
// deux produits. Si le nombre de if(native) dépasse ~5 dans src/lib, c'est le
// signal qu'il faut une interface CaptureSource — pas avant.
```

Deux points de friction connus :

1. **Injecter un flux natif dans la `RTCPeerConnection`** (audio PCM en MVP, frames
   vidéo plus tard). Chemin audio confirmé et standard (cf.
   [Audio § Technique](#technique)). C'est l'objet du spike de la phase 2.
2. **`host.ts` (~565 lignes)** entremêle capture, qualité et DOM. Le coût du port
   n'est pas le WebRTC (`peer.ts`, `signaling.ts`, `settings.ts`, `stats.ts` sont
   purs, sans DOM), c'est cette couche. À dégraisser avant, ou à assumer.

### Contraintes Electron découvertes au test (phase 1)

Ces points ne se devinent pas depuis la doc et conditionnent la coquille. Tous
sont dans `electron/src/main.ts`, commentés sur place.

- **Le renderer doit tourner sur une origine sûre, pas `file://`.** Le build est
  servi par un scheme `app://` déclaré *privileged* (`standard: true, secure:
  true`) **avant** `app.ready`. Sur `file://` l'origine est opaque et
  `getDisplayMedia`, le presse-papier et `localStorage` cassent tous les trois.
- **Origine réécrite pour le socket signaling.** Le signaling refuse les upgrades
  WebSocket dont l'`Origin` n'est pas dans son allow-list anti-CSWSH
  (`ALLOWED_ORIGINS`, `signaling/src/index.js`). Sous `app://` le navigateur
  envoie `Origin: app://…` → **401**. La coquille présente donc l'origine web
  canonique pour ce seul socket. Vérifié : `Origin: app://bundle` → 401,
  `Origin: https://stream.joanybuclon.com` → 101. Ce n'est pas un vecteur CSWSH :
  la navigation interne est verrouillée sur `app://` et les liens externes
  s'ouvrent dans le navigateur système.
- **`getDisplayMedia` n'a aucun picker sur Windows.** Sans
  `setDisplayMediaRequestHandler`, l'appel échoue : Electron ne fournit pas de
  sélecteur, contrairement à Chromium. (`useSystemPicker` existe mais est
  **macOS 15+ uniquement** — quand il s'applique, le handler n'est pas appelé.)
  D'où la source imposée en phase 1, ci-dessous.
- **Le menu par défaut est retiré** (`Menu.setApplicationMenu(null)`) : la barre
  File / Edit / View / Window d'Electron n'a aucun usage ici. Sur Windows et Linux
  les raccourcis d'édition (Ctrl+C/V/X/A) continuent de fonctionner, Chromium les
  gérant nativement dans les champs. **macOS est l'exception** — ils viennent *du*
  menu là-bas : y livrer un jour imposera un menu minimal avec le rôle `editMenu`
  plutôt que `null`.
- **L'icône a deux chemins distincts.** Packagée, elle vient de la ressource de
  l'exe (electron-builder embarque `build/icon.png`) ; **non packagée il n'y a pas
  de ressource**, donc `pnpm desktop` doit la passer explicitement à la
  `BrowserWindow` sinon on voit celle d'Electron. En dev, la barre des tâches peut
  malgré tout rester celle d'Electron : Windows la rattache à l'exécutable lancé.
- **`app.setAppUserModelId` doit correspondre à l'`appId`** — *packagé*. Sans
  identité Windows, les notifications toast sont muettes, et pas seulement le
  regroupement dans la barre des tâches en souffre.
- **En dev, l'identité doit être DIFFÉRENTE**, et ça s'est payé une fois. Windows
  retrouve l'émetteur d'un toast via un raccourci du menu Démarrer portant cet
  identifiant : une exécution **non packagée** qui affiche une notification pousse
  donc Electron à en créer un, pointant vers `node_modules`, nommé et iconé
  « Electron ». Il survit à une désinstallation de l'app (il est dans le profil
  utilisateur, pas dans l'installation) et se retrouve dans le menu Démarrer et la
  recherche Windows à côté du vrai. D'où le `.dev` hors packaging : le raccourci
  parasite apparaît toujours, mais il ne peut plus parler au nom de l'app installée.
  Symptômes constatés quand c'est arrivé : une entrée « Electron » dans le menu
  Démarrer qui lançait `electron.exe`, l'icône de la barre des tâches revenue à
  celle d'Electron, et StreamShare introuvable dans la recherche. Le nettoyage est
  manuel : supprimer le `.lnk`, vider `IconCache.db` +
  `%LOCALAPPDATA%\Microsoft\Windows\Explorer\iconcache_*.db`, relancer
  `explorer.exe`. Diagnostic : comparer la cible et l'`AppUserModelId` des `.lnk` de
  `%APPDATA%\Microsoft\Windows\Start Menu\Programs` — l'exe installé, lui, porte son
  icône et son `ProductName` en interne et se vérifie indépendamment.
- **`sandbox: false`, et les deux autres drapeaux deviennent porteurs.** Le bac à
  sable OS du renderer est retiré depuis le 2026-08-03 pour que l'addon HDR tourne
  dans le preload (mesure et raisonnement : § Les portes du chantier natif). Les
  quatre `webPreferences` vivent donc dans `rendererSecurity` (`config.ts`), avec un
  test : `contextIsolation` et `nodeIntegration` n'étaient que des défauts d'Electron,
  ils sont désormais **la dernière barrière** entre un SDP hostile et Node. Vérifié
  sur la coquille : `window.native` répond, et la page n'a ni `require` ni `process`.
- **Le scheme privilégié conditionne `localStorage`.** Il est enregistré `standard`
  + `secure` avant `app.ready` pour que l'origine ne soit pas opaque ; sans ça,
  `getDisplayMedia`, le presse-papiers **et le stockage** tombent. Les réglages
  mémorisés en dépendent désormais. Corollaire : le store est **par origine**, donc
  la coquille et le site web ne partagent pas leurs réglages.
- **L'API `Notification` du renderer suffit.** Mesuré sous `app://bundle` :
  `Notification.permission` vaut `granted` d'emblée, sans prompt, et Electron mappe
  le constructeur HTML5 sur un toast Windows natif. Inutile d'ouvrir un canal IPC
  pour ça. *(Mesuré sur le build non packagé ; même scheme et même AppUserModelId
  en packagé, mais si un jour un toast manque à l'installation, c'est la première
  chose à revérifier.)*
- **L'event `close` d'un `<dialog>` est asynchrone.** Il est donc inutilisable pour
  persister quoi que ce soit depuis un objet qui se démonte : `destroy()` fait
  `modal.close()` puis `ac.abort()`, ce qui retire l'écouteur **avant** que l'event
  ne parte. Attrapé au test — la sauvegarde des réglages y était accrochée et
  quitter la room la perdait à tous les coups.

```
// ponytail: la source forcée n'est PAS un choix produit, c'est le strict minimum
// pour que la phase 1 capture quelque chose sans construire la feature n°2.
```

**Source imposée — béquille levée.** En phase 1 la coquille capturait **l'écran
principal** sans choix possible. Le sélecteur visuel de la phase 2 s'appuie sur ce
même handler (cf.
[Sélecteur de source natif](#sélecteur-de-source-natif)) : l'écran principal n'est
plus qu'un repli quand la page appelle `getDisplayMedia` sans avoir rien désigné.
`useSystemPicker` a été retiré au passage — maintenant qu'on a notre grille,
autant qu'elle soit la même partout plutôt que macOS 15+ bascule sur la feuille
système.

## Distribution

- **Pas de signature de code**, assumé pour l'instant. Un `.exe` non signé
  déclenche SmartScreen (« Windows a protégé votre ordinateur ») ; la page de
  download **l'explique** (« Informations complémentaires → Exécuter quand même »).
  À noter : un certificat EV **ne bypasse plus** SmartScreen depuis 2026 (position
  officielle Microsoft), donc payer avant de savoir si l'app intéresse serait
  prématuré. Option future si besoin : **Azure Artifact Signing** (~120 $/an, sans
  token, intégrable en CI).
- **GitHub Releases + `electron-updater`.** L'app se met à jour seule ; sinon elle
  devient vite une dette face à un web toujours à jour. ⚠️ **Non encore prouvé** :
  il faut deux versions publiées pour vérifier qu'une mise à jour est bien
  détectée et appliquée. À valider à la première release de la phase 2 — la page
  `/download` promet « updates automatically ».
- **Fenêtre fermée = app quittée.** Pas de persistance en arrière-plan.

### Découvrabilité

- **Une phrase sous la carte « Start a share »** de la landing
  ([`HomeScreen.astro`](../src/components/HomeScreen.astro), `#btn-start`), avec un
  lien vers **`/download`**. Elle vend le bénéfice, pas le binaire : _« On Windows,
  the desktop app adds per-app audio and its own source picker »_.
  - **Windows seulement** tant que macOS/Linux n'existent pas (détection déjà
    faite à côté via `supportsDisplayMedia()` dans `host.ts`).
  - **Masquée dans l'app desktop elle-même** (qui charge la même landing) : test
    `window.native`.
  - Ce placement fait le tri seul : un viewer arrivant sur `/#CODE` **saute la
    landing** ([`frontend.md`](./frontend.md)) et ne verra jamais cette phrase.

```
// ponytail: une phrase et un lien. Pas de bannière dismissible, pas de
// localStorage "déjà vu", pas de compteur. Si personne ne clique, on réécrit la
// phrase — on n'ajoute pas une modale.
```

- **La page `/download`** présente les avantages de l'app (audio par app,
  sélecteur de source, puis HDR et FPS garanti) et un lien de téléchargement :
  **Windows d'abord**, macOS et Linux dans un second temps.

  Règle : une carte décrit soit du **livré**, soit du **`soon:true`** — qui reçoit
  le même traitement « Coming soon » que les lignes macOS/Linux plus bas. Rien
  d'annoncé au présent qui n'existe pas. La page affichait le HDR et les raccourcis
  globaux comme s'ils fonctionnaient déjà : les raccourcis sont abandonnés, le HDR
  et le FPS garanti sont de la phase 3 et le disent. C'est la seule page du projet
  que lit quelqu'un d'autre que nous, juste avant d'installer un binaire non signé.

## CI / packaging

Le workflow (`.github/workflows/docker-publish.yml`, cf.
[`deployment.md`](./deployment.md)) a un job `quality` puis une matrice `publish`
à deux images (`web`, `signaling`). Un **troisième job `desktop`** tourne en
parallèle des deux publish, après `quality` :

- déclenché uniquement sur un tag **`v*.*.*`** (`v*` accepterait `vnext`, dont
  electron-builder ne peut pas faire une version) ; une garde vérifie que le tag
  **égale** `electron/package.json`, sinon les artefacts partiraient sur la
  mauvaise release ;
- runner `windows-latest` (build natif, pas une image Docker) ;
- `electron-builder --publish never` → `.exe` NSIS + `.blockmap` + `latest.yml` ;
- upload explicite via `gh` vers la **GitHub Release** (consommée par
  `electron-updater`).

```
// ponytail: job desktop en parallèle des publish, PAS avant quality. Un binaire
// qui n'a pas passé lint/typecheck/tests n'a rien à faire en release.
```

### Les six pièges de la chaîne de release

Chacun a coûté une release ratée. Ils sont détaillés dans
[`electron/README.md`](../electron/README.md) ; résumé de ce qu'il ne faut pas
défaire :

| Piège                                                                                                                                                                                                            | Correctif                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **electron-builder < 26.12 produit un installeur qui meurt au double-clic** (`0xc0000005` dans `System.dll`) : dépassement de lecture dans son propre `multiUser.nsh`, déclenché par notre combinaison `oneClick: false` + `perMachine: false`. Le NSIS embarqué est identique en 25 et 26 — ce n'est pas lui. | plancher **≥ 26.12**                                                 |
| **pnpm 11 refuse les scripts d'install** : `allowBuilds` ne vit que dans `pnpm-workspace.yaml`, que `--ignore-workspace` ignore. `esbuild` échouait ; `electron-winstaller` (tiré par electron-builder 26) aussi.  | `esbuild-wasm` + `--ignore-scripts` à l'install                      |
| **L'`app.asar` embarquait 7 315 fichiers / 118 Mo** : electron-builder remonte à la racine du dépôt et empaquette **ses** dépendances de production (astro, tailwind, vite, sharp…).                              | `!node_modules/**` + `electron-updater` bundlé → asar de 608 Ko      |
| **La publication d'electron-builder rapportait « succès » en ne déposant que le `.blockmap`** — ni installeur ni `latest.yml`, deux fois de suite.                                                                | build et upload séparés, avec gardes qui **font échouer le job**     |
| **`gh release upload` exige une release existante**, or plus rien ne la créait après le passage en `--publish never`.                                                                                            | `gh release view` → `create` si absente, puis `upload --clobber`     |
| **Le nom d'artefact par défaut contient des espaces** : electron-builder écrit `StreamShare Setup x.y.z.exe` sur le disque mais inscrit la forme URL-safe `StreamShare-Setup-x.y.z.exe` dans `latest.yml` ; GitHub, lui, remplace les espaces par des **points** à l'upload. L'asset s'appelle donc `StreamShare.Setup.x.y.z.exe` et l'updater 404 sur un nom que personne n'a jamais créé. Même piège pour le `.blockmap`. Conséquence de notre build/upload séparé — le publisher d'electron-builder masque le problème en uploadant lui-même la forme à tirets. | `artifactName: ${productName}-Setup-${version}.${ext}` |

```
// ponytail: ces six points ne sont pas des préférences. Chacun est un mode de
// panne vérifié — dont quatre SILENCIEUX (job vert, release inutilisable).
```

#### Diagnostiquer un updater qui ne fait rien

Pas de `electron-log` dans l'arbre : `checkForUpdatesAndNotify()` échoue sans
laisser de trace. La procédure, dans cet ordre, tient en trois vérifications :

1. **Le cache** — `%LOCALAPPDATA%\stream-share-desktop-updater\pending\`. Un
   `installer.exe` présent ne prouve rien : vérifier sa **date** et sa version,
   c'est souvent celui d'une release précédente.
2. **`latest.yml` de la release** — le champ `path` (et `url`) doit correspondre
   **caractère pour caractère** au nom de l'asset publié. C'est le piège n°6.
3. **Le `sha512`** — si un asset a dû être renommé à la main, comparer son
   empreinte à celle de `latest.yml` avant de supprimer l'ancien.

## Décisions

Actées le 2026-07-20. Les rouvrir demande une raison neuve, pas un changement
d'avis.

| Sujet              | Décision                                                |
| ------------------ | ------------------------------------------------------- |
| Périmètre          | Host uniquement, Windows d'abord                        |
| Techno             | Electron (dernière stable)                              |
| Modèle audio       | L'audio suit la source vidéo, puis une case par app     |
| Code               | Même repo, dossier `electron/`, `src/` partagé          |
| Signature Windows  | Aucune, assumé pour l'instant (warning expliqué)        |
| Distribution       | GitHub Releases + `electron-updater`                    |
| CI                 | Job packaging en parallèle des publish, après `quality` |
| Découvrabilité     | Phrase sous « Start a share » → page `/download`        |
| Tray               | Aucun ; notification uniquement quand un viewer rejoint/quitte |
| Fermeture fenêtre  | Quitte l'app (pas d'arrière-plan)                       |
| Signal côté viewer | Aucun — un viewer ignore si l'host est desktop          |

## Périmètre exclu

- **Viewer desktop** — le web fait déjà tout côté viewer.
- **Composition de scène / overlays** (ex-point 11) — c'est OBS.
- **Ouverture de port / découverte LAN** (ex-point 7) — on est une app de partage
  à distance ; STUN suffit, pas d'intérêt.
- **SFU / TURN** — non, définitif ([`README.md`](./README.md)).

### Plateformes à venir

macOS et Linux, si l'usage Windows le justifie. Notes techniques repérées pour ce
moment-là :

- **macOS** : audio par app via ScreenCaptureKit (macOS 13+, binding npm
  `screencapturekit-audio-capture`, semi-maintenu ; macOS 15+ limite à un seul
  process capteur à la fois). Loopback système intégré à Electron depuis la v39
  (macOS 14.2+, clé `NSAudioCaptureUsageDescription`).
- **Linux** : audio par app via PipeWire — **aucun binding Node maintenu**, à
  écrire. Sur Wayland le portail xdg ne rend qu'**une seule source** : la grille
  custom n'y existe pas, quel que soit le framework.

## Chemin d'exécution

| Phase                    | Contenu                                                                                                                                                                    | Sortie                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| **1 — coquille Electron** ✅ **livrée** | L'app web emballée dans Electron : scheme `app://`, CSP mirrorée, nav-lock, pas de menu, icône, close = quit, **page `/download`** + CTA accueil, **auto-update** câblé, packaging NSIS + job CI sur tag `v*.*.*`. `window.native` ne porte que `appOrigin`. **Source imposée à l'écran principal** (béquille, cf. ci-dessus). | **Validé de bout en bout** : installeur téléchargé depuis la Release, app installée, partage host desktop → viewer Chrome. La mise à jour automatique, longtemps non prouvée faute de deux versions, l'est depuis : 0.3.1 → 0.3.2 → 0.3.3 en conditions réelles. |
| **2 — MVP**              | **Audio par app (une case par app) ✅**, **grille de sources native ✅**, **auto-update validé ✅** (0.3.1→0.3.2→0.3.3 sur machine réelle) ; reste : **réglages mémorisés** (prochaine étape), **wake lock natif**, **notifications** (rejoint / quitte / mise à jour détectée). Abandonnés : raccourcis globaux, avertissement HDR. | La version qui « récompense ». Livrée par morceaux, le sélecteur en premier. Le spike audio est passé : `loopback-capture@2.0.0` sort du PCM 48 kHz / 16 bits / stéréo par paquets de 10 ms, et une session par app tient (16 mesurées) — donc la feature n°1 va jusqu'au modèle de la maquette. |
| **3 — capture native + plateformes** | WGC/DXGI → injection : FPS garanti, tone-map HDR, encodage hardware, contrôle curseur. Puis **macOS / Linux**, précédés d'une analyse détaillée de ce qui doit changer (cf. [Plateformes à venir](#plateformes-à-venir) : l'audio par app y a un binding différent, ou aucun). Fork architectural, **le vrai gain différentiel avec le web**. | **Confirmée nécessaire** après une session en conditions réelles (2026-08-01) — plus « ouverte seulement si demandée ». |

**À dire franchement : au sortir de la phase 1, l'app n'apporte rien qu'un
navigateur ne fasse déjà** — elle fait même moins, la source étant imposée. C'est
un socle technique (distribution, mise à jour, pont natif), pas un produit. Le
critère « la récompense justifie le téléchargement » se remplit en **phase 2** :
le sélecteur de source est la première pièce livrée, l'audio par app la suivante.

## Reste à trancher

- **macOS/Linux** : tranché — **phase 3**, après la capture native. Ce qui reste
  à décider est le *contenu* : une analyse détaillée précédera le chantier, parce
  que la fonctionnalité n°1 n'y est pas portable telle quelle (ScreenCaptureKit
  sur macOS avec un binding semi-maintenu, **rien de maintenu** sur Linux/PipeWire
  — cf. [Plateformes à venir](#plateformes-à-venir)). Sur Wayland, la grille de
  sources n'existe pas non plus. Ce sont deux ports différents, pas un.
- **Le plafond d'upload en maillage** : l'estimation (`estimatedUpload`) est
  affichée, jamais mesurée en vrai. À observer à la prochaine session à 3-4 avant
  d'en faire un chantier.
