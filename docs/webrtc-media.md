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

C'est le **plafond réel**, et il est **physique, pas logiciel** : il dépend de
l'uplink et du GPU de l'host. En pratique 2-4 viewers en haute qualité. On
**n'impose aucun cap arbitraire** (cohérent avec « aucune limite ») — c'est
l'host qui arbitre, et l'UI l'avertit à mesure que le nombre de viewers monte.

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
  video: {
    frameRate: { ideal: 60 }, // FPS choisi par l'host (voir ci-dessous)
  },
  audio: true, // son système/onglet si dispo (cf. § Audio)
  systemAudio: 'include',
  surfaceSwitching: 'include', // Chrome/Edge : changer de source sans re-prompt
  selfBrowserSurface: 'exclude',
});
stream.getVideoTracks()[0].contentHint = 'motion'; // jeux : fluidité > détail
```

- **Sélecteur natif uniquement.** Pas de grille de sources maison (impossible en
  navigateur). Après sélection, on affiche `track.label` (nom réel) + un aperçu du
  vrai flux. `surfaceSwitching` permet de changer de source sans redemander.
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

1. Host : `new RTCPeerConnection({ iceServers })`, `addTrack` pour chaque piste
   du `stream`.
2. Host : `createOffer` → `setLocalDescription` → `signal(offer)` au viewer.
3. Viewer : `setRemoteDescription` → `createAnswer` → `signal(answer)`.
4. Les deux : ICE candidates en trickle via `signal`.
5. Connecté → média direct.

## Codec

Le navigateur négocie le codec ; on **oriente la préférence** côté host via
`transceiver.setCodecPreferences(...)`.

| Codec     | Encodage temps réel                                      | Verdict                                                                                                                                      |
| --------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **VP9**   | Software, mais mature et raisonnable                     | **Préféré.** Screen-content coding + bien meilleure qualité/bit que VP8 ; compromis fiable, même en 4K.                                       |
| **AV1**   | Hardware seulement sur GPU récents (RTX 40+, Arc, RDNA3) | Superbe qualité/bit, mais l'encode software temps réel peine en 4K60 → **derrière VP9** (utilisé si présent et que VP9 n'est pas retenu).      |
| VP8       | Hardware/software partout                                | **Repli universel.** Compat totale, coût faible ; qualité/bit inférieure.                                                                     |

**Stratégie (automatique, aucun réglage manuel)** : à la négociation, on **préfère
VP9, puis AV1, puis VP8** en réordonnant les capabilities. La décision se prend une
fois par `RTCPeerConnection`, sans intervention de l'host. Via l'API
`setCodecPreferences` (pas de munging SDP → non rejeté par le navigateur).

```ts
// VP9 > AV1 > VP8, le reste (rtx/red…) conservé après. Décidé une fois à la négociation.
const caps = RTCRtpSender.getCapabilities('video');
transceiver.setCodecPreferences(orderCodecs(caps.codecs)); // cf. preferVideoCodecs() dans peer.ts
// ponytail: réordonner CODEC_PREFERENCE pour changer. Pas de toggle exposé.
```

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
// cf. tuneStartBitrate() dans peer.ts. ponytail: honoré par Chrome (VP8/VP9), no-op ailleurs
// (Firefox/AV1 l'ignorent) — le plafond passe toujours par setParameters/maxBitrate.
```

### Qualité par-viewer

L'host fixe le **plafond** (capture + res/bitrate max) ; chaque viewer peut demander
**plus bas, jamais plus haut**. Le mesh ayant déjà **un `sender` par viewer**, on
applique `scaleResolutionDownBy` + `maxBitrate` **sur le sender de ce viewer-là** —
zéro média serveur, aucun SFU.

- Paliers exposés au viewer : **`Source`** (pas de downscale) · **`Auto`** (WebRTC
  adapte seul via bandwidth estimation — gratuit, défaut) · **`1440p / 1080p / 720p`**.
- **Plafonné au flux host** : les paliers au-dessus de ce que l'host envoie
  **n'apparaissent pas** (on ne peut pas upscaler au-delà de la source). Plancher 720p.
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
| Host   | Fin du partage                | Ferme les `RTCPeerConnection` + `leave`.                                             |
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

## Reconnexion

Le wrapper `Peer` remonte l'état ICE via `onIceState` et, **côté host/offerer
uniquement**, tente un ICE restart :

- Sur `iceConnectionState` → **`failed`**, `pc.restartIce()` réémet une offre
  `iceRestart` (renégociation) **sans détruire la connexion** ; le viewer y répond
  via `accept()`, les nouveaux candidats repassent par `signal`. Une garde empêche
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
