# Média WebRTC (mesh)

Le cœur du produit. L'host capture son écran et le pousse **directement** vers
chaque viewer via WebRTC. Aucun octet de média ne passe par le serveur.

## Topologie mesh

**1 host → N viewers.** L'host ouvre **une `RTCPeerConnection` par viewer** et
**encode le flux séparément pour chacun** (chaque pair négocie son propre codec /
bitrate).

```
              ┌──▶ RTCPeerConnection #1 ──▶ Viewer A
   Host ──────┼──▶ RTCPeerConnection #2 ──▶ Viewer B
 (1 capture)  └──▶ RTCPeerConnection #3 ──▶ Viewer C
```

### Le coût host (la physique du mesh)

Le mesh met tout le coût sur l'host :

- **Encodage** : N encodes simultanés. À 4K60, chaque encode NVENC/QuickSync est
  coûteux ; les GPU récents en tiennent quelques-uns, pas une foule.
- **Upload** : N × le bitrate. À 4K60 (~25-40 Mbps), 4 viewers = 100-160 Mbps
  d'upload — au-delà, la plupart des connexions résidentielles saturent.

C'est le **plafond réel**, et il est **d'abord physique** : il dépend de l'uplink
et du GPU de l'host. En pratique 2-4 viewers en haute qualité. Un **cap logiciel**
le double côté serveur (`MAX_VIEWERS`, défaut **10** ; au-delà → `join-error: full`) —
non pour brider la qualité, mais parce que le mesh ne tient pas beaucoup plus loin :
il protège autant le navigateur de l'host que la mémoire du serveur. L'UI avertit
l'host à mesure que le nombre de viewers monte.

> ⚠️ **Sessions NVENC concurrentes — non mesuré, et le mode de panne est vilain.**
> Depuis que H.265 est préféré, chaque viewer Chrome ouvre **une session d'encodeur
> matériel**. Les GeForce plafonnent le nombre de sessions simultanées (3, puis 5,
> puis 8 selon les générations de pilote) — or `MAX_VIEWERS` vaut 10, au-dessus de
> toutes ces valeurs. Ce n'était pas un sujet tant que tout était software.
> Le point qui fait mal : **Chromium n'a pas d'encodeur HEVC logiciel**. VP9 qui
> échoue en hardware retombe sur libvpx ; H.265 qui n'obtient pas de session NVENC
> n'a **nulle part où retomber**, et le codec est déjà négocié dans le SDP. Le
> risque n'est donc pas « ce viewer est moins fluide » mais « ce viewer voit du
> noir ». La validation bout en bout ne couvre **qu'un seul viewer** et ne dit rien
> au-delà. À mesurer à la prochaine session à 4-5.

**Pas de SFU — définitif.** Un SFU (l'host envoie **un** flux, un serveur le
redistribue) lèverait ce plafond, mais relaierait le média par un serveur → même
raison que le refus du TURN : ça casse le principe « zéro média serveur ». Le
mesh **est** l'architecture.

```
// ponytail: mesh, point final. Le SFU n'est pas une dette différée mais un
// non-choix assumé (zéro média serveur). Ne pas le réintroduire par la fenêtre.
```

## Capture d'écran

`getDisplayMedia` — l'host choisit onglet / fenêtre / écran via le sélecteur natif
du navigateur (pas de code à écrire pour ça).

```ts
const stream = await navigator.mediaDevices.getDisplayMedia({
  video: { frameRate: { ideal: quality.fps } }, // FPS choisi par l'host (voir ci-dessous)
  // Son système : on coupe le traitement voix du navigateur (AGC / réduction de bruit /
  // annulation d'écho) et on force stéréo 48 kHz = capture brute. `false` si le partage du
  // son système est désactivé dans les réglages.
  audio: quality.systemAudio
    ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 }
    : false,
});
stream.getVideoTracks()[0].contentHint = 'motion'; // jeux : fluidité > détail (posé par contentHintFor)
```

- **Sélecteur natif uniquement.** Pas de grille de sources maison (impossible en
  navigateur). Après sélection, on affiche `track.label` (nom réel) + un aperçu du
  vrai flux. Changer de source relance le sélecteur natif (un nouveau
  `getDisplayMedia`) : pas de switch sans re-consentement côté web.
- **Résolution** : dictée par la source. On ne la bride pas → 4K native si l'host
  partage un écran 4K (il peut downscaler, cf. § Qualité).
