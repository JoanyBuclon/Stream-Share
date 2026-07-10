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
connexion et ne route que par salon.

### Client → serveur

| `type`   | Payload                  | Effet                                                                                                        |
| -------- | ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `create` | —                        | Crée un salon, renvoie `created { code }`. L'émetteur devient host.                                          |
| `join`   | `{ code, pseudo, token }`| Valide code **+ ban** (IP/token). OK → `joined` à l'émetteur + `peer-joined { peerId, pseudo }` à l'host. KO/banni → `join-error`. |
| `signal` | `{ to, data }`           | Relaie `data` (SDP offer/answer ou ICE candidate) au pair `to`. Sert aussi à l'ICE restart.                 |
| `kick`   | `{ peerId }`             | **(host)** éjecte un viewer → `kicked` au viewer + fermeture de sa connexion.                                |
| `ban`    | `{ peerId }`             | **(host)** éjecte **et** bannit (IP + token) pour la durée du salon.                                         |
| `leave`  | —                        | Quitte le salon proprement (équivalent à une déconnexion).                                                   |

### Serveur → client

| `type`        | Payload              | Sens                                                                  |
| ------------- | -------------------- | --------------------------------------------------------------------- |
| `created`     | `{ code }`           | Confirme la création, donne le code à partager.                       |
| `joined`      | `{ hostId }`         | Le viewer est entré ; voici l'id de l'host à contacter.               |
| `join-error`  | `{ reason }`         | Code inconnu / salon fermé / banni (message opaque).                  |
| `peer-joined` | `{ peerId, pseudo }` | Notifie l'host qu'un viewer est arrivé → l'host initie l'offre.       |
| `signal`      | `{ from, data }`     | Transporte le SDP/ICE d'un pair vers l'autre.                         |
| `kicked`      | `{ banned }`         | Le viewer est éjecté (`banned:true` s'il est aussi banni) → écran de fin. |
| `peer-left`   | `{ peerId }`         | Un pair a quitté → fermer la `RTCPeerConnection` associée.            |

Le serveur **ne comprend pas** le contenu de `data` : il le recopie tel quel du
pair source vers le pair cible. C'est ce qui garantit qu'il reste hors du média.

## Cycle de vie d'une connexion

```
Host                     Serveur (ws)                 Viewer
 │── create ─────────────▶│
 │◀──────── created{code} │
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

Nettoyage : à la fermeture d'une socket, on applique les règles de cycle de vie
des salons — viewer retiré, ou, si c'était l'host, **délai de grâce de 30 s** avant
destruction (cf. [`rooms-and-codes.md`](./rooms-and-codes.md)).

## Reconnexion (blip réseau)

Deux niveaux, tous deux **minimaux** (on ne vise pas une reprise de session
complexe) :

- **Socket signaling** : si le WebSocket tombe, le client le **rouvre** et re-`join`
  le même salon (avec le même `token`, donc l'host le retrouve). C'est ce qui permet
  d'échanger les candidats d'un ICE restart.
- **Média** : sur coupure ICE courte (`iceConnectionState` → `disconnected`/`failed`),
  le pair appelle `restartIce()` et les nouveaux candidats repassent par `signal` —
  la `RTCPeerConnection` n'est **pas** détruite. Si ça ne repart pas, on tombe sur le
  message d'échec (pas de TURN).

```
// ponytail: reconnexion = rouvrir le socket + restartIce. Pas de file d'attente
// de messages, pas de resync d'état — le join est idempotent côté serveur.
```

## STUN (et pourquoi pas de TURN)

- **STUN, obligatoire.** Les clients reçoivent une liste `iceServers` (ex.
  `stun:stun.l.google.com:19302`) dans leur `RTCPeerConnection`. Le STUN sert
  uniquement à **découvrir l'adresse publique** de chaque pair ; il ne voit jamais
  de média. C'est ce qui permet la connexion directe à travers la plupart des NAT.
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
