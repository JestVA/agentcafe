function compactWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncate(value, maxChars = 120) {
  const text = compactWhitespace(value);
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function conversationFromEvent(event) {
  if (!event || event.type !== "conversation_message_posted") {
    return null;
  }
  const convo = event.payload?.conversation;
  if (!convo || typeof convo !== "object") {
    return null;
  }
  return {
    eventId: event.eventId,
    sequence: Number(event.sequence || 0),
    actorId: String(event.actorId || "").trim() || null,
    messageId: String(convo.messageId || "").trim() || null,
    threadId: String(convo.threadId || "").trim() || null,
    text: compactWhitespace(convo.text || "")
  };
}

export function selectThreadMessages(events = [], { threadId = null, sourceMessageId = null, limit = 8 } = {}) {
  const messages = [];
  for (const event of events || []) {
    const convo = conversationFromEvent(event);
    if (convo) {
      messages.push(convo);
    }
  }

  if (messages.length === 0) {
    return [];
  }

  let targetThreadId = threadId;
  if (!targetThreadId && sourceMessageId) {
    const source = messages.find((message) => message.messageId === sourceMessageId);
    targetThreadId = source?.threadId || source?.messageId || null;
  }

  let filtered = messages;
  if (targetThreadId) {
    filtered = messages.filter((message) => message.threadId === targetThreadId || message.messageId === targetThreadId);
  }

  filtered.sort((a, b) => a.sequence - b.sequence);
  const max = Math.max(1, Number(limit) || 8);
  return filtered.slice(-max);
}

export function buildMentionReply({
  actorId,
  sourceActorId = null,
  threadMessages = [],
  maxChars = 120
} = {}) {
  const cleanedActorId = String(actorId || "agent").trim() || "agent";
  const source = String(sourceActorId || "").trim() || null;
  const messages = Array.isArray(threadMessages) ? threadMessages : [];
  const visibleMessages = messages.filter((item) => item?.text);

  const seenCount = visibleMessages.length;
  const last = visibleMessages[visibleMessages.length - 1] || null;
  const lastSpeaker = last?.actorId || null;

  const opener = source ? `@${source} I saw your mention.` : "I saw the mention.";
  const context =
    seenCount > 0
      ? ` Context synced (${seenCount} msgs${lastSpeaker ? `, last by ${lastSpeaker}` : ""}).`
      : " Context synced.";
  const closer = ` @${cleanedActorId} ready for next step.`;

  return truncate(`${opener}${context}${closer}`, Math.max(40, Number(maxChars) || 120));
}

export function isMentionInboxItem(item, actorId) {
  if (!item || typeof item !== "object") {
    return false;
  }
  if (item.topic !== "mention") {
    return false;
  }
  if (item.ackedAt) {
    return false;
  }
  const target = String(actorId || "").trim();
  if (!target) {
    return false;
  }
  return String(item.actorId || "").trim() === target;
}

export function isTaskInboxItem(item, actorId) {
  if (!item || typeof item !== "object") {
    return false;
  }
  if (item.topic !== "task") {
    return false;
  }
  if (item.ackedAt) {
    return false;
  }
  const target = String(actorId || "").trim();
  if (!target) {
    return false;
  }
  return String(item.actorId || "").trim() === target;
}

export function shouldRouteMention({
  sourceActorId = null,
  threadId = null,
  sourceMessageId = null,
  allowedSources = null,
  deniedSources = null,
  allowedThreadPrefixes = null
} = {}) {
  const source = String(sourceActorId || "").trim();
  const thread = String(threadId || sourceMessageId || "").trim();
  const allowSources =
    allowedSources && typeof allowedSources.has === "function" && allowedSources.size > 0
      ? allowedSources
      : null;
  const denySources =
    deniedSources && typeof deniedSources.has === "function" && deniedSources.size > 0
      ? deniedSources
      : null;
  const allowPrefixes = Array.isArray(allowedThreadPrefixes)
    ? allowedThreadPrefixes.map((item) => String(item || "").trim()).filter(Boolean)
    : [];

  if (source && denySources?.has(source)) {
    return {
      allow: false,
      reason: "blocked_source"
    };
  }

  if (allowSources && (!source || !allowSources.has(source))) {
    return {
      allow: false,
      reason: "source_not_allowlisted"
    };
  }

  if (allowPrefixes.length > 0) {
    if (!thread) {
      return {
        allow: false,
        reason: "thread_missing"
      };
    }
    const matched = allowPrefixes.some((prefix) => thread.startsWith(prefix));
    if (!matched) {
      return {
        allow: false,
        reason: "thread_not_allowlisted"
      };
    }
  }

  return {
    allow: true,
    reason: null
  };
}
