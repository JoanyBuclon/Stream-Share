// Host roster reconciliation — pure. After a reclaim the server sends its truth (who is in the room);
// diff it against what the host currently tracks to decide who to add (joined during the outage) and
// who to drop (left during it). Kept DOM-free so the set logic is unit-tested without a controller.

import type { RoomViewer } from './signaling.ts'; // the server's roster shape { peerId, pseudo }

export function reconcileRoster(
  current: Iterable<string>,
  incoming: readonly RoomViewer[],
): { toRemove: string[]; toAdd: RoomViewer[] } {
  const currentIds = new Set(current);
  const present = new Set(incoming.map((m) => m.peerId));
  return {
    toRemove: [...currentIds].filter((id) => !present.has(id)),
    toAdd: incoming.filter((m) => !currentIds.has(m.peerId)),
  };
}