- **FPS** : choix host `10 / 30 / 60 / 120`. `10` sert au contenu bureautique ; `120`
  est **best-effort** (dépend de la source et du navigateur, souvent non honoré).
- **Curseur** : **pas de contrôle** — la contrainte `cursor` est ignorée par les
  navigateurs (Chrome capture toujours le curseur), donc pas de toggle exposé.
- **`contentHint`** : **défaut `'motion'`** (jeu : privilégie le framerate),
  `'detail'` pour du statique. Posé aussi par les presets (cf. § Qualité).

## Négociation (host-initiated)

Déclenchée par `peer-joined` (cf. [`signaling-server.md`](./signaling-server.md)) :

1. Host : `new RTCPeerConnection({ iceServers })`, puis un transceiver `sendonly` par
   **kind** (`video`, `audio`) via `addTransceiver` — **même si la source initiale n'a pas
   cette piste** (m-lines pré-négociées + `streams: [stream]` pour poser le `a=msid`). C'est
   ce qui permet le hot-swap de source/audio par `replaceTrack` **sans renégocier**.
2. Host : `createOffer` → `setLocalDescription` → `signal(offer)` au viewer.
3. Viewer : `setRemoteDescription` → `createAnswer` → `signal(answer)`.
4. Les deux : ICE candidates en trickle via `signal`.
5. Connecté → média direct.

## Codec

Le navigateur négocie le codec ; on **oriente la préférence** côté host via
`transceiver.setCodecPreferences(...)`.

L'ordre est **`H.265 > VP9 > AV1 > H.264 > VP8`**. Les quatre premières positions
sont **mesurées** (2026-08-03, banc décrit plus bas) ; **VP8 est un défaut, pas une
mesure** — il n'est atteint que si tout le reste manque.

| Codec      | Encodeur réel obtenu             | ms CPU / frame (1 → 4 viewers) | Verdict                                                                                                            |
| ---------- | -------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| **H.265**  | `NVIDIA HEVC MFT` — **hardware** | **4,2 → 5,4**                  | **Préféré.** Seul codec qui déplace le plafond host : ~8× moins cher par frame que le meilleur software.            |
| **VP9**    | `libvpx` — software              | 42 → 48                        | **Repli principal.** Ce que reçoivent Firefox et les Chromium sans codecs propriétaires — donc inchangé pour eux.   |
| **AV1**    | `libaom` — software              | 45 → **84**                    | Meilleur débit et plus de fps que VP9, **mais 16 % d'un 32 threads par viewer, 67 % à quatre**. Voir ci-dessous.    |
| H.264      | `NVIDIA H.264 MFT` — hardware    | 25 en Baseline, **4,9 en High** | 4ᵉ **par mesure** — le profil que Chrome propose en premier est le mauvais, et Firefox n'a que celui-là. Cf. ci-dessous. |
| VP8        | `libvpx` — software              | *(non mesuré)*                 | **Repli universel**, dernier par défaut, pas par mesure.                                                             |

#### Pourquoi H.264 reste 4ᵉ alors qu'il est matériel

C'est le point le plus contre-intuitif du classement, et il a fallu le mesurer pour
le trancher. À 2560×1440, résolution épinglée, en ne changeant **que** l'entrée
H.264 mise en tête des préférences :

| Entrée forcée         | Profil négocié      | fps     | ms CPU/frame |
| --------------------- | ------------------- | ------- | ------------ |
| ordre de Chrome        | `42…` Baseline 3.1  | **14**  | 25           |
| `640020` (High 3.2)   | `64…`               | **121** | **4,9**      |
| `4d001f` (Main 3.1)   | `4d…`               | 119     | 5,4          |
| *H.265, contrôle*     | —                   | 119     | 6,5          |
| *VP9, contrôle*       | —                   | 9       | 32           |

Trois conclusions :

1. **Le plafond de niveau est réel** : 14 fps contre 121, même codec, même machine,
   même source. Le niveau 3.1 est bien spécifié pour 720p30 et Chromium le respecte.
2. **`level-asymmetry-allowed=1` ne le relâche pas.** Le paramètre est présent dans
   les fmtp offertes et le résultat ne bouge pas — l'hypothèse inverse a été testée
   et elle est fausse.
3. **La cause n'est pas H.264, c'est l'entrée que Chrome annonce en premier.**
   `orderCodecs` ne trie que par `mimeType`, donc à l'intérieur de H.264 il conserve
   l'ordre du navigateur — Baseline d'abord.

