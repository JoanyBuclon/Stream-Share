# Frontend

Astro en **SSG pur** (aucun SSR) + **un `<script>` client** (TypeScript vanilla,
aucun framework) qui porte toute l'interactivité. Le front ne connaît aucun état
serveur : il parle au signaling en WebSocket et fait le WebRTC lui-même. Résultat :
déploiement statique nginx identique au Portfolio.

## Pourquoi statique

Tout ce qui compte se passe côté client : `getDisplayMedia`, `RTCPeerConnection`,
la socket vers le signaling. L'état des salons vit dans le serveur de signaling,
pas dans Astro. Donc **aucune raison de faire du SSR** — on garde le build
statique le plus léger possible.

## Pages & routage

Approche la plus lazy : **une seule page + le code dans le hash d'URL**. Deux
chemins d'entrée distincts :

- **`/` sans hash** → **landing** : boutons **« Lancer un partage »** et
  **« Rejoindre »**. Le champ de join accepte **un code** seul (tolérant
  tirets/espaces/casse, normalisé avant envoi — cf. [`rooms-and-codes.md`](./rooms-and-codes.md)).
  Pas de collage d'URL : un lien reçu se **clique**.
- L'host qui lance obtient un code → l'URL devient `/#7K2-QP9`. Il partage le
  **lien** (bouton « copier le lien »), pas juste le code.
- **`/#7K2-QP9`** (lien ouvert) → on **saute la landing** → **écran de join minimal** :
  champ **pseudo** + « Rejoindre », puis connexion. Ce geste utilisateur débloque
  aussi l'audio (contrainte autoplay du navigateur).

**Pourquoi le hash** (`#7K2-QP9`) plutôt qu'un query param : le fragment n'est
**jamais envoyé au serveur** (ni dans les logs nginx, ni dans le `Referer`) — le
code reste entre l'host et ses amis, ce qui colle au principe « pas d'énumération ».

```
// ponytail: une page, un script, routage par window.location.hash.
// Ajouter une vraie route /room seulement si on veut des URLs plus propres.
```

## Le script client

Pas de framework. Une page `.astro` avec un `<script>` qui importe le câblage.
Toute la logique protocolaire vit dans des modules TS agnostiques :

```
src/
├── pages/
│   └── index.astro       # markup statique (4 écrans) + <script> qui monte l'app
├── components/           # les 4 écrans .astro (Home / Join / Host / Viewer)
└── lib/
    ├── app.ts            # orchestrateur : routage par hash (#CODE), bascule d'écran
    │                     #   (états 'home' | 'join' | 'host' | 'viewer'), une Signaling
    │                     #   par session, passe la main aux contrôleurs
    ├── host.ts           # contrôleur host : capture, qualité, sidebar viewers, modale, pause
    ├── viewer.ts         # contrôleur viewer : lecture, contrôles locaux, overlay stats
    ├── viewer-state.ts   # DOMAINE PUR : machine à états du viewer (reduce(session, event))
    ├── roster.ts         # DOMAINE PUR : reconcileRoster (diff des viewers après reclaim)
    ├── signaling.ts      # client ws + protocole (cf. signaling-server.md)
    ├── peer.ts           # wrapper RTCPeerConnection (offer/answer/ICE, senders)
    ├── settings.ts       # logique pure qualité (presets, tiers, scale, upload estimé)
    ├── audio.ts          # AudioMixer (système + micro, WebAudio 48 kHz)
    ├── stats.ts          # parsing pur de getStats → métriques viewer
    ├── code.ts           # génération/validation des codes (miroir de rooms.js)
    └── dom.ts · serial.ts · wakelock.ts   # helpers (el/hook, sérialisation, wake lock)
```

