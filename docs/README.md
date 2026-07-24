# Stream-Share — Architecture

Partage d'écran P2P depuis un onglet de navigateur, façon partage d'écran Discord.
Un host lance un partage, obtient un **code unique**, l'envoie à ses amis. Une fois
dans le salon, le flux va **directement de l'host aux viewers** — aucun média ne
transite par le serveur.

## Principes directeurs

1. **Zéro média sur le serveur.** 100 % P2P (mesh WebRTC). Le backend ne fait que
   du signaling et tient la liste des salons.
2. **Aucune limite, aucun paywall.** La résolution / le bitrate sont ceux que
   l'host veut (4K60 si sa machine suit).
3. **Léger et rapide.** Le front est **statique** (Astro SSG), le signaling est un
   micro-process Node. Rien de superflu.
4. **Pas d'énumération de salons.** Un viewer envoie un code, reçoit juste un
   « valide / invalide ». La liste des salons ne quitte jamais le serveur.

## Cadre & décisions structurantes

- **1 host → plusieurs viewers en mesh** (typiquement 2-4). Le vrai plafond est
  **physique** — l'uplink et le GPU de l'host (cf. [`webrtc-media.md`](./webrtc-media.md)),
  le mesh ouvrant un flux encodé par viewer. Un **cap logiciel** l'accompagne
  (`MAX_VIEWERS`, défaut **10**) : au-delà, le join est refusé (`join-error: full`) — le
  mesh ne tient de toute façon pas beaucoup plus loin.
- **STUN public obligatoire** pour la traversée NAT. Il ne voit jamais de média.
- **Pas de TURN, pas de SFU — définitif.** Les deux relaieraient du flux média par
  un serveur, ce qui détruirait le principe « zéro média serveur » et l'objectif
  de légèreté. Conséquence assumée : les paires derrière deux NAT symétriques ne
  peuvent pas se connecter (cf. [`signaling-server.md`](./signaling-server.md)).
- **Pas de comptes, pas de mot de passe, pas de persistance.** Le gate d'accès est
  le code seul ; les salons sont éphémères et vivent en mémoire.

## Topologie

```
                    ┌──────────────── VPS (Docker + Traefik) ────────────────┐
                    │                                                        │
   Navigateur       │   ┌───────────────┐            ┌──────────────────┐    │
   (host / viewer)  │   │  nginx        │  /*        │  signaling (Node)│    │
      │  HTTPS ──────────▶  static Astro│            │  ws brut         │    │
      │             │   └───────────────┘            │  Map<code, Room> │    │
      │  wss /ws ───────────────────────────────────▶│  relais SDP/ICE  │    │
      │             │                                └──────────────────┘    │
      └─────────────┴────────────────────────────────────────────────────────┘
             │
             │  WebRTC (média + audio) — DIRECT, hors serveur
             ▼
      autres navigateurs (viewers)
```

Le serveur intervient **uniquement** pendant l'établissement de la connexion
(échange des offres/réponses SDP + ICE candidates). Ensuite, l'host pousse son
écran en direct vers chaque viewer, en pair à pair.

## Stack & justifications

| Brique          | Choix                                | Pourquoi                                                                                                                                                               |
| --------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Front           | Astro (SSG) + `<script>` client (TS) | Statique = même déploiement nginx que le Portfolio. Toute l'interactivité (capture, WebRTC, WS) tient dans des modules TS + un script de page. Aucun framework requis. |
| Média           | WebRTC mesh                          | P2P natif navigateur, faible latence, zéro relais média.                                                                                                               |
| Signaling       | Node + `ws` brut                     | Le signaling ne transporte que du SDP/ICE : trivial, quelques lignes. Socket.io / µWS seraient de l'over-engineering.                                                  |
| État des salons | `Map` en mémoire                     | Éphémère, un seul process, aucun besoin de base ou de Redis.                                                                                                           |
| Traversée NAT   | STUN public (obligatoire)            | Découverte de l'adresse publique pour traverser les NAT. Ne voit jamais de média. Pas de TURN.                                                                         |
| Déploiement     | Docker + Traefik                     | Réutilise l'infra existante (réseau `web`, GHCR, TLS auto).                                                                                                            |

## Composants métier (index)

- [`rooms-and-codes.md`](./rooms-and-codes.md) — cycle de vie d'un salon, génération
  des codes, store mémoire.
- [`signaling-server.md`](./signaling-server.md) — serveur `ws`, protocole de
  messages, cycle de vie des connexions, STUN (et pourquoi pas de TURN).
- [`webrtc-media.md`](./webrtc-media.md) — mesh, capture d'écran, codec, bitrate,
  audio, contrôles.
- [`frontend.md`](./frontend.md) — pages Astro, script client, UI host vs viewer.
- [`deployment.md`](./deployment.md) — Docker, Traefik, wss, CSP.
- [`desktop.md`](./desktop.md) — application desktop host (Electron) : fonctionnalités,
  archi, distribution.