**Et pourtant on ne le remonte pas**, parce que le seul public que ça servirait ne
peut pas en profiter : **Firefox n'offre que du Baseline** (`42e01f`, `42001f` —
mesuré prefs forcées). Le passer devant VP9 leur donnerait la ligne à 14 fps là où
VP9 leur donne du 1080p60. Le remonter n'aurait de sens qu'avec un tri **conscient
des profils** *et* une adaptation de résolution par viewer — beaucoup de machinerie
pour un codec qui, en 4ᵉ position, n'est atteint que si H.265, VP9 **et** AV1 sont
tous absents, ce qui n'arrive sur aucun navigateur réel mesuré ici.

**H.265 en tête** parce que c'est la seule ligne qui touche
[le coût host](#le-coût-host-la-physique-du-mesh) : en mesh l'host encode **une
fois par viewer**, et l'écart hardware/software est d'un ordre de grandeur par
frame. Rien n'est imposé à personne — la négociation garde l'intersection avec ce
que **ce** viewer sait décoder, et il y a une `RTCPeerConnection` par viewer, donc
la dégradation est individuelle.

**VP9 devant AV1**, et c'est le point contre-intuitif : AV1 monte **plus haut** en
fps, mais il l'achète avec du CPU. 16 % d'un Ryzen 9 7950X (32 threads) par viewer,
67 % à quatre — sur la meilleure machine host qu'on puisse avoir. Un host 4 cœurs
s'écroule. VP9 coûte ~2,5 %. **À rouvrir sur RTX 40+ / Arc / RDNA3**, où NVENC
encode AV1 et où ce classement change de forme.

Conséquence à connaître : la charge de l'host **dépend désormais du mix de
navigateurs de la room**. Un seul viewer Firefox (VP9 software, ~45 ms/frame) coûte
plus que trois viewers Chrome réunis (H.265 hardware, ~5 ms/frame).

```ts
// H.265 > VP9 > AV1 > H.264 > VP8, le reste (rtx/red…) conservé après, tri stable.
const caps = RTCRtpSender.getCapabilities('video');
transceiver.setCodecPreferences(orderCodecs(caps.codecs)); // cf. preferVideoCodecs() dans peer.ts
// ponytail: réordonner CODEC_PREFERENCE pour changer. Pas de toggle exposé.
```

### Ce que les viewers acceptent réellement (mesuré)

`RTCRtpReceiver.getCapabilities('video')` sur de vrais navigateurs, pas sur de la
doc :

| Viewer                                       | H.265                   | AV1        | VP9                          | H.264                          |
| -------------------------------------------- | ----------------------- | ---------- | ---------------------------- | ------------------------------ |
| **Chrome 150 et 151** (Windows)              | ✅ Main **et Main10**   | ✅ prof. 0/1 | ✅ prof. 0-3                | ✅ jusqu'à High                |
| **Firefox 151, 152, 153**                    | ❌                      | ✅ sans plafond | ⚠️ `max-fs=12288;max-fr=60` | baseline seule, sans plafond |
| Chromium sans codecs propriétaires (≈ Linux) | ❌                      | ✅          | ✅                           | ✅                             |

Deux choses qui ne se devinent pas :

- **Firefox n'a pas H.265 du tout** — vérifié sur 153 en forçant
  `media.peerconnection.video.h265.enabled`, `media.wmf.hevc.enabled` et
  `media.hevc.enabled` : la liste ne bouge pas. Il n'y a pas de plomberie dans
  Gecko, pas juste un défaut désactivé. Le HDR ajouté par Firefox 153 concerne la
  **lecture `<video>`**, ni WebRTC ni la capture.
- **Firefox plafonne VP8/VP9 par SDP** : `max-fs=12288` (3,1 Mpx) et `max-fr=60`.
  Un viewer Firefox est donc **bridé à 1080p60**, aujourd'hui comme demain, et rien
  dans l'UI ne le dit. Seuls son AV1 et son H.264 échappent au plafond. Sujet
  ouvert, indépendant du choix de codec.

### Le banc

Mesuré sur **Ryzen 9 7950X (32 threads) / RTX 3080 Ti / Windows**, source 2560×1440,
**résolution épinglée** (`maintain-resolution`), CPU lue sur tout l'arbre de process
et normalisée **par frame encodée**. Cette normalisation est le cœur du banc : sans
elle VP9 paraît économe alors qu'il encode simplement dix fois moins d'images.

Trois limites à garder en tête avant de citer ces chiffres :

- **Une seule machine, un seul GPU.** La 3080 Ti est Ampere, donc **pas d'encodage
  AV1 en NVENC** ; sur Ada le tableau serait à refaire.
- **Le débit vient du loopback**, pas d'un vrai réseau : la colonne `ms/frame` est
  robuste, les fps sont indicatifs (jusqu'à 5× d'écart entre deux exécutions).
- **`x-google-start-bitrate` n'est pas mesurable ici.** 5 répétitions par condition
  donnent −4 % / +3 % / −1 % pour VP9 / H.265 / H.264 — du bruit, y compris pour VP9
  où le hack tourne depuis toujours. Sans congestion, l'estimateur atteint 4,8 Mbps
  en 2,5 s tout seul, c'est-à-dire exactement le démarrage lent que le hack existe
  pour sauter. Il reste appliqué à H.264/H.265 par cohérence — un tuning qui
  disparaît en silence le jour où le codec par défaut change serait une régression
  par omission — mais **son bénéfice reste à prouver sur un vrai réseau**.

**Validé de bout en bout** (et pas seulement en loopback) : coquille Electron en
host, **Chrome réel** en viewer, vrai signaling. H.265 négocié, encodeur
`NVIDIA HEVC Encoder MFT` (`powerEfficientEncoder: true`), 2560×1440, et le viewer
décode **405 frames pour 405 encodées**.

> Portée exacte de cette validation, parce qu'elle est étroite : **un** viewer,
> ~7 secondes, **une** machine, **un** GPU NVIDIA, **un** OS. Elle prouve qu'un flux
> H.265 matériel arrive et se décode. Elle ne dit rien de AMD (AMF), d'Intel (QSV),
> de macOS, de Linux, ni — surtout — du comportement à 4-5 viewers, qui est
> justement là où vit le mode de panne décrit ci-dessus. Le mode de panne a été
> nommé et la validation a été faite à côté.

> ⚠️ **La suite Playwright ne peut pas couvrir ce chemin.** Son Chromium est buildé
> sans les codecs propriétaires — mesuré : il n'offre aucun H.265 — donc un e2e y
> négocierait VP9 et passerait au vert sans rien prouver. Toute vérification H.265
> demande un Chrome réel.

## Qualité & bitrate

Réglé par l'host sur le **sender**, sans renégociation :

```ts
const params = sender.getParameters();
params.encodings[0].maxBitrate = 40_000_000; // ex. 40 Mbps, pas de plafond imposé
params.degradationPreference = 'maintain-framerate'; // jeux : sacrifier la résolution avant le fps
// params.encodings[0].scaleResolutionDownBy = 1;     // 1 = pleine résolution
await sender.setParameters(params);
```

- **Aucune limite produit** sur `maxBitrate` : c'est un curseur exposé à l'host.
- **`degradationPreference`** : `maintain-framerate` pour du jeu (on préfère
  baisser la résolution que lâcher des frames).
- **Presets host** : « Gaming / Bureautique / Ciné » = un raccourci qui pose d'un
  coup résolution + FPS + bitrate + `contentHint`.

**`maxBitrate` est un plafond, pas une cible.** Le débit réel émis = `min(plafond,
estimation de bande passante, besoin du contenu, CPU)` — un écran statique produit
peu de bits *par design*, et la congestion control (BWE) commande souvent. On ne
peut **pas forcer un plancher** via l'API standard. Pour éviter le démarrage lent
(ramp depuis ~300 kbps), on **relève le start/min-bitrate dans le SDP de l'offre** :

```ts
// À l'offre : a=fmtp des codecs vidéo += x-google-start-bitrate / x-google-min-bitrate.
// cf. tuneStartBitrate() dans peer.ts. ponytail: honoré par Chrome, no-op ailleurs (Firefox
// l'ignore) — le plafond passe toujours par setParameters/maxBitrate.
```

Couvre **VP8/VP9/AV1/H264/H265** : H.265 étant devenu le codec préféré, le limiter
aux VPx aurait fait disparaître le tuning du chemin dominant sans que rien ne le
signale. Vérifié qu'une fmtp H.265 ainsi taguée négocie toujours (les paramètres
fmtp inconnus sont ignorables par spec, et Chromium les ignore). **Son effet, lui,
n'est pas prouvé** — cf. [Le banc](#le-banc).

