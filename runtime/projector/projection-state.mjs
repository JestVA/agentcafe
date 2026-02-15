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
        tasks: [],
        sharedObjects: [],
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
      const px = Number(event.payload?.position?.x);
      const py = Number(event.payload?.position?.y);
      if (Number.isFinite(px) && Number.isFinite(py)) {
        actor.x = Math.round(px);
        actor.y = Math.round(py);
      }
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
      const toStatus = event.payload?.toStatus || event.payload?.to || actor.status;
      actor.status = toStatus;
      actor.presence = {
        ...(actor.presence || {}),
        isActive: toStatus !== "inactive"
      };
    } else if (event.type === "task_created") {
      actor.status = "busy";
      this.upsertTask(room, {
        taskId: event.payload?.taskId || null,
        title: event.payload?.title || null,
        state: event.payload?.state || "open",
        assigneeActorId: event.payload?.assigneeActorId || null,
        progress: Number(event.payload?.progress || 0),
        createdBy: event.payload?.createdBy || event.actorId,
        updatedAt: event.timestamp
      });
    } else if (event.type === "task_updated") {
      actor.status = "busy";
      this.upsertTask(room, {
        taskId: event.payload?.taskId || null,
        state: event.payload?.state || null,
        assigneeActorId: event.payload?.assigneeActorId || null,
        progress: Number(event.payload?.progress || 0),
        updatedAt: event.timestamp
      });
    } else if (event.type === "task_assigned") {
      actor.status = "busy";
      this.upsertTask(room, {
        taskId: event.payload?.taskId || null,
        assigneeActorId: event.payload?.toAssigneeActorId || null,
        updatedAt: event.timestamp
      });
    } else if (event.type === "task_progress_updated") {
      actor.status = "busy";
      this.upsertTask(room, {
        taskId: event.payload?.taskId || null,
        progress: Number(event.payload?.toProgress || 0),
        updatedAt: event.timestamp
      });
    } else if (event.type === "task_completed") {
      actor.status = "idle";
      this.upsertTask(room, {
        taskId: event.payload?.taskId || null,
        state: "done",
        progress: Number(event.payload?.progress || 100),
        completedBy: event.payload?.completedBy || event.actorId,
        completedAt: event.payload?.completedAt || event.timestamp,
        updatedAt: event.timestamp
      });
    } else if (event.type === "shared_object_created") {
      actor.status = "busy";
      this.upsertSharedObject(room, {
        objectId: event.payload?.objectId || null,
        objectType: event.payload?.objectType || null,
        objectKey: event.payload?.objectKey || null,
        title: event.payload?.title || null,
        content: event.payload?.content || null,
        data:
          event.payload?.data && typeof event.payload.data === "object" && !Array.isArray(event.payload.data)
            ? event.payload.data
            : {},
        quantity: event.payload?.quantity == null ? null : Number(event.payload.quantity),
        metadata:
          event.payload?.metadata &&
          typeof event.payload.metadata === "object" &&
          !Array.isArray(event.payload.metadata)
            ? event.payload.metadata
            : {},
        version: Number(event.payload?.version || 1),
        createdBy: event.payload?.createdBy || event.actorId,
        updatedBy: event.payload?.updatedBy || event.actorId,
        createdAt: event.payload?.createdAt || event.timestamp,
        updatedAt: event.payload?.updatedAt || event.timestamp
      });
    } else if (event.type === "shared_object_updated") {
      actor.status = "busy";
      this.upsertSharedObject(room, {
        objectId: event.payload?.objectId || null,
        objectType: event.payload?.objectType || null,
        objectKey: event.payload?.objectKey || null,
        title: event.payload?.title || null,
        content: event.payload?.content || null,
        data:
          event.payload?.data && typeof event.payload.data === "object" && !Array.isArray(event.payload.data)
            ? event.payload.data
            : {},
        quantity: event.payload?.quantity == null ? null : Number(event.payload.quantity),
        metadata:
          event.payload?.metadata &&
          typeof event.payload.metadata === "object" &&
          !Array.isArray(event.payload.metadata)
            ? event.payload.metadata
            : {},
        version: Number(event.payload?.version || 1),
        createdBy: event.payload?.createdBy || null,
        updatedBy: event.payload?.updatedBy || event.actorId,
        createdAt: event.payload?.createdAt || null,
        updatedAt: event.payload?.updatedAt || event.timestamp
      });
    } else if (event.type === "room_context_pinned") {
      room.pinnedContext = {
        version: Number(event.payload?.version || 0),
        content: String(event.payload?.content || ""),
        metadata: event.payload?.metadata && typeof event.payload.metadata === "object" ? event.payload.metadata : {},
        pinnedBy: event.payload?.pinnedBy || event.actorId,
        ts: event.timestamp,
        eventId: event.eventId
      };
    } else if (event.type === "operator_override_applied") {
      actor.status = "busy";
    }

    room.lastEventAt = event.timestamp;
    room.lastEventId = event.eventId;
    if (event.type !== "agent_left") {
      room.actors.set(actorId, actor);
    }
    this.recordLocalMemory(room, event);

    return room;
  }

  upsertTask(room, patch) {
    const taskId = patch?.taskId;
    if (!taskId) {
      return;
    }
    const idx = room.tasks.findIndex((item) => item.taskId === taskId);
    if (idx < 0) {
      room.tasks.unshift({
        taskId,
        title: patch.title || null,
        state: patch.state || "open",
        assigneeActorId: patch.assigneeActorId || null,
        progress: Number(patch.progress || 0),
        createdBy: patch.createdBy || null,
        completedBy: patch.completedBy || null,
        completedAt: patch.completedAt || null,
        updatedAt: patch.updatedAt || null
      });
      room.tasks.length = Math.min(100, room.tasks.length);
      return;
    }
    room.tasks[idx] = {
      ...room.tasks[idx],
      ...patch,
      progress: "progress" in patch ? Number(patch.progress || 0) : room.tasks[idx].progress
    };
    room.tasks.sort((a, b) => (a.updatedAt || "") < (b.updatedAt || "") ? 1 : -1);
  }

  upsertSharedObject(room, patch) {
    const objectId = patch?.objectId;
    if (!objectId) {
      return;
    }

    const idx = room.sharedObjects.findIndex((item) => item.objectId === objectId);
    if (idx < 0) {
      room.sharedObjects.unshift({
        objectId,
        objectType: patch.objectType || null,
        objectKey: patch.objectKey || null,
        title: patch.title || null,
        content: patch.content || null,
        data: patch.data && typeof patch.data === "object" && !Array.isArray(patch.data) ? patch.data : {},
        quantity: patch.quantity == null ? null : Number(patch.quantity),
        metadata:
          patch.metadata && typeof patch.metadata === "object" && !Array.isArray(patch.metadata)
            ? patch.metadata
            : {},
        version: Math.max(1, Number(patch.version || 1)),
        createdBy: patch.createdBy || null,
        updatedBy: patch.updatedBy || null,
        createdAt: patch.createdAt || null,
        updatedAt: patch.updatedAt || null
      });
      room.sharedObjects.length = Math.min(200, room.sharedObjects.length);
      return;
    }

    room.sharedObjects[idx] = {
      ...room.sharedObjects[idx],
      ...patch,
      quantity: "quantity" in patch ? (patch.quantity == null ? null : Number(patch.quantity)) : room.sharedObjects[idx].quantity,
      version: Math.max(1, Number(patch.version || room.sharedObjects[idx].version || 1))
    };
    room.sharedObjects.sort((a, b) => (a.updatedAt || "") < (b.updatedAt || "") ? 1 : -1);
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
      "status_changed",
      "operator_override_applied",
      "task_created",
      "task_updated",
      "task_assigned",
      "task_progress_updated",
      "task_completed",
      "shared_object_created",
      "shared_object_updated"
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
      summary.from = event.payload?.fromStatus || event.payload?.from || null;
      summary.to = event.payload?.toStatus || event.payload?.to || null;
      summary.reason = event.payload?.reason || null;
    } else if (event.type === "operator_override_applied") {
      summary.action = event.payload?.action || null;
      summary.targetActorId = event.payload?.targetActorId || null;
      summary.reason = event.payload?.reason || null;
    } else if (
      event.type === "task_created" ||
      event.type === "task_updated" ||
      event.type === "task_assigned" ||
      event.type === "task_progress_updated" ||
      event.type === "task_completed"
    ) {
      summary.taskId = event.payload?.taskId || null;
      summary.state = event.payload?.state || null;
      summary.progress = Number(event.payload?.progress || event.payload?.toProgress || 0);
    } else if (event.type === "shared_object_created" || event.type === "shared_object_updated") {
      summary.objectId = event.payload?.objectId || null;
      summary.objectType = event.payload?.objectType || null;
      summary.objectKey = event.payload?.objectKey || null;
      summary.version = Number(event.payload?.version || 1);
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
      tasks: room.tasks.slice(0, 100),
      sharedObjects: room.sharedObjects.slice(0, 200),
      orders: room.orders.slice(0, 50),
      lastEventAt: room.lastEventAt,
      lastEventId: room.lastEventId
    };
  }
}
