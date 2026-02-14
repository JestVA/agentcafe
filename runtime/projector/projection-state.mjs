export class ProjectionState {
  constructor() {
    this.rooms = new Map();
  }

  roomKey(tenantId, roomId) {
    return `${tenantId}:${roomId}`;
  }

  ensureRoom(tenantId, roomId) {
    const key = this.roomKey(tenantId, roomId);
    let state = this.rooms.get(key);
    if (!state) {
      state = {
        tenantId,
        roomId,
        actors: new Map(),
        pinnedContext: null,
        chat: [],
        localMemory: [],
        messages: [],
        threads: new Map(),
        orders: [],
        lastEventAt: null,
        lastEventId: null
      };
      this.rooms.set(key, state);
    }
    return state;
  }

  apply(event) {
    const room = this.ensureRoom(event.tenantId, event.roomId);
    const actorId = event.actorId;
    const actor = room.actors.get(actorId) || {
      actorId,
      status: "idle",
      x: 0,
      y: 0,
      lastSeen: null,
      lastOrder: null
    };

    actor.lastSeen = event.timestamp;

    if (event.type === "agent_entered") {
      actor.status = "busy";
    } else if (event.type === "agent_left") {
      room.actors.delete(actorId);
    } else if (event.type === "actor_moved") {
      actor.status = "busy";
      actor.lastMove = {
        direction: event.payload.direction,
        steps: event.payload.steps
      };
    } else if (event.type === "presence_heartbeat") {
      actor.status = event.payload?.status || actor.status;
      actor.presence = {
        lastHeartbeatAt: event.payload?.lastHeartbeatAt || event.timestamp,
        ttlMs: Number(event.payload?.ttlMs || 0),
        expiresAt: event.payload?.expiresAt || null,
        isActive: true
      };
    } else if (event.type === "bubble_posted" || event.type === "conversation_message_posted") {
      actor.status = "thinking";
      const conversation = event.payload?.conversation || null;
      const text = conversation?.text || event.payload?.bubble?.text || event.payload?.text || "";
      const messageId = conversation?.messageId || event.eventId;
      const threadId = conversation?.threadId || conversation?.parentMessageId || messageId;
      const parentMessageId = conversation?.parentMessageId || null;
      const message = {
        messageId,
        threadId,
        parentMessageId,
        actorId,
        text,
        mentions: Array.isArray(conversation?.mentions) ? conversation.mentions : [],
        contextWindow: conversation?.contextWindow || null,
        eventId: event.eventId,
        sequence: event.sequence,
        ts: event.timestamp
      };
      room.chat.unshift({
        actorId,
        text,
        ts: event.timestamp,
        eventId: event.eventId
      });
      room.chat.length = Math.min(100, room.chat.length);

      room.messages.unshift(message);
      room.messages.length = Math.min(200, room.messages.length);

      const existingThread = room.threads.get(threadId) || {
        threadId,
        rootMessageId: parentMessageId || messageId,
        messageIds: [],
        participants: new Set(),
        messageCount: 0,
        lastMessageAt: null,
        lastEventId: null
      };

      existingThread.messageIds.push(messageId);
      existingThread.participants.add(actorId);
      existingThread.messageCount += 1;
      existingThread.lastMessageAt = event.timestamp;
      existingThread.lastEventId = event.eventId;
      room.threads.set(threadId, existingThread);
    } else if (event.type === "order_changed") {
      actor.status = "busy";
      actor.lastOrder = {
        itemId: event.payload.itemId,
        size: event.payload.size,
        ts: event.timestamp
      };
      room.orders.unshift({
        actorId,
        itemId: event.payload.itemId,
        size: event.payload.size,
        ts: event.timestamp,
        eventId: event.eventId
      });
      room.orders.length = Math.min(50, room.orders.length);
    } else if (event.type === "intent_completed") {
      actor.status = "idle";
      if (event.payload?.finalPosition) {
        actor.x = Number(event.payload.finalPosition.x) || actor.x;
        actor.y = Number(event.payload.finalPosition.y) || actor.y;
      }
    } else if (event.type === "status_changed") {
      actor.status = event.payload?.to || actor.status;
      actor.presence = {
        ...(actor.presence || {}),
        isActive: event.payload?.to !== "inactive"
      };
    } else if (event.type === "room_context_pinned") {
      room.pinnedContext = {
        version: Number(event.payload?.version || 0),
        content: String(event.payload?.content || ""),
        metadata: event.payload?.metadata && typeof event.payload.metadata === "object" ? event.payload.metadata : {},
        pinnedBy: event.payload?.pinnedBy || event.actorId,
        ts: event.timestamp,
        eventId: event.eventId
      };
    }

    room.lastEventAt = event.timestamp;
    room.lastEventId = event.eventId;
    if (event.type !== "agent_left") {
      room.actors.set(actorId, actor);
    }
    this.recordLocalMemory(room, event);

    return room;
  }

  recordLocalMemory(room, event) {
    const allowed = new Set([
      "conversation_message_posted",
      "order_changed",
      "actor_moved",
      "agent_entered",
      "agent_left",
      "intent_completed",
      "room_context_pinned",
      "presence_heartbeat",
      "status_changed"
    ]);
    if (!allowed.has(event.type)) {
      return;
    }

    const summary = {
      eventId: event.eventId,
      sequence: event.sequence,
      type: event.type,
      actorId: event.actorId,
      ts: event.timestamp
    };

    if (event.type === "conversation_message_posted") {
      summary.text =
        event.payload?.conversation?.text || event.payload?.bubble?.text || event.payload?.text || "";
      summary.threadId =
        event.payload?.conversation?.threadId || event.payload?.conversation?.messageId || null;
      summary.mentions = Array.isArray(event.payload?.conversation?.mentions)
        ? event.payload.conversation.mentions
        : [];
    } else if (event.type === "order_changed") {
      summary.itemId = event.payload?.itemId || null;
      summary.size = event.payload?.size || null;
    } else if (event.type === "actor_moved") {
      summary.direction = event.payload?.direction || null;
      summary.steps = Number(event.payload?.steps || 1);
    } else if (event.type === "intent_completed") {
      summary.intent = event.payload?.intent || null;
      summary.outcome = event.payload?.outcome || null;
    } else if (event.type === "room_context_pinned") {
      summary.content = String(event.payload?.content || "");
      summary.version = Number(event.payload?.version || 0);
    } else if (event.type === "presence_heartbeat") {
      summary.status = event.payload?.status || null;
    } else if (event.type === "status_changed") {
      summary.from = event.payload?.from || null;
      summary.to = event.payload?.to || null;
      summary.reason = event.payload?.reason || null;
    }

    room.localMemory.unshift(summary);
    room.localMemory.length = Math.min(5, room.localMemory.length);
  }

  snapshot(tenantId, roomId) {
    const room = this.ensureRoom(tenantId, roomId);
    return {
      tenantId: room.tenantId,
      roomId: room.roomId,
      actors: [...room.actors.values()],
      pinnedContext: room.pinnedContext ? { ...room.pinnedContext } : null,
      chat: room.chat.slice(0, 100),
      localMemory: room.localMemory.slice(0, 5),
      messages: room.messages.slice(0, 200),
      threads: [...room.threads.values()]
        .map((thread) => ({
          threadId: thread.threadId,
          rootMessageId: thread.rootMessageId,
          messageIds: thread.messageIds.slice(),
          participants: [...thread.participants],
          messageCount: thread.messageCount,
          lastMessageAt: thread.lastMessageAt,
          lastEventId: thread.lastEventId
        }))
        .sort((a, b) => {
          if (!a.lastMessageAt && !b.lastMessageAt) {
            return 0;
          }
          if (!a.lastMessageAt) {
            return 1;
          }
          if (!b.lastMessageAt) {
            return -1;
          }
          return a.lastMessageAt < b.lastMessageAt ? 1 : -1;
        }),
      orders: room.orders.slice(0, 50),
      lastEventAt: room.lastEventAt,
      lastEventId: room.lastEventId
    };
  }
}
