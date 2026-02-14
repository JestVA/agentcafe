import { AgentCafeClient } from "./http-client.js";

const DEFAULT_WORLD_URL = process.env.AGENTCAFE_WORLD_URL || "http://127.0.0.1:3846";
const DEFAULT_RUNTIME_URL =
  process.env.AGENTCAFE_RUNTIME_URL ||
  process.env.AGENTCAFE_RUNTIME_API_URL ||
  "http://127.0.0.1:3850";
const DEFAULT_ACTOR_ID = process.env.AGENTCAFE_ACTOR_ID || "agent";
const DEFAULT_TENANT_ID = process.env.AGENTCAFE_TENANT_ID || "default";
const DEFAULT_ROOM_ID = process.env.AGENTCAFE_ROOM_ID || "main";

const RUNTIME_QUERY_PATHS = {
  events: "/v1/events",
  mentions: "/v1/mentions",
  timeline: "/v1/timeline",
  replay: "/v1/replay",
  local_memory: "/v1/memory/local",
  collaboration_score: "/v1/collaboration/score",
  presence: "/v1/presence",
  presence_last_seen: "/v1/presence/last-seen",
  pinned_context: "/v1/rooms/context/pin",
  pinned_context_history: "/v1/rooms/context/history",
  tasks: "/v1/tasks",
  objects: "/v1/objects",
  profiles: "/v1/profiles",
  permissions: "/v1/permissions",
  operator_overrides: "/v1/operator/overrides",
  operator_audit: "/v1/operator/audit",
  subscriptions: "/v1/subscriptions",
  subscription_deliveries: "/v1/subscriptions/deliveries",
  subscription_dlq: "/v1/subscriptions/dlq",
  reaction_subscriptions: "/v1/reactions/subscriptions",
  health: "/healthz"
};

function toActorId(inputActorId, configuredActorId) {
  return String(inputActorId || configuredActorId || DEFAULT_ACTOR_ID);
}

function toolResult(message, data = {}) {
  return {
    content: message,
    data
  };
}

function buildCommandText(menu) {
  const lines = ["AgentCafe menu:"];
  for (const item of menu) {
    lines.push(`- ${item.id}: ${item.name} (${item.flavor})`);
  }
  return lines.join("\n");
}

function maybeString(value, fallback = undefined) {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : fallback;
}

function maybeFiniteNumber(value, fallback = undefined) {
  if (value == null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function maybeArray(value) {
  return Array.isArray(value) ? value : undefined;
}

function definedEntries(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined));
}

