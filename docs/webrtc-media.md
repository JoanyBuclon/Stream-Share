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
    cursor: 'motion', // curseur : toggle host 'always' | 'never' | 'motion'
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
- **Curseur** : toggle host via la contrainte `cursor`.
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

| Codec     | Encodage temps réel                                      | Verdict                                                                                                                                                      |
| --------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **H.264** | Hardware partout (NVENC, QuickSync, AMF)                 | **Repli par défaut.** Latence mini, compat totale, coût CPU/GPU faible.                                                                                      |
| VP9       | Souvent software, plus lourd                             | Meilleure compression que H.264 mais coûteux en temps réel — pas prioritaire.                                                                                |
| **AV1**   | Hardware seulement sur GPU récents (RTX 40+, Arc, RDNA3) | **Préféré quand dispo.** Superbe qualité/bitrate ; l'encode software écroulerait un jeu 4K, donc on ne l'utilise que s'il est présent dans les capabilities. |

**Stratégie (automatique, aucun réglage manuel)** : à la négociation, on **préfère
AV1 s'il est présent dans les capabilities** (host capable de l'encoder + viewer
de le décoder), **sinon on retombe sur H.264**. La décision se prend une fois par
`RTCPeerConnection`, sans intervention de l'host.

```ts
// AV1 en tête s'il est disponible, sinon H.264. Décidé une fois à la négociation.
const caps = RTCRtpSender.getCapabilities('video');
transceiver.setCodecPreferences(orderCodecs(caps.codecs)); // AV1 > H.264 > reste
// ponytail: "disponible" = présence du codec dans getCapabilities. Pas de toggle.
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
  **son** encode + upload, pas la capture ; si *personne* ne veut la 4K, c'est la
  **capture** de l'host qu'il faut baisser.

## Audio

`getDisplayMedia({ audio: true })` capture l'audio de l'onglet/système quand le
navigateur et l'OS le permettent (dispo variable selon plateforme — à tester ;
généralement OK pour un onglet ou l'écran entier, pas pour une fenêtre isolée).
L'audio voyage dans la même `RTCPeerConnection` que la vidéo.

**Micro host (optionnel)** : l'host peut ajouter sa voix. Son système + micro
(`getUserMedia`) sont **mixés en une seule piste** via WebAudio (`AudioContext`)
avant l'envoi → une seule piste audio, synchronisée avec la vidéo par la stack.
Toggle dans le menu source. Upload négligeable (~40-64 kbps).

## Contrôles

| Côté   | Contrôle                 | Implémentation                                                                       |
| ------ | ------------------------ | ------------------------------------------------------------------------------------ |
| Host   | Source (écran/app)       | `getDisplayMedia` (picker natif) → `replaceTrack` sur chaque sender (pas de renégo). |
| Host   | Presets / res / FPS / bitrate | Presets = raccourci ; sinon `sender.setParameters` (plafond) + contrainte capture. |
| Host   | Mode contenu             | Bascule `contentHint` `'motion'` / `'detail'` sur la piste vidéo.                    |
| Host   | Curseur                  | Contrainte `cursor` sur `getDisplayMedia`.                                            |
| Host   | Micro                    | `getUserMedia` + mix WebAudio (cf. § Audio).                                          |
| Host   | Pause                    | `replaceTrack(null)` (ou piste noire) sur chaque sender — session maintenue.         |
| Host   | Kick / ban viewer        | Ferme la `RTCPeerConnection` du viewer + message `kick`/`ban` (cf. signaling).       |
| Host   | Fin du partage           | Ferme les `RTCPeerConnection` + `leave`.                                             |
| Viewer | Volume / mute            | `<video>.volume` / `.muted` — **purement local**, aucun aller-retour réseau.         |
| Viewer | Qualité                  | Demande un palier → l'host applique sur **son** sender (cf. § Qualité par-viewer).    |
| Viewer | Picture-in-picture       | `video.requestPictureInPicture()` (API native).                                      |
| Viewer | Plein écran              | Fullscreen API sur l'élément `<video>`.                                              |
| Viewer | Stats                    | `RTCPeerConnection.getStats()` en lecture (latency/fps/bitrate/loss).               |

`replaceTrack` (changement de source **et** pause) sans renégocier est le détail qui
rend ces transitions instantanées côté viewer.

## Pause du partage

L'host coupe le flux **sans quitter la session** : `replaceTrack(null)` (ou une
piste noire) sur chaque sender. Les `RTCPeerConnection` restent ouvertes, les viewers
affichent un placeholder « en pause ». Reprise = `replaceTrack(track)`, **sans
renégociation**.

## Reconnexion

Sur coupure ICE courte (`iceConnectionState` → `disconnected`/`failed`),
`pc.restartIce()` renégocie le transport **sans détruire la connexion** ; les
nouveaux candidats repassent par `signal`. Suppose le socket signaling vivant →
reconnexion WS légère (cf. [`signaling-server.md`](./signaling-server.md)). Si l'ICE
ne repart pas, on tombe sur le message d'échec (pas de TURN).
