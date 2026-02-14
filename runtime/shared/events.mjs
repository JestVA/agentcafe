import { randomUUID } from "node:crypto";

export const EVENT_TYPES = {
  ENTER: "agent_entered",
  LEAVE: "agent_left",
  MOVE: "actor_moved",
  SPEAK: "bubble_posted",
  ORDER: "order_changed",
  MENTION_CREATED: "mention_created",
  ROOM_CONTEXT_PINNED: "room_context_pinned",
  PRESENCE_HEARTBEAT: "presence_heartbeat",
  STATUS_CHANGED: "status_changed",
  CONVERSATION_MESSAGE: "conversation_message_posted",
  INTENT_PLANNED: "intent_planned",
  INTENT_COMPLETED: "intent_completed",
  SNAPSHOT_CREATED: "snapshot_created"
};

export function createEvent({
  tenantId = "default",
  roomId = "main",
  actorId,
  type,
  payload,
  correlationId,
  causationId
}) {
  const now = new Date().toISOString();
  return {
    eventId: randomUUID(),
    tenantId,
    roomId,
    actorId,
    type,
    timestamp: now,
    payload: payload || {},
    correlationId: correlationId || randomUUID(),
    causationId: causationId || null
  };
}
