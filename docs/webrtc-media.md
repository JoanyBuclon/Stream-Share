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
  video: { frameRate: { ideal: 60, max: 60 } }, // la résolution suit la source
  audio: true, // audio d'onglet/système si dispo
});
stream.getVideoTracks()[0].contentHint = 'motion'; // jeux : priorité fluidité > détail
```

- **Résolution** : dictée par la source capturée. On ne la bride pas → 4K native
  si l'host partage un écran 4K.
- **`contentHint`** : bascule exposée à l'host, **défaut `'motion'`** (jeu :
  privilégie le framerate). `'detail'` pour du contenu statique (présentation,
  code) où la netteté image par image prime.

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
- **Réglages globaux** : les contrôles de l'host s'appliquent **uniformément à
  tous les viewers** (un seul jeu de paramètres, répliqué sur chaque `sender`).
  Chaque `sender` est techniquement indépendant, mais on n'expose **pas** de
  réglage par-viewer — inutile pour le cas d'usage.

## Audio

`getDisplayMedia({ audio: true })` capture l'audio de l'onglet/système quand le
navigateur et l'OS le permettent (dispo variable selon plateforme — à tester).
L'audio voyage dans la même `RTCPeerConnection` que la vidéo.

## Contrôles

| Côté   | Contrôle                 | Implémentation                                                                       |
| ------ | ------------------------ | ------------------------------------------------------------------------------------ |
| Host   | Source (écran/app)       | Relance `getDisplayMedia` → `replaceTrack` sur chaque sender (pas de renégociation). |
| Host   | Qualité / bitrate        | `sender.setParameters` (appliqué à tous les senders).                                |
| Host   | Mode contenu             | Bascule `contentHint` `'motion'` (jeu) / `'detail'` (statique) sur la piste vidéo.   |
| Host   | Fin du partage           | Ferme les `RTCPeerConnection` + `leave`.                                             |
| Viewer | Volume                   | `<video>.volume` — **purement local**, aucun aller-retour réseau.                    |
| Viewer | Plein écran              | Fullscreen API sur l'élément `<video>`.                                              |
| Viewer | Stats (latence, bitrate) | `RTCPeerConnection.getStats()` en lecture.                                           |

`replaceTrack` pour changer de source sans renégocier est le détail qui rend le
changement d'écran instantané côté viewer.