> **`x-google-min-bitrate` a été RETIRÉ** au passage, et c'est la moitié importante
> du changement. Les deux paramètres n'ont pas le même profil de risque : le *start*
> est un point de départ que l'estimateur écrase en ~2,5 s, dégâts bornés. Le *min*
> était un **plancher d'allocation encodeur** à 40 % du plafond — 8 Mbps **par
> viewer** au réglage par défaut — et un plancher est précisément ce qui ne recule
> pas sous congestion. Il n'a semblé inoffensif que parce qu'il portait sur libvpx :
> VP9 à 42-48 ms par frame 1440p n'a jamais soutenu ça. **HEVC matériel à ~4 ms par
> frame, si.** Le plancher est devenu réellement atteignable le jour où l'ordre des
> codecs a changé. Un risque non mesuré au service d'un bénéfice jamais démontré :
> le loopback n'a aucune congestion, donc le banc mesurait le paramètre bénin et
> était aveugle à l'autre par construction.

### Qualité par-viewer

L'host fixe le **plafond** (capture + res/bitrate max) ; chaque viewer peut demander
**plus bas, jamais plus haut**. Le mesh ayant déjà **un `sender` par viewer**, on
applique `scaleResolutionDownBy` + `maxBitrate` **sur le sender de ce viewer-là** —
zéro média serveur, aucun SFU.

