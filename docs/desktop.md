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
| **Audio par application**       | `getDisplayMedia` capture le mix système entier, ou rien           | 2 — MVP      |
| **Sélecteur de source natif**   | Picker Chrome imposé, aucune API web ne liste les fenêtres         | 2 — MVP¹     |
| **Avertissement HDR**           | Aucune API web ne connaît l'_état_ HDR du compositeur              | 2 — MVP      |
| **Raccourcis globaux**          | Sandbox navigateur : rien hors de la fenêtre                       | 2 — MVP      |
| **Réglages mémorisés**          | Rien ne survit proprement d'une session à l'autre                  | 2 — MVP      |
| **Wake lock fiable**            | `navigator.wakeLock` best-effort, révocable                        | 2 — MVP      |
| **Notifications natives**       | Pas d'alerte quand un viewer rejoint (fenêtre en arrière-plan)     | 2 — MVP      |
| **Tone-map HDR correct**        | `getDisplayMedia` écrase le HDR par un clamp brutal, sans tone-map | 3 — natif    |
| **FPS élevé garanti (120/144)** | `getDisplayMedia` best-effort, souvent non honoré                  | 3 — natif    |
| **Encodage hardware**           | Le navigateur n'expose ni NVENC ni QuickSync ni AMF                | 3 — natif    |
| **Contrôle du curseur**         | La contrainte `cursor` est ignorée par les navigateurs             | 3 — natif    |

