# Serveur de signaling

Un micro-process Node basé sur **`ws` brut**. Deux responsabilités, rien de plus :

1. **Registre des salons** (la `Map` de [`rooms-and-codes.md`](./rooms-and-codes.md)).
2. **Relais aveugle** des messages de signaling entre pairs (SDP + ICE).

Il ne voit **jamais** de média : une fois la connexion WebRTC établie, le flux
passe directement d'un navigateur à l'autre.

## Pourquoi `ws` brut

Le signaling ne transporte que quelques messages JSON par connexion (une offre,
une réponse, une poignée de candidates ICE). Socket.io (reconnexion auto, rooms,
fallback long-polling) et µWebSockets.js (perf brute) résoudraient des problèmes
qu'on n'a pas. `ws` fait le travail en quelques dizaines de lignes.

```
// ponytail: ws brut. Repasser sur socket.io seulement si on a besoin de
// reconnexion transparente ou d'un fallback réseau — pas un besoin ici.
```

## Protocole de messages

Format : JSON `{ type, ...payload }`. Le serveur attribue un `peerId` par
connexion (envoyé dans `hello`) et ne route que par salon.

### Client → serveur

| `type`    | Payload                   | Effet                                                                                                                     |
| --------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `create`  | —                         | Crée un salon, renvoie `created` (code + `hostToken`). L'émetteur devient host.                                           |
| `join`    | `{ code, pseudo, token }` | Valide le code **et le ban** (IP ou token). OK → `joined` à l'émetteur + `peer-joined` à l'host. KO/banni → `join-error`. |
| `reclaim` | `{ code, hostToken }`     | **(host)** reprend son salon après une coupure, dans la fenêtre de grâce. OK → `reclaimed`. KO → `reclaim-error`.         |
| `signal`  | `{ to, data }`            | Relaie `data` (SDP offer/answer ou ICE candidate) au pair `to`. Sert aussi à l'ICE restart.                               |
| `kick`    | `{ peerId }`              | **(host)** éjecte un viewer → `kicked` au viewer + fermeture de sa connexion.                                             |
| `ban`     | `{ peerId }`              | **(host)** éjecte **et** bannit (IP + token, cf. [`rooms-and-codes.md`](./rooms-and-codes.md)) pour la durée du salon.    |
| `leave`   | —                         | **Départ volontaire** (Stop/Quitter) : fin **immédiate**. Host → salon détruit + viewers notifiés (`peer-left`) sur-le-champ ; viewer → retiré, host notifié. **Pas de grâce** (contrairement à une coupure de socket, qui elle laisse la fenêtre de reclaim). |

### Serveur → client

| `type`          | Payload                                    | Sens                                                                                                         |
| --------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `hello`         | `{ peerId }`                               | Id de connexion attribué à ce client.                                                                        |
| `created`       | `{ code, display, hostToken, iceServers }` | Salon créé. `display` = code formaté `XXX-XXX`, `hostToken` = secret de reclaim, `iceServers` = config STUN. |
| `joined`        | `{ hostId, iceServers }`                   | Le viewer est entré ; id de l'host à contacter + config STUN.                                                |
| `join-error`    | `{ reason }`                               | Code inconnu / salon fermé / banni (message opaque).                                                         |
| `peer-joined`   | `{ peerId, pseudo }`                       | Notifie l'host qu'un viewer est arrivé → l'host initie l'offre.                                              |
| `reclaimed`     | `{ viewers, iceServers }`                  | Reclaim réussi. `viewers` = `[{ peerId, pseudo }]` du salon repris.                                          |
| `reclaim-error` | `{ reason }`                               | Reclaim refusé (salon absent, hors grâce, ou mauvais token).                                                 |
| `signal`        | `{ from, data }`                           | Transporte le SDP/ICE d'un pair vers l'autre.                                                                |
| `kicked`        | `{ banned }`                               | Le viewer est éjecté (`banned:true` s'il est aussi banni) → écran de fin.                                    |
| `peer-left`     | `{ peerId, reason? }`                      | Un pair a quitté → fermer la `RTCPeerConnection` associée.                                                   |

Le serveur **ne comprend pas** le contenu de `data` : il le recopie tel quel du
pair source vers le pair cible. C'est ce qui garantit qu'il reste hors du média.

## Cycle de vie d'une connexion

```
Host                     Serveur (ws)                 Viewer
 │── create ─────────────▶│
 │◀── created{code,token} │
 │   (partage le code)    │
 │                        │◀──────── join{code} ───────│
 │                        │───────── joined{hostId} ──▶│
 │◀── peer-joined{viewer} │
 │── signal(offer) ──────▶│── signal(offer) ──────────▶│
 │◀── signal(answer) ─────│◀───────── signal(answer) ──│
 │◀▶ signal(ICE) ────────▶│◀▶ signal(ICE) ────────────▶│   (trickle, des deux côtés)
 │                                                     │
 │═══════════ WebRTC établi : média DIRECT host → viewer ═══════════▶│
```

**Trickle ICE** : les candidates sont envoyées au fil de l'eau via `signal` (on
n'attend pas de les avoir toutes) — connexion plus rapide à s'établir.

Nettoyage : à la fermeture **inattendue** d'une socket, on applique les règles de
cycle de vie des salons — viewer retiré (host notifié `peer-left`), ou, si c'était
l'host, **délai de grâce de 30 s** avant destruction (fenêtre de reclaim, cf.
[`rooms-and-codes.md`](./rooms-and-codes.md)). Un **`leave` explicite** (Stop/Quitter)
court-circuite la grâce : fin immédiate.

