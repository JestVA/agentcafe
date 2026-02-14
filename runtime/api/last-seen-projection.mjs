function toIso(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function includeActor(actorId, includeSystemActors) {
  if (!actorId) {
    return false;
  }
  if (includeSystemActors) {
    return true;
  }
  return actorId !== "system";
}

export function projectLastSeen(events, { actorId = null, limit = 100, includeSystemActors = false } = {}) {
  const max = Math.max(1, Math.min(Number(limit) || 100, 1000));
  const out = [];
  const seen = new Set();

  for (const event of Array.isArray(events) ? events : []) {
    if (!includeActor(event?.actorId, includeSystemActors)) {
      continue;
    }
    if (actorId && event.actorId !== actorId) {
      continue;
    }
    if (seen.has(event.actorId)) {
      continue;
    }
    seen.add(event.actorId);
    out.push({
      actorId: event.actorId,
      lastSeen: toIso(event.timestamp),
      lastEventId: event.eventId || null,
      lastEventType: event.type || null,
      lastSequence: Number(event.sequence || 0)
    });
    if (actorId || out.length >= max) {
      break;
    }
  }

  return out;
}