La **phase 1** n'apporte aucune de ces fonctionnalités : elle emballe l'app web
actuelle dans Electron + page `/download` + auto-update. ¹ En phase 1, faute de
picker Electron sur Windows, la source est **imposée à l'écran principal** — une
béquille temporaire levée par le vrai sélecteur en phase 2 (cf.
[Contraintes Electron](#contraintes-electron-découvertes-au-test-phase-1)). Les
quatre dernières lignes partagent le prérequis lourd de la **phase 3** —
**reprendre la main sur les frames vidéo** (cf.
[Capture native](#capture-native-fps-hdr-encodage-curseur)). Détail des phases :
[Chemin d'exécution](#chemin-dexécution).

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

| Source partagée   | Web aujourd'hui                   | Desktop                                             |
| ----------------- | --------------------------------- | --------------------------------------------------- |
| Onglet navigateur | audio de l'onglet seul            | ⚠️ **régression** — voir plus bas                   |
| Écran             | tout le son système, sans recours | tout le son système **moins les apps décochées** ✅ |
| **Fenêtre / app** | **rien, ou tout le système** ❌   | **le son de cette app, et rien d'autre** ✅         |

Le desktop lie l'audio à la source vidéo :

- **Source = une app / fenêtre** → on capture le loopback de **ce process** et de
  ses enfants. Un seul son, le bon, sans rien configurer.
- **Source = un écran** → tout le système, **moins une liste d'exclusion**.

C'est **le même panneau** dans les deux cas — la liste des apps qui émettent du
son, avec des cases — seule la pré-sélection change selon la source. On peut
toujours rattraper à la main : partager la fenêtre du jeu **et** cocher Spotify,
ou partager l'écran **et** décocher Discord.

#### Le modèle : liste d'exclusion

En mode écran, **tout le son système part par défaut** (comportement web actuel,
rien de nouveau à comprendre), et on **décoche ce qu'on veut taire**. Les clients
vocaux connus (`Discord`, `TeamSpeak`, `Mumble`…) sont **pré-décochés** : le cas
qui a motivé toute l'app se règle sans toucher à quoi que ce soit.

La liste d'inclusion (rien ne part tant qu'on n'a pas choisi) évite la fuite
accidentelle d'une notification, mais impose un clic à chaque session pour un
risque que le web nous fait déjà courir. On ne dégrade pas l'ergonomie pour un
problème qu'on n'a jamais eu.

```
// ponytail: liste d'exclusion, pas de mixer par app. Des sliders de volume par
// application, c'est une table de mixage — c'est OBS, pas nous. Si la demande
// arrive vraiment, la liste d'exclusion en est le sous-ensemble, rien à jeter.
```

#### Technique

- **Capture** : WASAPI process loopback
  (`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`, Windows 10 build 20348+). Le
  paquet npm `application-loopback` (C++ N-API, maintenu) fait déjà l'include /
  exclude **par PID et sa descendance** — ce qui couvre Discord, dont le rendu
  audio vit dans un process enfant.
- **Injection dans WebRTC** : addon → `AudioWorklet` →
  `MediaStreamAudioDestinationNode` → `addTrack`, mixé par l'`audio.ts` existant
  qui sait déjà mélanger système + micro. **Ne pas** passer par
  `MediaStreamTrackGenerator` (breakout box) : non-standard, Chromium seul, refusé
  par Mozilla — et il n'existe pas d'`AudioTrackGenerator`.

#### La régression à assumer : les onglets de navigateur

Le loopback WASAPI capture un **process**, or un navigateur rend l'audio de tous
ses onglets dans un même process de service audio. Donc **partager un onglet
Chrome depuis l'app donnera le son de tout Chrome**, là où le web isole l'onglet.
C'est le seul point où le navigateur fait mieux, et aucun framework n'y change
rien. Mitigation : quand la source est une fenêtre de navigateur connu, **l'UI le
dit** au lieu de laisser découvrir.

#### À valider au spike (phase 0)

- l'exclusion porte sur un PID + descendance : il faut résoudre « l'app Discord »
  → le bon PID racine, **et tenir le cas où l'app redémarre** en cours de session
  (le PID change, l'exclusion doit suivre le nom d'exécutable) ;
- **lister en temps réel** les apps qui émettent du son pour peupler le panneau :
  énumération WASAPI distincte de la capture, que `application-loopback` ne fournit
  pas forcément ;
- capture-t-on quelque chose en ciblant le PID d'une fenêtre de navigateur, vu que
  le rendu audio vit dans un process de service séparé (lié à la régression
  ci-dessus).

### Sélecteur de source natif

Le web impose la boîte de dialogue de Chrome ; la maquette
([`mockup.html`](./mockup.html)) avait sa propre grille. Le desktop la rend
possible :

- `desktopCapturer.getSources` (main process Electron depuis la v17) retourne les
  écrans et fenêtres avec **vignettes** (`thumbnail`) et **icônes d'application**
  (`appIcon`, via `fetchWindowIcons`).
- Notre grille : vignettes live, icônes, recherche — l'UI de la maquette, telle
  quelle.
- Le choix est appliqué via `setDisplayMediaRequestHandler`, qui **intercepte** la
  demande de capture et lui passe la source retenue — donc **pas de re-consentement
  navigateur**. En web, `surfaceSwitching: 'include'` permettait déjà de changer de
  source sans re-prompt ; ici on maîtrise tout le geste.

C'est aussi la fonctionnalité qui **exclut Tauri / Wails / Deno** : aucun n'a
d'équivalent `desktopCapturer` (cf. [Techno](#techno--electron)).

### HDR

Une source HDR partagée arrive **surexposée, hautes lumières cramées** chez le
viewer (cf. captures `cap1` = source, `cap2` = viewer).

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
fait un clamp brutal ; nous, on peut faire mieux. Deux niveaux :

1. **Avertissement (MVP).** `DXGI_OUTPUT_DESC1` (via `IDXGIOutput6::GetDesc1`,
   champ `ColorSpace`) donne l'**état HDR courant** du compositeur — allumé ou
   éteint, maintenant. Le web n'a que `matchMedia('(dynamic-range: high)')`, qui
   ne dit que la **capacité** de l'écran, jamais son état. On affiche donc un
   avertissement natif fiable « votre HDR est allumé, coupez-le (`Win+Alt+B`) » —
   pansement immédiat, gratuit.
2. **Tone-map correct (phase capture native).** Faire ce que fait OBS : capturer
   la surface native (Windows Graphics Capture en `R16G16B16A16_FLOAT` / scRGB, le
   HDR intact), appliquer **notre** tone-map HDR→SDR avec un « SDR white level »
   réglable (BT.2390 est le standard de référence), puis injecter les frames.
   **Web-impossible par construction**, durable — mais couplé au chantier lourd
   ci-dessous.

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

- **Raccourcis globaux** (`globalShortcut`) : mute micro / pause / stop **sans
  alt-tab**, pendant qu'on joue en plein écran.
- **Réglages mémorisés** entre sessions : dernière source, preset qualité, listes
  d'exclusion audio.
- **Wake lock fiable** : `powerSaveBlocker` natif (`prevent-display-sleep`) —
  remplace le `navigator.wakeLock` best-effort du web (`wakelock.ts`).
- **Notifications natives** quand un viewer **rejoint ou quitte**, utile fenêtre en
  arrière-plan. C'est **la seule** notification — rien de plus.

**Pas de tray.** Aucune icône de barre système, aucune réduction en arrière-plan :
fermer la fenêtre **quitte l'application** (cf. [Décisions](#décisions)). Les
raccourcis globaux suffisent au contrôle sans alt-tab ; un tray n'ajouterait qu'un
état « app cachée mais vivante » qu'on ne veut pas.

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
> gagne les raccourcis globaux, c'est le successeur naturel.

## Architecture

L'app charge le build web existant dans une fenêtre Electron. Une **seule
frontière** avec le natif : `window.native`.

```
electron/                     # sous-projet autonome (lockfile propre, hors workspace, cf. signaling/)
  src/main.ts                 # BrowserWindow, scheme app://, CSP, nav-lock, auto-update
  src/preload.ts              # contextBridge → window.native
  src/config.ts               # PUR (sans import electron) : origine, CSP, nav — testé
  src/audio/                  # (phase 2) addon N-API : WASAPI process loopback
  electron-builder.yml        # NSIS + publish GitHub Releases
src/                          # INCHANGÉ. astro build → dist/, servi par la fenêtre Electron
  lib/host.ts                 #   → utilise window.native si présent, getDisplayMedia sinon
```

**Le front seul est embarqué.** Le paquet ne contient que le build Astro
(`extraResources: ../dist`) + `out/` ; la seule dépendance runtime est
`electron-updater`. **Le serveur de signaling n'est pas embarqué** et ne le sera
jamais : l'app est un client qui parle au signaling déployé (par défaut
`https://stream.joanybuclon.com`, surchargeable via `SS_APP_ORIGIN` pour viser un
dev/staging).

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

Trois points ne se devinent pas depuis la doc et conditionnent la coquille. Tous
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

```
// ponytail: la source forcée n'est PAS un choix produit, c'est le strict minimum
// pour que la phase 1 capture quelque chose sans construire la feature n°2.
```

**Source imposée — phase 1 uniquement.** La coquille capture **l'écran principal**
(+ audio système via `audio: 'loopback'` quand la page le demande), sans aucun
choix possible. C'est une **béquille temporaire, pas le comportement cible** : le
sélecteur visuel (grille écrans **et** fenêtres, vignettes live, icônes d'app)
est la fonctionnalité n°2, livrée en **phase 2** via `desktopCapturer.getSources`
sur ce même handler. Le jour où il arrive, cette béquille disparaît.

## Distribution

- **Pas de signature de code**, assumé pour l'instant. Un `.exe` non signé
  déclenche SmartScreen (« Windows a protégé votre ordinateur ») ; la page de
  download **l'explique** (« Informations complémentaires → Exécuter quand même »).
  À noter : un certificat EV **ne bypasse plus** SmartScreen depuis 2026 (position
  officielle Microsoft), donc payer avant de savoir si l'app intéresse serait
  prématuré. Option future si besoin : **Azure Artifact Signing** (~120 $/an, sans
  token, intégrable en CI).
- **GitHub Releases + `electron-updater`.** L'app se met à jour seule ; sinon elle
  devient vite une dette face à un web toujours à jour.
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
  sélecteur de source, HDR, raccourcis globaux) et un lien de téléchargement :
  **Windows d'abord**, macOS et Linux dans un second temps.

## CI / packaging

Le workflow actuel (`.github/workflows/docker-publish.yml`, cf.
[`deployment.md`](./deployment.md)) a un job `quality` puis une matrice `publish`
à deux images (`web`, `signaling`). On ajoute **un troisième job de packaging
desktop, en parallèle des deux publish**, une fois `quality` passé :

- runner `windows-latest` (build natif, pas une image Docker) ;
- `electron-builder` → artefact `.exe` (NSIS) ;
- publication en **GitHub Release** (consommée par `electron-updater`).

```
// ponytail: job desktop en parallèle des publish, PAS avant quality. Un binaire
// qui n'a pas passé lint/typecheck/tests n'a rien à faire en release.
```

## Décisions

Actées le 2026-07-20. Les rouvrir demande une raison neuve, pas un changement
d'avis.

| Sujet              | Décision                                                |
| ------------------ | ------------------------------------------------------- |
| Périmètre          | Host uniquement, Windows d'abord                        |
| Techno             | Electron (dernière stable)                              |
| Modèle audio       | L'audio suit la source vidéo, puis liste d'exclusion    |
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
| **1 — coquille Electron** ✅ | L'app web emballée dans Electron : scheme `app://`, CSP mirrorée, nav-lock, close = quit, **page `/download`** + CTA accueil, **auto-update** (`electron-updater`), packaging NSIS + job CI sur tag `v*`. `window.native` ne porte que `appOrigin`. **Source imposée à l'écran principal** (béquille, cf. ci-dessus). | Un `.exe` qui partage comme le web, se met à jour seul, se télécharge. Le socle. **Validé** : host desktop → viewer Chrome, écran principal + audio système. |
| **2 — MVP**              | Audio par app (exclusion), grille de sources native, raccourcis globaux, réglages mémorisés, wake lock, notifications rejoint/quitte, avertissement HDR.                  | La version qui « récompense ». **Précédée d'un spike** : prouver que l'audio par process (Discord exclu) entre bien dans la peer connection — sinon la feature n°1 tombe, à réévaluer avant d'écrire le reste. |
| **3 — capture native**   | WGC/DXGI → injection : FPS garanti, tone-map HDR, encodage hardware, contrôle curseur. Fork architectural, **le vrai gain différentiel avec le web**.                     | Ouvert seulement si une de ces features est réellement demandée.                                                          |

## Reste à trancher

- **Comportement du sélecteur** quand une source disparaît en cours de session
  (fenêtre fermée) — repli sur écran, ou pause ?
- **macOS/Linux** : déclenchés par quel signal d'usage ? À décider quand Windows
  aura tourné.
