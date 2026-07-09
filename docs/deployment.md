# Déploiement

Docker + Traefik sur le VPS, en réutilisant l'infra du Portfolio (réseau `web`
externe, images GHCR, TLS auto). Différence clé : Stream-Share a **deux
services** au lieu d'un — le statique **et** le signaling.

## Deux services

| Service     | Contenu                              | Image de base         | Rôle                                    |
| ----------- | ------------------------------------ | --------------------- | --------------------------------------- |
| `web`       | Build Astro (`dist/`) servi statique | `nginx:stable-alpine` | Sert le front (identique au Portfolio). |
| `signaling` | Micro-serveur `ws` Node              | `node:*-alpine`       | Registre des salons + relais SDP/ICE.   |

## Routage Traefik

Même hôte, deux routes. Traefik gère l'upgrade WebSocket tout seul.

- `PathPrefix('/ws')` → service `signaling`.
- tout le reste → service `web` (nginx).

Ainsi le WebSocket est **same-origin** (`wss://<host>/ws`) : la CSP `connect-src
'self'` suffit, un seul certificat TLS, rien à configurer côté client au-delà de
l'URL relative.

Esquisse `docker-compose.yml` (à aligner sur les labels du Portfolio) :

```yaml
services:
  web:
    image: ghcr.io/joanybuclon/stream-share-web:latest
    networks: [web]
    labels:
      - 'traefik.enable=true'
      - 'traefik.http.routers.streamshare.rule=Host(`stream.example.com`)'
      - 'traefik.http.routers.streamshare.entrypoints=websecure'
      # + middlewares headers/compress comme le Portfolio (voir CSP ci-dessous)
    restart: unless-stopped

  signaling:
    image: ghcr.io/joanybuclon/stream-share-signaling:latest
    networks: [web]
    environment:
      - ICE_SERVERS=stun:stun.l.google.com:19302 # STUN seul, par décision (pas de TURN)
    labels:
      - 'traefik.enable=true'
      - 'traefik.http.routers.streamshare-ws.rule=Host(`stream.example.com`) && PathPrefix(`/ws`)'
      - 'traefik.http.routers.streamshare-ws.entrypoints=websecure'
    restart: unless-stopped

networks:
  web:
    external: true
```

## En-têtes / CSP

Reprendre les en-têtes de sécurité du Portfolio (`framedeny`, HSTS, nosniff,
`referrerPolicy`) **mais adapter la CSP** pour le WebSocket et le média :

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

- `connect-src` : autorise la socket signaling (`wss` same-origin).
- `media-src blob:` : nécessaire pour attacher un `MediaStream` à `<video>`.
- **Ne pas** interdire `display-capture` dans `Permissions-Policy` : c'est ce qui
  permet à l'host de partager son écran. (Camera/micro peuvent rester désactivés.)

## wss & TLS

Traefik termine le TLS ; le service `signaling` écoute en HTTP/ws en interne sur
le réseau `web`. Le client se connecte en `wss://` — pas de certificat à gérer
dans le Node.

## Variables d'environnement

| Variable      | Défaut                         | Usage                                                       |
| ------------- | ------------------------------ | ----------------------------------------------------------- |
| `ICE_SERVERS` | `stun:stun.l.google.com:19302` | Liste STUN passée aux clients. Pas de TURN (choix d'archi). |
| `PORT`        | ex. `8080`                     | Port d'écoute interne du signaling.                         |

```
// ponytail: pas de secret, pas de base, pas de volume. Deux conteneurs
// stateless (le signaling perd ses salons au restart — voulu : ils sont éphémères).
```
