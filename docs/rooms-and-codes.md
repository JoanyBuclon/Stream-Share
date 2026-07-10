# Salons & codes

Le serveur de signaling tient l'unique source de vérité sur les salons actifs :
une `Map` en mémoire. Un salon existe tant que son host est connecté (avec un
**délai de grâce** s'il se déconnecte, cf. cycle de vie).

## Modèle

```ts
type Viewer = { id: string; pseudo: string }; // pseudo saisi au join, jamais persisté

type Room = {
  code: string; // forme canonique, 6 caractères sans tiret
  hostId: string; // id de connexion (peerId) de l'host
  hostToken: string; // secret (UUID) pour reprendre la main (reclaim) après une coupure
  viewers: Map<string, Viewer>; // peerId → viewer
  bannedIps: Set<string>; // IPs bannies (cf. ban plus bas)
  bannedTokens: Set<string>; // tokens localStorage bannis
  createdAt: number; // epoch ms
  graceTimer: Timeout | null; // armé à la déconnexion de l'host ; null tant qu'il est présent
};

const rooms = new Map<string, Room>(); // clé = code canonique (sans tiret)
```

Une `Map` suffit : un seul process, salons éphémères, pas de persistance voulue.
Pas de base de données, pas de Redis.

- **Alphabet Crockford base32** (`0-9A-Z` sans `I L O U`) → pas de confusion
  visuelle `0/O`, `1/I`, et pas de mot involontaire.
- **Longueur 6** → ~1 milliard de combinaisons. Largement assez pour des salons
  éphémères ; le brute-force de `join` est fermé par le rate-limit (voir plus bas).
- **Tiret cosmétique au milieu** : affiché `XXX-XXX` (ex. `7K2-QP9`) pour aider à
  lire et dicter. Le tiret **n'est pas stocké** : la clé de la `Map` reste la forme
  canonique 6 caractères. À la saisie, on normalise (retrait du tiret, majuscules)
  avant le lookup — l'utilisateur peut taper avec ou sans tiret, en minuscules.
- **Anti-collision** : régénérer tant que le code existe déjà dans la `Map`
  (probabilité quasi nulle, mais la boucle est gratuite).

```ts
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford, sans I L O U

// Génération : clé canonique 6 caractères, sans tiret.
function newCode(existing): string {
  let code: string;
  do {
    code = Array.from({ length: 6 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
  } while (existing.has(code));
  return code;
}

// Affichage : tiret au milieu → "7K2QP9" devient "7K2-QP9".
const format = (code: string) => `${code.slice(0, 3)}-${code.slice(3)}`;

// Saisie (join) : normaliser avant lookup — tiret et casse sont cosmétiques.
const normalize = (input: string) => input.toUpperCase().replace(/[^0-9A-Z]/g, '');

// ponytail: Math.random suffit pour un code éphémère non-secret ; l'anti-abus
// repose sur le rate-limit, pas sur l'imprévisibilité du RNG.
```

## Cycle de vie

| Événement                    | Effet sur le store                                                                                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host crée un salon           | `newCode()` + `hostToken` (UUID) → `rooms.set(code, { hostId, hostToken, viewers: ∅, bannedIps: ∅, bannedTokens: ∅, graceTimer: null })`.                                                           |
| Viewer envoie code + pseudo  | Lookup `rooms.get(code)`. Absent → `join-error`. **Banni** (`isBanned`) → `join-error`. Sinon on ajoute `{ id, pseudo }` et on notifie l'host.                                                      |
| Host kicke un viewer         | Sa `RTCPeerConnection` se ferme, il sort de `viewers`. Si **ban** : son IP → `bannedIps`, son token → `bannedTokens`.                                                                               |
| Viewer se déconnecte         | Retiré de `room.viewers` ; l'host est notifié (`peer-left`).                                                                                                                                        |
| Host se déconnecte           | **Délai de grâce 30 s** : on arme `graceTimer`, le salon reste, les viewers **ne sont pas** notifiés. Expiration → destruction (viewers notifiés `peer-left { reason: 'host-left' }`, code libéré). |
| Host se reconnecte (reclaim) | Dans la fenêtre de grâce, `reclaim { code, hostToken }` : on annule `graceTimer`, le host **reprend son ancien `hostId`** (continuité du routage `signal`) et récupère la liste des viewers.        |

Le détail du protocole réseau qui déclenche ces transitions est dans
[`signaling-server.md`](./signaling-server.md).

> **Pas de balayage TTL périodique.** La destruction d'un salon passe uniquement
> par le `graceTimer` (host absent) ou une fermeture explicite. Un salon dont
> l'host reste connecté vit tant qu'il est là — voulu.

## Sécurité & abus

- **Pas d'énumération** : le client ne peut que _tester_ un code, jamais lister
  les salons. La `Map` reste côté serveur.
- **Validation opaque** : un code inexistant renvoie juste `join-error`, sans
  distinguer « jamais existé » de « salon fermé ».
- **Rate-limit sur `create`** : plafonner le nombre de salons créés par IP /
  connexion pour éviter qu'on épuise l'espace de codes ou la mémoire.
  ```
  // ponytail: compteur en mémoire par IP + fenêtre glissante. Pas de lib.
  ```
- **Codes éphémères** : ils meurent avec l'host (après le délai de grâce), donc la
  surface d'attaque reste minuscule.
- **Reclaim protégé** : `hostToken` est un UUID (122 bits), non devinable — inutile
  d'ajouter un rate-limit sur `reclaim`. Le reclaim n'est possible que sur un salon
  **en grâce** (host absent), jamais pour voler un salon actif.
- **Kick + ban (scoped salon)** : l'host peut éjecter un viewer, et le bannir.
  ```ts
  // Banni si l'IP OU le token correspond.
  function isBanned(room, ip, token) {
    return room.bannedIps.has(ip) || (!!token && room.bannedTokens.has(token));
  }
  ```
  Le ban combine deux signaux, en **OU** : l'**IP** (vue par le serveur) attrape
  celui qui change de token ; le **token localStorage** (envoyé au join) attrape
  celui qui change d'IP sans vider son storage — utile en mobile/CGNAT où le ban IP
  est faible. Le token seul n'est **pas** une condition fiable (il est contrôlé par
  le client), d'où le OU et non un AND. Les deux `Set` vivent **sur la `Room`** → ils
  meurent avec le salon. Dissuasif, pas un mur : changer **à la fois** d'IP et de
  storage contourne — acceptable pour des salons éphémères entre amis.
