import { randomUUID } from "node:crypto";
import { AppError } from "./errors.mjs";

function parseMentions(text) {
  const found = new Set();
  const pattern = /@([a-zA-Z0-9_\-]+)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    found.add(match[1]);
  }
  return [...found];
}

export function buildConversationObject(body, { maxTextLength = 120 } = {}) {
  const text = String(body.text || "").trim();
  if (!text) {
    throw new AppError("ERR_MISSING_FIELD", "Missing required field: text", { field: "text" });
  }
  const maxChars = Math.max(1, Number(maxTextLength) || 120);
  if (text.length > maxChars) {
    throw new AppError("ERR_OUT_OF_BOUNDS", `text must be <= ${maxChars} chars`, {
      field: "text",
      max: maxChars,
      value: text.length
    });
  }
  const mentions = Array.isArray(body.mentions)
    ? body.mentions.map((value) => String(value).trim()).filter(Boolean)
    : parseMentions(text);

  const messageId = typeof body.messageId === "string" && body.messageId.trim()
    ? body.messageId.trim()
    : randomUUID();

  const parentMessageId = typeof body.parentMessageId === "string" ? body.parentMessageId.trim() || null : null;
  const threadId = typeof body.threadId === "string" && body.threadId.trim()
    ? body.threadId.trim()
    : parentMessageId || messageId;

  const contextWindow = {
    id: typeof body.contextWindowId === "string" ? body.contextWindowId.trim() || null : null,
    maxItems: Number(body.contextWindowMaxItems || 20)
  };

  return {
    messageId,
    threadId,
    parentMessageId,
    replyToMessageId: typeof body.replyToMessageId === "string" ? body.replyToMessageId.trim() || null : null,
    mentions,
    contextWindow,
    text,
    metadata: typeof body.metadata === "object" && body.metadata ? body.metadata : {}
  };
}