## Reconnexion (blip réseau)

Trois niveaux, tous **minimaux** (on ne vise pas une reprise de session complexe) :

- **Socket signaling** : si le WebSocket tombe, le client le **rouvre**
  automatiquement (statut `reconnecting` → `open`, plafonné à quelques tentatives).
- **Re-entrée dans le salon** : sur reconnexion, un **viewer** re-`join` (nouveau
  `peerId`, nouvelle `RTCPeerConnection`) ; un **host** reprend son salon via
  **`reclaim { code, hostToken }`** dans la fenêtre de grâce — il **récupère son
  ancien `peerId`** pour que les `signal { to: hostId }` des viewers continuent de
  router (continuité). Le serveur lui renvoie la liste des viewers dans `reclaimed`.
- **Média** : côté host/offerer, sur `iceConnectionState → failed`, `pc.restartIce()`
  renégocie le transport **sans détruire la connexion** ; les nouveaux candidats
  repassent par `signal`. `disconnected` est juste remonté (il se rétablit souvent
  seul). Les restarts sont **plafonnés (5)** pour ne pas boucler sur un lien mort ;
  côté viewer, un « reconnexion… » qui ne repart pas bascule sur **« connexion
  impossible »** après ~20 s. Si l'ICE ne repart pas, pas de TURN → échec assumé.

```
// ponytail: reconnexion = rouvrir le socket + (reclaim host | re-join viewer) +
// restartIce. Pas de file d'attente de messages, pas de resync d'état complexe.
```

## STUN (et pourquoi pas de TURN)

- **STUN, obligatoire.** Les clients reçoivent une liste `iceServers` (ex.
  `stun:stun.l.google.com:19302`) dans `created` / `joined` / `reclaimed`. Le STUN
  sert uniquement à **découvrir l'adresse publique** de chaque pair ; il ne voit
  jamais de média. C'est ce qui permet la connexion directe à travers la plupart des NAT.
- **Pas de TURN — décision d'architecture.** Un TURN relaierait tout le flux média
  par un serveur → ça détruirait le principe « zéro média serveur » et l'objectif
  de légèreté (un serveur de plus, qui porte toute la bande passante vidéo). On
  l'assume pleinement.
- **Conséquence assumée** : quand **les deux pairs** sont derrière des NAT
  symétriques, la connexion directe est impossible (~10-20 % des paires selon les
  réseaux). Dans ce cas `iceConnectionState` passe à `failed` → on affiche à
  l'utilisateur un **message clair** (« connexion directe impossible, réseau trop
  restrictif — essaie un autre réseau ou un partage de connexion »). Pas de repli
  silencieux, pas de faux espoir.

```
// ponytail: iceServers en variable d'env, STUN seul. L'absence de turn: est un
// choix assumé, pas un oubli — voir la conséquence ci-dessus.
```
