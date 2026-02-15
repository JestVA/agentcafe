function nonEmpty(value) {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  return text ? text : null;
}

function toInboxItems(event, targets, { topic, payload }) {
  const seen = new Set();
  const out = [];
  const tenantId = nonEmpty(event?.tenantId) || "default";
  const roomId = nonEmpty(event?.roomId) || "main";
  const sourceEventId = nonEmpty(event?.eventId);
  if (!sourceEventId) {
    return [];
  }

  for (const target of targets) {
    const actorId = nonEmpty(target);
    if (!actorId || seen.has(actorId)) {
      continue;
    }
    seen.add(actorId);
    out.push({
      tenantId,
      roomId,
      actorId,
      sourceEventId,
      sourceEventSequence: Number(event?.sequence || 0),
      sourceEventType: nonEmpty(event?.type) || "unknown",
      sourceActorId: nonEmpty(event?.actorId),
      sourceEventAt: nonEmpty(event?.timestamp),
      threadId: nonEmpty(payload?.threadId),
      topic,
      payload: {
        ...(payload && typeof payload === "object" ? payload : {}),
        topic
      }
    });
  }

  return out;
}

export function projectInboxItemsFromEvent(event) {
  if (!event || typeof event !== "object") {
    return [];
  }

  if (event.type === "mention_created") {
    return toInboxItems(event, [event.payload?.mentionedActorId], {
      topic: "mention",
      payload: {
        mentionedActorId: nonEmpty(event.payload?.mentionedActorId),
        sourceMessageId: nonEmpty(event.payload?.sourceMessageId),
        threadId: nonEmpty(event.payload?.threadId)
      }
    });
  }

  if (event.type === "task_assigned") {
    return toInboxItems(event, [event.payload?.toAssigneeActorId], {
      topic: "task",
      payload: {
        taskId: nonEmpty(event.payload?.taskId),
        fromAssigneeActorId: nonEmpty(event.payload?.fromAssigneeActorId),
        toAssigneeActorId: nonEmpty(event.payload?.toAssigneeActorId),
        assignedBy: nonEmpty(event.payload?.assignedBy)
      }
    });
  }

  if (event.type === "task_handoff") {
    const targetActorIds = Array.isArray(event.payload?.targetActorIds)
      ? event.payload.targetActorIds
      : [];
    return toInboxItems(event, targetActorIds, {
      topic: "handoff",
      payload: {
        taskId: nonEmpty(event.payload?.taskId),
        handoffId: nonEmpty(event.payload?.handoffId),
        action: nonEmpty(event.payload?.action),
        fromAssigneeActorId: nonEmpty(event.payload?.fromAssigneeActorId),
        toAssigneeActorId: nonEmpty(event.payload?.toAssigneeActorId),
        initiatedBy: nonEmpty(event.payload?.initiatedBy),
        ownerActorId: nonEmpty(event.payload?.ownerActorId),
        threadId: nonEmpty(event.payload?.threadId),
        replyToEventId: nonEmpty(event.payload?.replyToEventId),
        note: nonEmpty(event.payload?.note),
        blockedReason: nonEmpty(event.payload?.blockedReason)
      }
    });
  }

  if (event.type === "operator_override_applied") {
    return toInboxItems(event, [event.payload?.targetActorId], {
      topic: "operator",
      payload: {
        action: nonEmpty(event.payload?.action),
        targetActorId: nonEmpty(event.payload?.targetActorId),
        reason: nonEmpty(event.payload?.reason)
      }
    });
  }

  return [];
}
