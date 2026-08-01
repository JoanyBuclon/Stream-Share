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
| **Réglages mémorisés**          | Rien ne survit proprement d'une session à l'autre                  | 2 — MVP      |
| **Wake lock fiable**            | `navigator.wakeLock` best-effort, révocable                        | 2 — MVP      |
| **Notifications natives**       | Pas d'alerte hors fenêtre : viewer qui rejoint/quitte, mise à jour | 2 — MVP      |
| **Tone-map HDR correct**        | `getDisplayMedia` écrase le HDR par un clamp brutal, sans tone-map | 3 — natif    |
| **FPS élevé garanti (120/144)** | `getDisplayMedia` best-effort, souvent non honoré                  | 3 — natif    |
| **Encodage hardware**           | Le navigateur n'expose ni NVENC ni QuickSync ni AMF                | 3 — natif    |
| **Contrôle du curseur**         | La contrainte `cursor` est ignorée par les navigateurs             | 3 — natif²   |

La **phase 1** n'apporte aucune de ces fonctionnalités : elle emballe l'app web
actuelle dans Electron + page `/download` + auto-update. ¹ En phase 1, faute de
picker Electron sur Windows, la source était **imposée à l'écran principal** ;
cette béquille est levée depuis que le sélecteur existe (cf.
[Contraintes Electron](#contraintes-electron-découvertes-au-test-phase-1)).
² Envisagé en phase 2, écarté sur vérification : **Electron 43.2 n'expose rien**
pour le curseur de capture — ni sur `desktopCapturer`, ni dans les options de
`setDisplayMediaRequestHandler`. Le levier (`IsCursorCaptureEnabled` de WGC) vit
sous Chromium, hors de portée du JS. Les quatre dernières lignes partagent donc
le même prérequis lourd de **phase 3** — **reprendre la main sur les frames
vidéo** (cf. [Capture native](#capture-native-fps-hdr-encodage-curseur)). Détail
des phases : [Chemin d'exécution](#chemin-dexécution).

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

### Capture native : FPS, HDR, encodage, curseur

Quatre fonctionnalités partagent un même prérequis : **sortir du pipeline
`getDisplayMedia`→track géré par Chromium** et reprendre la main sur les frames
(capture native Windows Graphics Capture / DXGI → traitement → injection via
`VideoTrackGenerator` (worker) / `canvas.captureStream`). C'est un fork
architectural, **pas le MVP** — mais il débloque d'un coup :

- **FPS élevé garanti** : vrai 120/144 Hz, là où `getDisplayMedia` plafonne en
  best-effort.
- **Tone-map HDR** (cf. ci-dessus).
- **Encodage hardware** : NVENC / QuickSync / AMF, qui recule le plafond host du
  mesh ([`webrtc-media.md`](./webrtc-media.md) § coût host).
- **Contrôle du curseur** : inclure / exclure, via `IsCursorCaptureEnabled` de WGC.

```
// ponytail: la capture native est UNE brique commune à ces 4 features, pas 4
// chantiers. On ne l'ouvre que quand l'une d'elles est réellement demandée —
// le MVP tient entièrement sur getDisplayMedia + desktopCapturer.
```

**Point à mesurer, pas à supposer** : l'encodage hardware sur une track
**injectée** (frames produites hors du pipeline natif) n'est pas garanti —
Chromium peut retomber en software selon le backing GPU des frames. À valider sur
Chromium réel avant de promettre le gain d'encodage.

### Confort système

- **Réglages mémorisés** entre sessions : preset qualité, résolution, fps,
  bitrate, micro, son système. Aujourd'hui tout repart de `DEFAULT_QUALITY` à
  chaque lancement. Côté web aussi — c'est du `localStorage` dans `settings.ts`,
  pas un chantier natif, et ça profite aux deux.
- **Wake lock fiable** : `powerSaveBlocker` natif (`prevent-display-sleep`) —
  remplace le `navigator.wakeLock` best-effort du web (`wakelock.ts`).
- **Notifications natives**, et **seulement ces trois** :
  1. un viewer **rejoint** le stream ;
  2. un viewer **quitte** le stream ;
  3. une **nouvelle version est détectée** — en plus de celle qu'`electron-updater`
     émet déjà quand la mise à jour est *prête à installer*. Deux moments
     distincts : « on l'a vue » et « elle est téléchargée ».

**Pas de tray.** Aucune icône de barre système, aucune réduction en arrière-plan :
fermer la fenêtre **quitte l'application** (cf. [Décisions](#décisions)). Un tray
n'ajouterait qu'un état « app cachée mais vivante » qu'on ne veut pas, et sans
raccourcis globaux (abandonnés) il n'y aurait de toute façon rien à y piloter.

## Techno — Electron

> Décidé après comparatif sur doc officielle (**2026-07-20**). Versions de
> référence : Electron **43.x** (Chromium 150, Node 24), Tauri **2.11**, Wails
> **2.13** / v3 alpha, Deno **2.9**.

**Critère n°1 : réutiliser `src/lib/` tel quel.** Le protocole est écrit et testé,
et le tuning WebRTC a coûté cher (`setCodecPreferences` VP9>AV1>VP8,
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
- **`app.setAppUserModelId` doit correspondre à l'`appId`.** Sans identité Windows,
  les notifications toast sont muettes — ce qui compte dès la phase 2 (annonce des
  viewers), et pas seulement pour le regroupement dans la barre des tâches.

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
