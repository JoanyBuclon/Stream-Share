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

Approche la plus lazy : **une seule page + le code dans le hash d'URL**.

- `/` — page d'accueil : boutons **« Lancer un partage »** et **« Rejoindre »**.
- L'host qui lance obtient un code → l'URL devient `/#7K2-QP9`, partageable telle
  quelle.
- Un ami ouvre `/#7K2-QP9` → le script lit le hash et tente le `join`
  automatiquement (le code est normalisé avant envoi, cf. [`rooms-and-codes.md`](./rooms-and-codes.md)).

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
│   └── index.astro       # markup statique + <script> qui monte l'app
└── lib/
    ├── app.ts            # état de l'UI (idle | hosting | viewing) + rendu DOM
    ├── signaling.ts      # client ws + protocole (cf. signaling-server.md)
    └── peer.ts           # wrapper RTCPeerConnection (offer/answer/ICE, senders)
```

`signaling.ts` et `peer.ts` isolent les deux protocoles ; `app.ts` fait l'UI et le
câblage (met à jour le DOM sur les événements : viewer qui rejoint/part, stats,
changements d'état). La réactivité ici est **modérée** → un objet d'état + une
petite fonction de rendu suffisent.

```
// ponytail: vanilla + modules TS, zéro dépendance framework. Introduire Svelte
// seulement si jongler l'état à la main devient réellement pénible.
```

## UI de la page de stream

| Zone            | Host                                                    | Viewer                           |
| --------------- | ------------------------------------------------------- | -------------------------------- |
| Vidéo           | Aperçu local du partage                                 | `<video>` du flux reçu           |
| Contrôles média | Source (écran/app), qualité/bitrate, mode contenu, stop | Volume (local), plein écran      |
| Infos salon     | Code + lien à copier, liste des viewers                 | Statut de connexion              |
| Stats (option)  | Bitrate/fps par viewer via `getStats`                   | Latence / bitrate via `getStats` |

Le détail des contrôles (quels réglages, comment ils agissent) est dans
[`webrtc-media.md`](./webrtc-media.md#contrôles).

## Gotcha CSP

Le WebSocket vers le signaling **doit être autorisé par la CSP**. La CSP du
Portfolio (`default-src 'self'`) **bloquerait** la connexion `wss`. À ajuster
côté déploiement :

```
connect-src 'self';   # wss same-origin (/ws) passe avec 'self' ; sinon lister l'origine
```

Voir [`deployment.md`](./deployment.md) pour les en-têtes complets.
