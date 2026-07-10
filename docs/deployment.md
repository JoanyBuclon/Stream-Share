# Déploiement

Docker + Traefik sur le VPS, en réutilisant l'infra du Portfolio (réseau `web`
externe, images GHCR, TLS auto). Différence clé : Stream-Share a **deux
services** au lieu d'un — le statique **et** le signaling. Domaine :
`stream.joanybuclon.com`.

## Deux services, deux images

| Service     | Contenu                              | Image de base         | Rôle                                    |
| ----------- | ------------------------------------ | --------------------- | --------------------------------------- |
| `web`       | Build Astro (`dist/`) servi statique | `nginx:stable-alpine` | Sert le front (identique au Portfolio). |
| `signaling` | Micro-serveur `ws` Node long-running | `node:24-alpine`      | Registre des salons + relais SDP/ICE.   |

Deux images GHCR distinctes : `ghcr.io/joanybuclon/stream-share-web` et
`stream-share-signaling`.

### Dockerfile web (`Dockerfile`)

Multi-stage repris du Portfolio, **sans le sous-setting de polices** (pas de
police custom ici) : stage `node:24-alpine` qui fait `pnpm build`, puis
`nginx:stable-alpine` qui sert `dist/`. Le `.dockerignore` exclut `signaling/`,
`docs/`, etc. — le build du front n'en a pas besoin.

### Dockerfile signaling (`signaling/Dockerfile`)

Pas de nginx : un process Node qui tourne en continu. `pnpm install --prod` puis
`node src/index.js`, `EXPOSE 8080`. Le `.dockerignore` du dossier écarte les
tests et le client de test (`public/test.html`) — inutiles en prod (la route `/`
part vers le `web`, seul `/ws` atteint ce service).

## Routage Traefik

Même hôte, deux routes. Traefik gère l'upgrade WebSocket tout seul.

- `Host + PathPrefix('/ws')` → service `signaling`. La règle étant **plus longue**
  que celle du `web`, Traefik lui donne automatiquement une priorité supérieure —
  pas de priorité à régler à la main.
- tout le reste → service `web` (nginx).

Ainsi le WebSocket est **same-origin** (`wss://stream.joanybuclon.com/ws`) : la CSP
`connect-src 'self'` suffit, un seul certificat TLS, rien à configurer côté client
au-delà de l'URL relative.

`docker-compose.yml` (aligné sur les labels du Portfolio) :

```yaml
services:
  web:
    image: ghcr.io/joanybuclon/stream-share-web:latest
    networks: [web]
    labels:
      - 'traefik.enable=true'
      - 'traefik.http.routers.streamshare.rule=Host(`stream.joanybuclon.com`)'
      - 'traefik.http.routers.streamshare.entrypoints=websecure'
      # + middlewares headers/compress comme le Portfolio (framedeny, HSTS, nosniff, referrer)
    restart: unless-stopped

  signaling:
    image: ghcr.io/joanybuclon/stream-share-signaling:latest
    networks: [web]
    environment:
      - ICE_SERVERS=stun:stun.l.google.com:19302 # STUN seul, par décision (pas de TURN)
    labels:
      - 'traefik.enable=true'
      - 'traefik.http.routers.streamshare-ws.rule=Host(`stream.joanybuclon.com`) && PathPrefix(`/ws`)'
      - 'traefik.http.routers.streamshare-ws.entrypoints=websecure'
      - 'traefik.http.services.streamshare-ws.loadbalancer.server.port=8080'
    restart: unless-stopped

networks:
  web:
    external: true
```

## Intégration continue (`.github/workflows/docker-publish.yml`)

Repris du Portfolio, adapté à nos deux packages. Déclencheur : `push` sur
`master`. Actions **épinglées par SHA**. Deux jobs :

1. **`quality`** — filet avant toute publication :
   - `pnpm install --frozen-lockfile` (web **et** `signaling`).
   - `pnpm audit --audit-level=high` sur les deux (bloque sur CVE haute/critique).
   - `typecheck` (`astro check` sur les modules TS du front).
   - `lint` (`eslint .` — couvre aussi le JS du signaling depuis la config racine).
   - **Tests** : `pnpm test` (lib client, `node --test`) **et** `pnpm --dir signaling
     test` (suites `rooms` / `smoke` / `grace` / `ban`).
2. **`publish`** (dépend de `quality`) — **matrice deux images** (`web`,
   `signaling`) : login GHCR, `metadata-action` (tags `latest` + `sha-<court>`),
   build & push Buildx avec cache `gha` **scoped par image**.

Rien ne se publie si un test, le lint ou le typecheck échoue.

> Le front est encore un **placeholder** Astro. L'image `web` l'embarque tel quel ;
> quand la vraie UI arrivera, aucun travail d'infra ne sera à refaire — seul le
> contenu de `src/` change.

## En-têtes / CSP (`nginx.conf`)

Reprend les en-têtes de sécurité du Portfolio (`framedeny`, HSTS, nosniff,
`referrerPolicy` côté Traefik ; cache immutable + CSP côté nginx) **mais adapte la
CSP** pour le WebSocket et le média :

```
Content-Security-Policy:
  default-src 'self';
  connect-src 'self';                 # wss same-origin /ws — sinon lister l'origine ws
  media-src 'self' blob:;             # flux MediaStream dans <video>
  script-src 'self' 'unsafe-inline';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data:;
  object-src 'none';
  frame-ancestors 'none';
  base-uri 'self';
```

- `connect-src 'self'` : autorise la socket signaling (`wss` same-origin).
- `media-src blob:` : nécessaire pour attacher un `MediaStream` à `<video>`.
- `Permissions-Policy: camera=(), microphone=(self), geolocation=(), payment=()` —
  **`microphone=(self)`** garde le micro host optionnel possible ; on **ne liste
  pas** `display-capture` (défaut `self`), sinon on couperait le partage d'écran.

## wss & TLS

Traefik termine le TLS ; le service `signaling` écoute en HTTP/ws en interne sur
le réseau `web` (port 8080). Le client se connecte en `wss://` — pas de certificat
à gérer dans le Node.

## Variables d'environnement

| Variable      | Défaut                         | Usage                                                       |
| ------------- | ------------------------------ | ----------------------------------------------------------- |
| `ICE_SERVERS` | `stun:stun.l.google.com:19302` | Liste STUN passée aux clients. Pas de TURN (choix d'archi). |
| `PORT`        | `8080`                         | Port d'écoute interne du signaling.                         |
| `GRACE_MS`    | `30000`                        | Délai de grâce avant destruction d'un salon (reclaim host). |

```
// ponytail: pas de secret, pas de base, pas de volume. Deux conteneurs
// stateless (le signaling perd ses salons au restart — voulu : ils sont éphémères).
```
