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

Multi-stage : stage `node:24-alpine` qui fait `pnpm build` (Astro **auto-héberge la
police Hanken Grotesk au build**, cf. `astro.config.mjs` — pas d'étape de subsetting
séparée à écrire dans le Dockerfile), puis `nginx:stable-alpine` qui sert `dist/` et
**copie aussi `nginx-security-headers.conf`** (le fichier d'en-têtes partagé, cf. § CSP).
Le `.dockerignore` exclut `signaling/`, `docs/`, etc. — le build du front n'en a pas besoin.

### Dockerfile signaling (`signaling/Dockerfile`)

Pas de nginx : un process Node qui tourne en continu. `pnpm install --prod`,
`EXPOSE 8080`, **`USER node`** (non-root — le runtime ne fait que lire ses fichiers et
bind 8080), puis `node src/index.js`. Le `.dockerignore` du dossier écarte les tests et
le client de test (`public/test.html`) — inutiles en prod (la route `/` part vers le
`web`, seul `/ws` atteint ce service).

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
      - TRUST_PROXY=1 # ne lire X-Forwarded-For que derrière Traefik (port non exposé hors réseau interne)
      - ALLOWED_ORIGINS=https://stream.joanybuclon.com # allow-list Origin (anti-CSWSH)
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

Repris du Portfolio, adapté à nos deux packages. Déclencheurs : `push` **et**
`pull_request` sur `master` (une PR passe `quality` sans jamais publier). Actions
**épinglées par SHA**. Deux jobs :

1. **`quality`** — filet avant toute publication :
   - `pnpm install --frozen-lockfile` (web **et** `signaling`).
   - `pnpm audit --audit-level=high` sur les deux (bloque sur CVE haute/critique).
   - `typecheck` (`astro check` sur les modules TS du front).
   - `lint` (`eslint .` — couvre aussi le JS du signaling depuis la config racine).
   - **Tests unitaires** : `pnpm test` (lib client, `node --test "src/lib/*.test.ts"`)
     **et** `pnpm --ignore-workspace --dir signaling test` (six suites : `rooms`,
     `smoke`, `grace`, `ban`, `guards`, `authz`). `--ignore-workspace` est requis,
     sinon le workspace racine capte le dossier et la commande no-op silencieusement.
   - **E2E** : `pnpm e2e` (Playwright, projets `chromium` + `mobile`) — le vrai chemin
     WebRTC host↔viewer en headless.
2. **`publish`** (dépend de `quality`, **uniquement sur `push`** — gaté par
   `if: github.event_name == 'push'`) — **matrice deux images** (`web`, `signaling`) :
   login GHCR, `metadata-action` (tags `latest` + `sha-<court>`), build & push Buildx
   avec cache `gha` **scoped par image**.

Rien ne se publie si un test, le lint ou le typecheck échoue.

> L'infra est **agnostique au front** : l'image `web` embarque le `dist/` d'Astro
> quel qu'en soit le contenu — faire évoluer l'UI ne demande aucun changement d'infra.

## En-têtes / CSP (`nginx-security-headers.conf`)

`framedeny`, HSTS, nosniff, `referrerPolicy` viennent de **Traefik** ; le cache
immutable (`/_astro/`) est dans `nginx.conf`. La **CSP + Permissions-Policy** vivent
dans un fichier partagé **`nginx-security-headers.conf`**, `include`d dans les **deux**
`location` (`/` et `/_astro/`) — car `add_header` de nginx **remplace** (n'hérite pas)
dès qu'une `location` déclare le sien, donc les en-têtes doivent être re-déclarés
partout. La CSP est adaptée pour le WebSocket et le média :

```
Content-Security-Policy:
  default-src 'self';
  connect-src 'self';                 # wss same-origin /ws — sinon lister l'origine ws
  media-src 'self' blob:;             # flux MediaStream dans <video>
  script-src 'self' 'unsafe-inline';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data:;
  font-src 'self';                    # police Hanken Grotesk auto-hébergée
  object-src 'none';
  frame-ancestors 'none';
  base-uri 'self';
  form-action 'self';
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
| `ICE_SERVERS`     | `stun:stun.l.google.com:19302` | Liste STUN passée aux clients. Pas de TURN (choix d'archi).            |
| `PORT`            | `8080`                         | Port d'écoute interne du signaling.                                    |
| `GRACE_MS`        | `30000`                        | Délai de grâce avant destruction d'un salon (reclaim host).           |
| `TRUST_PROXY`     | _(off)_                        | `=1` → lire `X-Forwarded-For` (dernier hop). **Uniquement derrière le proxy.** |
| `ALLOWED_ORIGINS` | _(vide)_                       | Allow-list d'`Origin` (anti-CSWSH). Vide = pas de contrôle (dev).     |
| `MAX_VIEWERS`     | `10`                           | Plafond de viewers par salon (au-delà → `join-error: full`).          |

```
// ponytail: pas de secret, pas de base, pas de volume. Deux conteneurs
// stateless (le signaling perd ses salons au restart — voulu : ils sont éphémères).
```
