function safeClone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class InMemorySnapshotStore {
  constructor() {
    this.roomRecords = new Map();
    this.agentRecords = new Map();
    this.roomVersions = new Map();
    this.agentVersions = new Map();
  }

  keyRoom(tenantId, roomId) {
    return `${tenantId}:${roomId}`;
  }

  keyAgent(tenantId, roomId, actorId) {
    return `${tenantId}:${roomId}:${actorId}`;
  }

  cleanupMap(map) {
    const now = Date.now();
    for (const [key, records] of map.entries()) {
      const kept = records.filter((record) => !record.expiresAt || record.expiresAt > now);
      if (!kept.length) {
        map.delete(key);
      } else {
        map.set(key, kept);
      }
    }
  }

  cleanup() {
    this.cleanupMap(this.roomRecords);
    this.cleanupMap(this.agentRecords);
  }

  nextVersion(versionMap, key) {
    const next = (versionMap.get(key) || 0) + 1;
    versionMap.set(key, next);
    return next;
  }

  createRoomSnapshot({ tenantId, roomId, state, ttlSeconds = 3600 }) {
    this.cleanup();
    const key = this.keyRoom(tenantId, roomId);
    const version = this.nextVersion(this.roomVersions, key);
    const now = Date.now();
    const expiresAt = ttlSeconds > 0 ? now + Number(ttlSeconds) * 1000 : null;
    const record = {
      scope: "room",
      tenantId,
      roomId,
      actorId: null,
      version,
      state: safeClone(state || {}),
      createdAt: now,
      expiresAt
    };

    const list = this.roomRecords.get(key) || [];
    list.push(record);
    this.roomRecords.set(key, list);
    return safeClone(record);
  }

  createAgentSnapshot({ tenantId, roomId, actorId, state, ttlSeconds = 3600 }) {
    this.cleanup();
    const key = this.keyAgent(tenantId, roomId, actorId);
    const version = this.nextVersion(this.agentVersions, key);
    const now = Date.now();
    const expiresAt = ttlSeconds > 0 ? now + Number(ttlSeconds) * 1000 : null;
    const record = {
      scope: "agent",
      tenantId,
      roomId,
      actorId,
      version,
      state: safeClone(state || {}),
      createdAt: now,
      expiresAt
    };

    const list = this.agentRecords.get(key) || [];
    list.push(record);
    this.agentRecords.set(key, list);
    return safeClone(record);
  }

  findRoom({ tenantId, roomId, version }) {
    this.cleanup();
    const key = this.keyRoom(tenantId, roomId);
    const list = this.roomRecords.get(key) || [];
    if (!list.length) {
      return null;
    }
    if (version == null) {
      return safeClone(list[list.length - 1]);
    }
    return safeClone(list.find((item) => item.version === Number(version)) || null);
  }

  findAgent({ tenantId, roomId, actorId, version }) {
    this.cleanup();
    const key = this.keyAgent(tenantId, roomId, actorId);
    const list = this.agentRecords.get(key) || [];
    if (!list.length) {
      return null;
    }
    if (version == null) {
      return safeClone(list[list.length - 1]);
    }
    return safeClone(list.find((item) => item.version === Number(version)) || null);
  }
}