- Paliers exposés au viewer : **`Auto`** (WebRTC adapte seul via bandwidth estimation —
  gratuit, défaut) · **`Source`** (pas de downscale) · **`1440p / 1080p / 720p / 480p`**.
- **Plafonné au flux host** : les paliers au-dessus de ce que l'host envoie
  **n'apparaissent pas** (on ne peut pas upscaler au-delà de la source). Plancher 480p.
- **Rappel du coût** : la capture est payée **une fois**. Baisser un viewer allège
  **son** encode + upload, pas la capture ; si _personne_ ne veut la 4K, c'est la
  **capture** de l'host qu'il faut baisser.

## Audio

`getDisplayMedia({ audio: true })` capture l'audio de l'onglet/système quand le
navigateur et l'OS le permettent (dispo variable selon plateforme — à tester ;
généralement OK pour un onglet ou l'écran entier, pas pour une fenêtre isolée).
L'audio voyage dans la même `RTCPeerConnection` que la vidéo.

**Qualité (deux réglages, tous deux nécessaires)** — par défaut la chaîne WebRTC
est réglée pour la voix, ce qui rend l'audio d'onglet/système mono et sourd :

1. **Capture** : `echoCancellation` / `noiseSuppression` / `autoGainControl` sont
   mis à `false` (+ `channelCount: 2`) sur `getDisplayMedia`. Laissés par défaut,
   le navigateur applique son traitement voix, qui downmixe en mono. Le micro,
   lui, **garde** son traitement — c'est ce qu'on veut pour une voix.
2. **Codec** : Opus est négocié mono ~32 kbps par défaut. `tuneOpus` (cf.
   `peer.ts`) injecte `stereo=1;sprop-stereo=1;maxaveragebitrate=128000` dans
   **chaque** SDP local. Un encodeur Opus lit ces params dans la description
   **distante** : le stéréo côté host vient donc du `stereo=1` de la réponse du
   viewer — d'où le tuning des deux côtés (offre, réponse, offre d'ICE restart).

**Micro host (optionnel)** : l'host peut ajouter sa voix. Son système + micro
(`getUserMedia`) sont **mixés en une seule piste** via WebAudio (`AudioContext`)
avant l'envoi → une seule piste audio, synchronisée avec la vidéo par la stack.
Toggle dans le menu source. Upload ~128 kbps (négligeable devant la vidéo).

## Contrôles

