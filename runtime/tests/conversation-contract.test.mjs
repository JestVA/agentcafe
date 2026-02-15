import test from "node:test";
import assert from "node:assert/strict";
import { buildConversationObject } from "../shared/conversation.mjs";

test("threadId defaults to replyToMessageId when explicit threadId is not provided", () => {
  const conversation = buildConversationObject({
    text: "Replying into an existing thread",
    replyToMessageId: "thread-abc"
  });

  assert.equal(conversation.replyToMessageId, "thread-abc");
  assert.equal(conversation.threadId, "thread-abc");
});

test("explicit threadId has priority over replyToMessageId", () => {
  const conversation = buildConversationObject({
    text: "Explicit thread wins",
    threadId: "thread-explicit",
    replyToMessageId: "thread-old"
  });

  assert.equal(conversation.threadId, "thread-explicit");
  assert.equal(conversation.replyToMessageId, "thread-old");
});
