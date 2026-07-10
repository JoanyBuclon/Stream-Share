# Salons & codes

Le serveur de signaling tient l'unique source de vérité sur les salons actifs :
une `Map` en mémoire. Un salon existe tant que son host est connecté.

## Modèle

```ts
type Viewer = { id: string; pseudo: string }; // pseudo saisi au join, jamais persisté

type Room = {
  code: string; // forme canonique, 6 caractères sans tiret
  hostId: string; // id de connexion de l'host
  viewers: Map<string, Viewer>; // peerId → viewer
  banned: Set<string>; // clés de ban (IP + token client), vérifiées au join
  createdAt: number; // epoch ms — pour un TTL de sécurité
  graceUntil?: number; // si l'host s'est déconnecté : deadline de destruction (30 s)
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
function newCode(): string {
  let code: string;
  do {
    code = Array.from({ length: 6 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
  } while (rooms.has(code));
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

| Événement                    | Effet sur le store                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Host crée un salon           | `newCode()` → `rooms.set(code, { hostId, viewers: ∅, banned: ∅, createdAt })`.                                      |
| Viewer envoie code + pseudo  | Lookup `rooms.get(code)`. Absent → `join-error`. **Banni** (IP/token ∈ `banned`) → `join-error`. Sinon on ajoute `{ id, pseudo }` et on notifie l'host. |
| Host kicke un viewer         | Sa `RTCPeerConnection` se ferme, il sort de `viewers`. Si **ban** : sa clé (IP + token) entre dans `banned`.        |
| Viewer se déconnecte         | Retiré de `room.viewers` ; l'host est notifié (`peer-left`).                                                        |
| Host se déconnecte           | **Délai de grâce 30 s** : on pose `graceUntil`, le salon reste. S'il revient avant → salon intact. Sinon → destruction (viewers notifiés, code libéré). |
| TTL de sécurité              | Un balayage périodique supprime les salons trop vieux / orphelins et ceux dont le `graceUntil` est dépassé.         |

Le détail du protocole réseau qui déclenche ces transitions est dans
[`signaling-server.md`](./signaling-server.md).

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
- **Kick + ban (scoped salon)** : l'host peut éjecter un viewer, et le bannir. Comme
  le kické garde le code, le ban le tient à l'écart : la clé de ban combine son **IP**
  (vue par le serveur) et un **token localStorage** (envoyé au join). Le `Set banned`
  vit **sur la `Room`** → il meurt avec le salon. Dissuasif, pas un mur : un VPN ou un
  reset du storage contourne — acceptable pour des salons éphémères entre amis.