const plugin = {
  id: "agentcafe",
  name: "agentcafe",
  version: "0.2.0",
  description:
    "AgentCafe tools for world + runtime API (intents, conversation, presence, tasks, objects, automation).",
  async init(api, config = {}) {
    const worldUrl = config.worldUrl || DEFAULT_WORLD_URL;
    const runtimeUrl = config.runtimeUrl || DEFAULT_RUNTIME_URL;
    const configuredActorId = config.actorId || DEFAULT_ACTOR_ID;
    const configuredTenantId = config.tenantId || DEFAULT_TENANT_ID;
    const configuredRoomId = config.roomId || DEFAULT_ROOM_ID;
    const client = new AgentCafeClient({ worldUrl, runtimeUrl });

    const withActor = (input = {}) => ({
      ...input,
      actorId: toActorId(input.actorId, configuredActorId)
    });

    const withRuntimeContext = (input = {}, { includeActor = false } = {}) => {
      const base = {
        tenantId: maybeString(input.tenantId, configuredTenantId),
        roomId: maybeString(input.roomId, configuredRoomId)
      };
      if (includeActor) {
        base.actorId = toActorId(input.actorId, configuredActorId);
      }
      return base;
    };

    const ensureActor = async (input = {}) => {
      const data = withActor(input);
      await client.enterCafe({ actorId: data.actorId });
      return data;
    };

    const runtimeOk = (action, response) => {
      const correlationId = response?.data?.correlationId;
      const suffix = correlationId ? ` (correlationId=${correlationId})` : "";
      return toolResult(`[runtime] ${action} ok${suffix}`, response);
    };

    api.registerTool({
      name: "requestMenu",
      description: "Returns the available AgentCafe coffee menu and behavior flavors.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false
      },
      execute: async () => {
        const response = await client.requestMenu();
        return toolResult(buildCommandText(response.menu), response);
      }
    });

    api.registerTool({
      name: "orderCoffee",
      description: "Order a coffee by itemId to set a temporary behavior flavor.",
      parameters: {
        type: "object",
        properties: {
          actorId: { type: "string", description: "Optional actor id override." },
          itemId: { type: "string", description: "Menu item id from requestMenu." },
          size: { type: "string", description: "Optional size label.", default: "regular" }
        },
        required: ["itemId"],
        additionalProperties: false
      },
      execute: async (input = {}) => {
        const response = await client.orderCoffee(await ensureActor(input));
        const order = response.order;
        return toolResult(
          `Ordered ${order.name} (${order.size}). Flavor: ${order.flavor}`,
          response
        );
      }
    });

    api.registerTool({
      name: "getCurrentOrder",
      description: "Get the current active coffee behavior for the actor.",
      parameters: {
        type: "object",
        properties: {
          actorId: { type: "string", description: "Optional actor id override." }
        },
        additionalProperties: false
      },
      execute: async (input = {}) => {
        const response = await client.getCurrentOrder(await ensureActor(input));
        if (!response.order) {
          return toolResult("No active coffee order.", response);
        }
        return toolResult(
          `Active order: ${response.order.name} (${response.order.size}).`,
          response
        );
      }
    });

    api.registerTool({
      name: "leaveCafe",
      description: "Leave the AgentCafe and clear bubble/order state.",
      parameters: {
        type: "object",
        properties: {
          actorId: { type: "string", description: "Optional actor id override." }
        },
        additionalProperties: false
      },
      execute: async (input = {}) => {
        const response = await client.leaveCafe(withActor(input));
        return toolResult("Actor left the cafe.", response);
      }
    });

    api.registerTool({
      name: "move",
      description: "Move actor in grid using N, S, E, W.",
      parameters: {
        type: "object",
        properties: {
          actorId: { type: "string", description: "Optional actor id override." },
          direction: { type: "string", enum: ["N", "S", "E", "W"] },
          steps: { type: "number", minimum: 1, maximum: 5, default: 1 }
        },
        required: ["direction"],
        additionalProperties: false
      },
      execute: async (input = {}) => {
        const response = await client.move(await ensureActor(input));
        const actor = response.actor;
        return toolResult(
          `Moved ${response.movement.direction} by ${response.movement.steps}. Position is now (${actor.x}, ${actor.y}).`,
          response
        );
      }
    });

    api.registerTool({
      name: "say",
      description: "Show a short speech bubble for the actor in AgentCafe canvas.",
      parameters: {
        type: "object",
        properties: {
          actorId: { type: "string", description: "Optional actor id override." },
          text: { type: "string", description: "Speech bubble text (max 120 chars)." },
          ttlMs: {
            type: "number",
            minimum: 2000,
            maximum: 30000,
            default: 7000,
            description: "Bubble lifetime in milliseconds."
          }
        },
        required: ["text"],
        additionalProperties: false
      },
      execute: async (input = {}) => {
        const response = await client.say(await ensureActor(input));
        return toolResult(`Said: "${response.bubble.text}"`, response);
      }
    });

    api.registerTool({
      name: "runtimeCommand",
      description: "Execute runtime command enter|leave|move|say|order with idempotency.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["enter", "leave", "move", "say", "order"] },
          actorId: { type: "string" },
          tenantId: { type: "string" },
          roomId: { type: "string" },
          direction: { type: "string", enum: ["N", "S", "E", "W"] },
          steps: { type: "number" },
          text: { type: "string" },
          ttlMs: { type: "number" },
          itemId: { type: "string" },
          size: { type: "string" },
          threadId: { type: "string" },
          replyToEventId: { type: "string" },
          mentions: { type: "array", items: { type: "string" } }
        },
        required: ["action"],
        additionalProperties: false
      },
      execute: async (input = {}) => {
        const body = definedEntries({
          ...withRuntimeContext(input, { includeActor: true }),
          direction: maybeString(input.direction),
          steps: maybeFiniteNumber(input.steps),
          text: maybeString(input.text),
          ttlMs: maybeFiniteNumber(input.ttlMs),
          itemId: maybeString(input.itemId),
          size: maybeString(input.size),
          threadId: maybeString(input.threadId),
          replyToEventId: maybeString(input.replyToEventId),
          mentions: maybeArray(input.mentions)
        });
        const response = await client.runtimeCommand(input.action, body);
        return runtimeOk(`command:${input.action}`, response);
      }
    });

    api.registerTool({
      name: "runtimeIntent",
      description: "Execute high-level runtime intent navigate_to or sit_at_table.",
      parameters: {
        type: "object",
        properties: {
          intent: { type: "string", enum: ["navigate_to", "sit_at_table"] },
          actorId: { type: "string" },
          tenantId: { type: "string" },
          roomId: { type: "string" },
          tableId: { type: "string" },
          label: { type: "string" },
          x: { type: "number" },
          y: { type: "number" },
          payload: { type: "object", additionalProperties: true }
        },
        required: ["intent"],
        additionalProperties: false
      },
      execute: async (input = {}) => {
        const payload =
          input.payload && typeof input.payload === "object"
            ? input.payload
            : definedEntries({
                tableId: maybeString(input.tableId),
                label: maybeString(input.label),
                x: maybeFiniteNumber(input.x),
                y: maybeFiniteNumber(input.y)
              });
        const body = {
          ...withRuntimeContext(input, { includeActor: true }),
          intent: input.intent,
          payload
        };
        const response = await client.runtimeIntent(body);
        return runtimeOk(`intent:${input.intent}`, response);
      }
    });

    api.registerTool({
      name: "runtimeConversationMessage",
      description: "Post structured conversation message with thread/reply/mentions.",
      parameters: {
        type: "object",
        properties: {
          actorId: { type: "string" },
          tenantId: { type: "string" },
          roomId: { type: "string" },
          text: { type: "string" },
          threadId: { type: "string" },
          replyToEventId: { type: "string" },
          mentions: { type: "array", items: { type: "string" } },
          metadata: { type: "object", additionalProperties: true }
        },
        required: ["text"],
        additionalProperties: false
      },
      execute: async (input = {}) => {
        const body = definedEntries({
          ...withRuntimeContext(input, { includeActor: true }),
          text: maybeString(input.text),
          threadId: maybeString(input.threadId),
          replyToEventId: maybeString(input.replyToEventId),
          mentions: maybeArray(input.mentions),
          metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : undefined
        });
        const response = await client.runtimeConversationMessage(body);
        return runtimeOk("conversation_message", response);
      }
    });

    api.registerTool({
      name: "runtimePresenceHeartbeat",
      description: "Update actor presence status (thinking|idle|busy|inactive).",
      parameters: {
        type: "object",
        properties: {
          actorId: { type: "string" },
          tenantId: { type: "string" },
          roomId: { type: "string" },
          status: { type: "string", enum: ["thinking", "idle", "busy", "inactive"] },
          ttlMs: { type: "number" }
        },
        additionalProperties: false
      },
      execute: async (input = {}) => {
        const body = definedEntries({
          ...withRuntimeContext(input, { includeActor: true }),
          status: maybeString(input.status),
          ttlMs: maybeFiniteNumber(input.ttlMs)
        });
        const response = await client.runtimePresenceHeartbeat(body);
        return runtimeOk("presence_heartbeat", response);
      }
    });

    api.registerTool({
      name: "runtimeUpsertProfile",
      description: "Create or update agent profile (displayName/avatar/bio/theme).",
      parameters: {
        type: "object",
        properties: {
          actorId: { type: "string" },
          tenantId: { type: "string" },
          displayName: { type: "string" },
          avatarUrl: { type: "string" },
          bio: { type: "string" },
          theme: { type: "object", additionalProperties: true },
          metadata: { type: "object", additionalProperties: true }
        },
        additionalProperties: false
      },
      execute: async (input = {}) => {
        const actorId = toActorId(input.actorId, configuredActorId);
        const body = definedEntries({
          tenantId: maybeString(input.tenantId, configuredTenantId),
          actorId,
          displayName: maybeString(input.displayName, actorId),
          avatarUrl: maybeString(input.avatarUrl, null),
          bio: maybeString(input.bio, null),
          theme: input.theme && typeof input.theme === "object" ? input.theme : undefined,
          metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : undefined
        });
        const response = await client.runtimeUpsertProfile(body);
        return runtimeOk("profile_upsert", response);
      }
    });

    api.registerTool({
      name: "runtimeUpsertPermission",
      description: "Set per-agent capability flags (canMove/canSpeak/canOrder/canEnterLeave/canModerate).",
      parameters: {
        type: "object",
        properties: {
          actorId: { type: "string" },
          tenantId: { type: "string" },
          roomId: { type: "string" },
          canMove: { type: "boolean" },
          canSpeak: { type: "boolean" },
          canOrder: { type: "boolean" },
          canEnterLeave: { type: "boolean" },
          canModerate: { type: "boolean" }
        },
        additionalProperties: false
      },
      execute: async (input = {}) => {
        const body = definedEntries({
          ...withRuntimeContext(input, { includeActor: true }),
          canMove: typeof input.canMove === "boolean" ? input.canMove : undefined,
          canSpeak: typeof input.canSpeak === "boolean" ? input.canSpeak : undefined,
          canOrder: typeof input.canOrder === "boolean" ? input.canOrder : undefined,
          canEnterLeave: typeof input.canEnterLeave === "boolean" ? input.canEnterLeave : undefined,
          canModerate: typeof input.canModerate === "boolean" ? input.canModerate : undefined
        });
        const response = await client.runtimeUpsertPermission(body);
        return runtimeOk("permission_upsert", response);
      }
    });

    api.registerTool({
      name: "runtimePinRoomContext",
      description: "Pin room context/instructions (moderator capability required).",
      parameters: {
        type: "object",
        properties: {
          actorId: { type: "string" },
          tenantId: { type: "string" },
          roomId: { type: "string" },
          content: { type: "string" },
          metadata: { type: "object", additionalProperties: true }
        },
        required: ["content"],
        additionalProperties: false
      },
      execute: async (input = {}) => {
        const body = definedEntries({
          ...withRuntimeContext(input, { includeActor: true }),
          content: maybeString(input.content),
          metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : undefined
        });
        const response = await client.runtimePinRoomContext(body);
        return runtimeOk("room_context_pin", response);
      }
    });

    api.registerTool({
      name: "runtimeCreateTask",
      description: "Create a task/quest for room collaboration.",
      parameters: {
        type: "object",
        properties: {
          actorId: { type: "string" },
          tenantId: { type: "string" },
          roomId: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          state: { type: "string", enum: ["open", "active", "done"] },
          assigneeActorId: { type: "string" },
          progress: { type: "number" },
          metadata: { type: "object", additionalProperties: true }
        },
        required: ["title"],
        additionalProperties: false
      },
      execute: async (input = {}) => {
        const body = definedEntries({
          ...withRuntimeContext(input, { includeActor: true }),
          title: maybeString(input.title),
          description: maybeString(input.description, null),
          state: maybeString(input.state),
          assigneeActorId: maybeString(input.assigneeActorId, null),
          progress: maybeFiniteNumber(input.progress),
          metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : undefined
        });
        const response = await client.runtimeCreateTask(body);
        return runtimeOk("task_create", response);
      }
    });

    api.registerTool({
      name: "runtimeUpdateTask",
      description: "Update task assignment/state/progress.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          actorId: { type: "string" },
          tenantId: { type: "string" },
          state: { type: "string", enum: ["open", "active", "done"] },
          assigneeActorId: { type: "string" },
          progress: { type: "number" },
          title: { type: "string" },
          description: { type: "string" },
          metadata: { type: "object", additionalProperties: true }
        },
        required: ["taskId"],
        additionalProperties: false
      },
      execute: async (input = {}) => {
        const body = definedEntries({
          ...withRuntimeContext(input, { includeActor: true }),
          state: maybeString(input.state),
          assigneeActorId: maybeString(input.assigneeActorId, null),
          progress: maybeFiniteNumber(input.progress),
          title: maybeString(input.title),
          description: maybeString(input.description, null),
          metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : undefined
        });
        const response = await client.runtimeUpdateTask(input.taskId, body);
        return runtimeOk("task_update", response);
      }
    });

    api.registerTool({
      name: "runtimeCreateObject",
      description: "Create shared object (whiteboard|note|token).",
      parameters: {
        type: "object",
        properties: {
          actorId: { type: "string" },
          tenantId: { type: "string" },
          roomId: { type: "string" },
          objectType: { type: "string", enum: ["whiteboard", "note", "token"] },
          objectKey: { type: "string" },
          title: { type: "string" },
          content: { type: "string" },
          data: { type: "object", additionalProperties: true },
          quantity: { type: "number" },
          metadata: { type: "object", additionalProperties: true }
        },
        required: ["objectType"],
        additionalProperties: false
      },
      execute: async (input = {}) => {
        const body = definedEntries({
          ...withRuntimeContext(input, { includeActor: true }),
          objectType: maybeString(input.objectType),
          objectKey: maybeString(input.objectKey, null),
          title: maybeString(input.title, null),
          content: maybeString(input.content, null),
          data: input.data && typeof input.data === "object" ? input.data : undefined,
          quantity: maybeFiniteNumber(input.quantity),
          metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : undefined
        });
        const response = await client.runtimeCreateObject(body);
        return runtimeOk("object_create", response);
      }
    });

    api.registerTool({
      name: "runtimeUpdateObject",
      description: "Update shared object fields and increment object version.",
      parameters: {
        type: "object",
        properties: {
          objectId: { type: "string" },
          actorId: { type: "string" },
          tenantId: { type: "string" },
          objectKey: { type: "string" },
          title: { type: "string" },
          content: { type: "string" },
          data: { type: "object", additionalProperties: true },
          quantity: { type: "number" },
          metadata: { type: "object", additionalProperties: true }
        },
        required: ["objectId"],
        additionalProperties: false
      },
      execute: async (input = {}) => {
        const body = definedEntries({
          ...withRuntimeContext(input, { includeActor: true }),
          objectKey: maybeString(input.objectKey, null),
          title: maybeString(input.title, null),
          content: maybeString(input.content, null),
          data: input.data && typeof input.data === "object" ? input.data : undefined,
          quantity: maybeFiniteNumber(input.quantity),
          metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : undefined
        });
        const response = await client.runtimeUpdateObject(input.objectId, body);
        return runtimeOk("object_update", response);
      }
    });

    api.registerTool({
      name: "runtimeApplyOperatorOverride",
      description: "Apply operator override pause/resume/mute/unmute/force_leave.",
      parameters: {
        type: "object",
        properties: {
          operatorId: { type: "string" },
          tenantId: { type: "string" },
          roomId: { type: "string" },
          action: {
            type: "string",
            enum: ["pause_room", "resume_room", "mute_agent", "unmute_agent", "force_leave"]
          },
          targetActorId: { type: "string" },
          reason: { type: "string" },
          metadata: { type: "object", additionalProperties: true }
        },
        required: ["action"],
        additionalProperties: false
      },
      execute: async (input = {}) => {
        const body = definedEntries({
          tenantId: maybeString(input.tenantId, configuredTenantId),
          roomId: maybeString(input.roomId, configuredRoomId),
          operatorId: toActorId(input.operatorId || input.actorId, configuredActorId),
          action: maybeString(input.action),
          targetActorId: maybeString(input.targetActorId, null),
          reason: maybeString(input.reason, null),
          metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : undefined
        });
        const response = await client.runtimeApplyOperatorOverride(body);
        return runtimeOk(`operator_override:${input.action}`, response);
      }
    });

    api.registerTool({
      name: "runtimeCreateWebhookSubscription",
      description: "Create signed webhook subscription for room events.",
      parameters: {
        type: "object",
        properties: {
          tenantId: { type: "string" },
          roomId: { type: "string" },
          actorId: { type: "string" },
          targetUrl: { type: "string" },
          eventTypes: { type: "array", items: { type: "string" } },
          secret: { type: "string" },
          enabled: { type: "boolean" },
          maxRetries: { type: "number" },
          backoffMs: { type: "number" },
          timeoutMs: { type: "number" },
          metadata: { type: "object", additionalProperties: true }
        },
        required: ["targetUrl"],
        additionalProperties: false
      },
      execute: async (input = {}) => {
        const body = definedEntries({
          tenantId: maybeString(input.tenantId, configuredTenantId),
          roomId: maybeString(input.roomId, null),
          actorId: maybeString(input.actorId, null),
          targetUrl: maybeString(input.targetUrl),
          eventTypes: maybeArray(input.eventTypes),
          secret: maybeString(input.secret),
          enabled: typeof input.enabled === "boolean" ? input.enabled : undefined,
          maxRetries: maybeFiniteNumber(input.maxRetries),
          backoffMs: maybeFiniteNumber(input.backoffMs),
          timeoutMs: maybeFiniteNumber(input.timeoutMs),
          metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : undefined
        });
        const response = await client.runtimeCreateSubscription(body);
        return runtimeOk("subscription_create", response);
      }
    });

    api.registerTool({
      name: "runtimeReplayWebhookDlq",
      description: "Replay a failed webhook delivery by DLQ id.",
      parameters: {
        type: "object",
        properties: {
          dlqId: { type: "string" },
          tenantId: { type: "string" },
          roomId: { type: "string" },
          actorId: { type: "string" }
        },
        required: ["dlqId"],
        additionalProperties: false
      },
      execute: async (input = {}) => {
        const body = definedEntries({
          tenantId: maybeString(input.tenantId, configuredTenantId),
          roomId: maybeString(input.roomId, configuredRoomId),
          actorId: toActorId(input.actorId, configuredActorId)
        });
        const response = await client.runtimeReplaySubscriptionDlq(input.dlqId, body);
        return runtimeOk("subscription_dlq_replay", response);
      }
    });

    api.registerTool({
      name: "runtimeCreateReactionSubscription",
      description: "Create internal reaction automation (say|move|order) on matching events.",
      parameters: {
        type: "object",
        properties: {
          tenantId: { type: "string" },
          roomId: { type: "string" },
          sourceActorId: { type: "string" },
          targetActorId: { type: "string" },
          triggerEventTypes: { type: "array", items: { type: "string" } },
          actionType: { type: "string", enum: ["say", "move", "order"] },
          actionPayload: { type: "object", additionalProperties: true },
          enabled: { type: "boolean" },
          cooldownMs: { type: "number" },
          ignoreSelf: { type: "boolean" },
          ignoreReactionEvents: { type: "boolean" },
          metadata: { type: "object", additionalProperties: true }
        },
        required: ["targetActorId", "actionType", "actionPayload"],
        additionalProperties: false
      },
      execute: async (input = {}) => {
        const body = definedEntries({
          tenantId: maybeString(input.tenantId, configuredTenantId),
          roomId: maybeString(input.roomId, null),
          sourceActorId: maybeString(input.sourceActorId, null),
          targetActorId: maybeString(input.targetActorId),
          triggerEventTypes: maybeArray(input.triggerEventTypes),
          actionType: maybeString(input.actionType),
          actionPayload:
            input.actionPayload && typeof input.actionPayload === "object"
              ? input.actionPayload
              : undefined,
          enabled: typeof input.enabled === "boolean" ? input.enabled : undefined,
          cooldownMs: maybeFiniteNumber(input.cooldownMs),
          ignoreSelf: typeof input.ignoreSelf === "boolean" ? input.ignoreSelf : undefined,
          ignoreReactionEvents:
            typeof input.ignoreReactionEvents === "boolean" ? input.ignoreReactionEvents : undefined,
          metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : undefined
        });
        const response = await client.runtimeCreateReactionSubscription(body);
        return runtimeOk("reaction_subscription_create", response);
      }
    });

    api.registerTool({
      name: "runtimeQuery",
      description: "Query runtime read endpoints (mentions, replay, memory, tasks, objects, etc.).",
      parameters: {
        type: "object",
        properties: {
          endpoint: {
            type: "string",
            enum: Object.keys(RUNTIME_QUERY_PATHS)
          },
          query: { type: "object", additionalProperties: true }
        },
        required: ["endpoint"],
        additionalProperties: false
      },
      execute: async (input = {}) => {
        const path = RUNTIME_QUERY_PATHS[input.endpoint];
        const query = {
          tenantId: configuredTenantId,
          roomId: configuredRoomId,
          ...(input.query && typeof input.query === "object" ? input.query : {})
        };
        const response = await client.runtimeRequest({
          method: "GET",
          path,
          query
        });
        return runtimeOk(`query:${input.endpoint}`, response);
      }
    });

    api.registerTool({
      name: "runtimeRequest",
      description:
        "Raw runtime API request escape hatch for any endpoint. Use for advanced workflows not covered by dedicated tools.",
      parameters: {
        type: "object",
        properties: {
          method: { type: "string", enum: ["GET", "POST", "PATCH", "DELETE"] },
          path: { type: "string" },
          query: { type: "object", additionalProperties: true },
          body: { type: "object", additionalProperties: true },
          idempotencyKey: { type: "string" }
        },
        required: ["method", "path"],
        additionalProperties: false
      },
      execute: async (input = {}) => {
        const path = String(input.path || "");
        if (!path.startsWith("/v1/") && path !== "/healthz") {
          throw new Error("runtimeRequest path must start with /v1/ or be /healthz");
        }

        const method = String(input.method || "GET").toUpperCase();
        const headers = input.idempotencyKey
          ? { "idempotency-key": String(input.idempotencyKey) }
          : undefined;

        const response = await client.runtimeRequest({
          method,
          path,
          query: input.query && typeof input.query === "object" ? input.query : undefined,
          body:
            input.body && typeof input.body === "object"
              ? input.body
              : method === "GET"
                ? undefined
                : {},
          headers,
          idempotent: method !== "GET" && !input.idempotencyKey
        });
        return runtimeOk(`${method} ${path}`, response);
      }
    });

    if (typeof api.registerCommand === "function") {
      try {
        api.registerCommand({
          name: "cafe",
          description: "Show menu plus world/runtime endpoints for AgentCafe.",
          execute: async () => {
            const menu = await client.requestMenu();
            return `${buildCommandText(menu.menu)}\nWorld: ${worldUrl}\nRuntime: ${runtimeUrl}`;
          }
        });
      } catch {
        // Optional API surface differs across OpenClaw versions.
      }
    }

    return {
      async dispose() {
        // No background resources to stop.
      }
    };
  }
};

export default plugin;