| Côté   | Contrôle                      | Implémentation                                                                       |
| ------ | ----------------------------- | ------------------------------------------------------------------------------------ |
| Host   | Source (écran/app)            | `getDisplayMedia` (picker natif) → `replaceTrack` sur chaque sender (pas de renégo). |
| Host   | Presets / res / FPS / bitrate | Presets = raccourci ; sinon `sender.setParameters` (plafond) + contrainte capture.   |
| Host   | Mode contenu                  | Bascule `contentHint` `'motion'` / `'detail'` sur la piste vidéo.                    |
| Host   | Micro                         | `getUserMedia` + mix WebAudio (cf. § Audio).                                         |
| Host   | Pause                         | `replaceTrack(null)` (ou piste noire) sur chaque sender — session maintenue.         |
| Host   | Kick / ban viewer             | Ferme la `RTCPeerConnection` du viewer + message `kick`/`ban` (cf. signaling).       |
| Host   | Couper la source              | Stoppe la capture, **garde le salon + les peers** : viewers → écran « en pause », host → retour au choix de source (`stopSource`). Bouton Stop, « Stop sharing » du navigateur, ou fenêtre partagée fermée (piste `ended`). |
| Host   | Fin de session                | Retour accueil (logo) → ferme les `RTCPeerConnection` + `leave`. Onglet/navigateur fermé = coupure socket (fenêtre de grâce, cf. reclaim).                                              |
| Viewer | Volume / mute                 | `<video>.volume` / `.muted` — **purement local**, aucun aller-retour réseau.         |
| Viewer | Qualité                       | Demande un palier → l'host applique sur **son** sender (cf. § Qualité par-viewer).   |
| Viewer | Picture-in-picture            | `video.requestPictureInPicture()` (API native).                                      |
| Viewer | Plein écran                   | Fullscreen API sur l'élément `<video>`.                                              |
| Viewer | Stats                         | `RTCPeerConnection.getStats()` en lecture (latency/fps/bitrate/loss).                |

`replaceTrack` (changement de source **et** pause) sans renégocier est le détail qui
rend ces transitions instantanées côté viewer.

## Pause du partage

L'host coupe la **vidéo sans quitter la session** : un flag `paused` retire la piste
vidéo du flux sortant, appliqué par `replaceTrack(null)` sur chaque sender (via le
pipeline `replaceTracks` existant). Les `RTCPeerConnection` restent ouvertes,
**l'audio continue**. Reprise = `replaceTrack(track)`, **sans renégociation**.

En plus du média, l'host **notifie** chaque viewer d'un message de contrôle
`{ control: 'pause' | 'resume' }` **relayé via `signal`** (payload opaque, distinct
du SDP/ICE — le viewer le filtre par un type guard). C'est ce message, pas la
détection de piste muette (peu fiable selon les navigateurs), qui pilote l'écran
« en pause » côté viewer. Un viewer qui rejoint/reconnecte pendant une pause est
notifié **avant** l'offre (pas de flash « live »).

**Pas de source = même écran.** Tant que l'host n'a choisi **aucune** source (à
l'ouverture du salon **ou** après un « couper la source »), les viewers voient ce même
écran « en pause ». L'host leur offre malgré tout un peer — flux **vide**, les m-lines
vidéo/audio étant pré-négociées (cf. plus haut) — et envoie `control: 'pause'` : le
viewer **établit** la connexion puis se pose « en pause », au lieu de rester bloqué sur
« connexion ». Choisir une source fait alors `replaceTrack` + `resume` : la vidéo arrive
**sans** que le viewer rejoigne. C'est aussi ce qui distingue « en pause » (host présent,
salon vivant) de l'écran « host a arrêté », réservé au **départ** de l'host (`peer-left`).

## Reconnexion

Le wrapper `Peer` remonte l'état ICE via `onIceState` et, **côté host/offerer
uniquement**, tente un ICE restart :

- Sur `iceConnectionState` → **`failed`**, `Peer.restartIce()` réémet une offre
  `createOffer({ iceRestart: true })` (renégociation) **sans détruire la connexion** ; le
  viewer y répond via `accept()`, les nouveaux candidats repassent par `signal`. Une garde empêche
  deux restarts de se chevaucher, et le nombre de restarts est **plafonné (5)** :
  sur un lien définitivement mort, on cesse au lieu de re-offrir en boucle (le
  compteur se réinitialise dès qu'on repasse `connected`).
- **`disconnected`** est seulement remonté (`onIceState`) — il se rétablit souvent
  seul, on ne relance pas dessus. L'UI peut afficher « reconnexion… ».

Suppose le socket signaling vivant → reconnexion WS légère du client (cf.
[`signaling-server.md`](./signaling-server.md)). Le viewer, lui, n'est pas offerer :
il ne relance pas l'ICE, il répond à l'offre `iceRestart` du host. Si le transport
ne repart pas, le viewer sort de « reconnexion… » vers **« connexion impossible »**
après un délai (~20 s) — pas de TURN, échec assumé.