`signaling.ts` et `peer.ts` isolent les deux protocoles. `app.ts` **orchestre**
(route, bascule d'écran) et délègue tout le rendu et le câblage événementiel aux
**contrôleurs** `host.ts` / `viewer.ts` (mise à jour du DOM sur les événements :
viewer qui rejoint/part, stats, changements d'état). La décision d'état du viewer
est extraite en **domaine pur** (`viewer-state.ts`) : le contrôleur `dispatch(event)`
puis `render()`, testable sans DOM.

**Callbacks à brancher pour les états transverses (voir plus bas) :**

- `signaling.onMessage(msg)` — messages serveur (peer-joined, signal, peer-left,
  reclaimed…). `signaling.onStatus(s)` — `open | reconnecting | closed` → alimente
  l'overlay « reconnexion… » / l'état « déconnecté ».
- `peer.onTrack(stream)` (flux reçu) · `peer.onIceState(s)` — `disconnected` →
  « reconnexion… », `failed` → « connexion impossible ». (Le wrapper n'expose que
  l'état ICE de transport : pas de callback d'état de connexion global.)
- Au reconnect du socket : un **viewer** re-`join`, un **host** appelle
  `reclaim(code, hostToken)` (le `hostToken` reçu dans `created` est conservé
  **en mémoire** — un rechargement de page le perd et empêche le reclaim).

```
// ponytail: vanilla + modules TS, zéro dépendance framework. Introduire Svelte
// seulement si jongler l'état à la main devient réellement pénible.
```

## UI de la page de stream

**Host**

- Vidéo : aperçu local (ou placeholder « en pause »).
- Source : bouton natif « choisir la source » → nom réel (`track.label`) + aperçu.
- Qualité : **presets** (Gaming / Bureautique / Ciné) au-dessus des réglages
  résolution / FPS (`10/30/60/120`) / bitrate.
- Audio : toggles **son système** + **micro**.
- Session : **copier le lien**, **liste des viewers** (avatar + pseudo + état « connected »)
  avec **kick / ban** par ligne, **pause**, **stop** (coupe la source, garde le salon),
  estimation d'upload.

**Viewer**

- Vidéo : `<video>` du flux (placeholder « en pause » — host en pause **ou** aucune
  source active / écran « host a arrêté » — réservé au départ de l'host).
- Qualité : paliers **`Auto · Source · 1440p · 1080p · 720p · 480p`** (dynamiques,
  plafonnés au flux host — les paliers au-dessus n'apparaissent pas).
- Audio : **volume** + **mute**.
- Vue : **picture-in-picture**, **plein écran**, **quitter**.
- Stats : latency / fps / bitrate / packet loss + état de connexion (`getStats`).

Le détail des contrôles (quels réglages, comment ils agissent) est dans
[`webrtc-media.md`](./webrtc-media.md#contrôles).

## États transverses

- **Reconnexion…** : overlay court pendant un blip réseau (ICE restart + réouverture
  du socket, cf. [`signaling-server.md`](./signaling-server.md)).
- **Connexion impossible** : message clair quand la connexion directe échoue (NAT
  symétriques, pas de TURN).
- **Wake lock** : côté host **et** viewer, pour empêcher la mise en veille pendant
  une session (aucune UI, comportement de fond). `navigator.wakeLock` sur le web ;
  dans l'app desktop, le `powerSaveBlocker` de la coquille, qui lui survit à une
  fenêtre masquée (cf. [`desktop.md`](./desktop.md) § Confort système).

## Gotcha CSP

Le WebSocket vers le signaling **doit être autorisé par la CSP**. La CSP du
Portfolio (`default-src 'self'`) **bloquerait** la connexion `wss`. À ajuster
côté déploiement :

```
connect-src 'self';   # wss same-origin (/ws) passe avec 'self' ; sinon lister l'origine
```

Voir [`deployment.md`](./deployment.md) pour les en-têtes complets.

## État d'implémentation (MVP)

Ce qui est **câblé et testé en réel** (host ↔ viewer direct) :

- Routage (landing / join par hash / host / viewer), **création + `reclaim`** host,
  re-join viewer, **kick / ban**, **couper la source** (salon maintenu).
- Host : capture `getDisplayMedia`, aperçu local, **changement de source à chaud**
  (`replaceTrack`), copier le lien, liste des viewers.
- Host — **modal Réglages** appliquée en direct : source, **presets** (Gaming /
  Office / Cinema), **résolution** (`scaleResolutionDownBy`), **FPS**
  (`applyConstraints`), **bitrate** (`maxBitrate`), **audio système + micro**
  (mix WebAudio, `settings.ts` / `audio.ts`). *(Curseur retiré : la contrainte
  `cursor` est ignorée par les navigateurs.)*
- Host — **pause / reprise** (vidéo coupée, audio maintenu ; message de contrôle
  `pause`/`resume` relayé aux viewers).
- Viewer : lecture du flux, volume/mute, plein écran, PiP, états
  live / **pause** (host en pause **ou** pas de source) / reconnexion / terminé / échec
  (avec **timeout de reconnexion**).
- Viewer — **qualité par-viewer** : paliers `Auto / …p` (dynamiques, plafonnés au
  flux host, cap annoncé par l'host) ; la demande est relayée à l'host, qui applique
  `scaleResolutionDownBy` sur **le sender de ce viewer** (`effectiveScale`).
- Viewer — **overlay stats** : toggle → polling `getStats()` (latence / fps / bitrate
  / résolution / packet loss ; parsing pur dans `stats.ts`).
- **Wake lock** host + viewer, sans UI (`wakelock.ts`). `createWakeLock()` choisit :
  `navigator.wakeLock` sur le web (ré-acquis à la visibilité, best-effort), ou le
  `powerSaveBlocker` de la coquille desktop, qui n'est pas lié au document et tient
  donc fenêtre masquée.
- Viewer — **UI auto-masquée** en lecture : la barre du haut + les contrôles
  s'estompent après 3 s d'immobilité de la souris (ou dès qu'elle quitte le stage) ;
  un mouvement les rappelle. Actif uniquement pendant le flux `live`.
- Retour à l'accueil : **sort du plein écran** ; source choisie **uniquement dans
  Réglages** (bouton de la barre retiré) ; l'entête viewer affiche **le code de room**
  (l'host n'a pas de nom).
- Police **Hanken Grotesk** auto-hébergée via l'API Fonts d'Astro (conforme CSP
  `font-src 'self'`, repli système avant chargement).

Le gros de la maquette est désormais implémenté ; reste une passe de test manuel complet.
