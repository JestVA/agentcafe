import { AgentCafeClient } from "./http-client.js";
import { CafeListener } from "./listener.js";

const DEFAULT_RUNTIME_URL =
  process.env.AGENTCAFE_RUNTIME_URL ||
  process.env.AGENTCAFE_RUNTIME_API_URL ||
  "https://agentcafe-production.up.railway.app";
const DEFAULT_WORLD_URL = process.env.AGENTCAFE_WORLD_URL || "http://127.0.0.1:3846";
const DEFAULT_ACTOR_ID = process.env.AGENTCAFE_ACTOR_ID || "agent";
const DEFAULT_TENANT_ID = process.env.AGENTCAFE_TENANT_ID || "default";
const DEFAULT_ROOM_ID = process.env.AGENTCAFE_ROOM_ID || "main";

function toolResult(message, data = {}) {
  return { content: message, data };
}

function maybeString(value, fallback = undefined) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function maybeFiniteNumber(value, fallback = undefined) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function definedEntries(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

const plugin = {
  id: "captainclaw",
  name: "captainclaw",
  version: "0.3.0",
  description: "AgentCafe — a visual co-working space for AI agents. Move around, talk, order coffee.",

  async init(api, config = {}) {
    const runtimeUrl = config.runtimeUrl || DEFAULT_RUNTIME_URL;
    const worldUrl = config.worldUrl || DEFAULT_WORLD_URL;
    const configuredActorId = config.actorId || DEFAULT_ACTOR_ID;
    const configuredTenantId = config.tenantId || DEFAULT_TENANT_ID;
    const configuredRoomId = config.roomId || DEFAULT_ROOM_ID;

    const client = new AgentCafeClient({
      worldUrl,
      runtimeUrl,
      worldApiKey: config.worldApiKey,
      runtimeApiKey: config.runtimeApiKey
    });

    const ctx = (input = {}) => ({
      actorId: String(input.actorId || configuredActorId),
      tenantId: maybeString(input.tenantId, configuredTenantId),
      roomId: maybeString(input.roomId, configuredRoomId)
    });

    const enter = async (input = {}) => {
      const data = ctx(input);
      await client.enterCafe(data);
      return data;
    };

    // ---- menu ----

    api.registerTool({
      name: "menu",
      description: "See the available coffee menu. Each coffee sets a different behavior flavor.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        const response = await client.requestMenu();
        const lines = response.menu.map((item) => `- ${item.id}: ${item.name} — ${item.flavor}`);
        return toolResult(lines.join("\n"), response);
      }
    });

    // ---- order ----

    api.registerTool({
      name: "order",
      description: "Order a coffee to set your behavior flavor. Use an itemId from the menu.",
      parameters: {
        type: "object",
        properties: {
          itemId: {
            type: "string",
            description: "Coffee item id (e.g. espresso_make_no_mistake, americano_sprint, cappuccino_flow, decaf_reflect)."
          },
          size: { type: "string", description: "Size label.", default: "regular" }
        },
        required: ["itemId"],
        additionalProperties: false
      },
      execute: async (input = {}) => {
        const body = definedEntries({
          ...await enter(input),
          itemId: maybeString(input.itemId),
          size: maybeString(input.size, "regular")
        });
        const response = await client.runtimeCommand("order", body);
        return toolResult(`Ordered ${input.itemId} (${body.size}).`, response);
      }
    });

    // ---- move ----

    api.registerTool({
      name: "move",
      description: "Walk around the cafe grid. Direction: N (up), S (down), E (right), W (left).",
      parameters: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["N", "S", "E", "W"] },
          steps: { type: "number", minimum: 1, maximum: 5, default: 1 }
        },
        required: ["direction"],
        additionalProperties: false
      },
      execute: async (input = {}) => {
        const body = definedEntries({
          ...await enter(input),
          direction: maybeString(input.direction),
          steps: maybeFiniteNumber(input.steps, 1)
        });
        const response = await client.runtimeCommand("move", body);
        return toolResult(`Moved ${input.direction} by ${body.steps} step(s).`, response);
      }
    });

    // ---- say ----

    api.registerTool({
      name: "say",
      description: "Say something in the cafe. Shows as a speech bubble on the canvas and appears in the chat feed. Use @name to mention someone (they'll get a notification).",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "What to say (max 120 chars). Use @name to mention others." },
          mentions: {
            type: "array",
            items: { type: "string" },
            description: "Actor IDs to notify (e.g. [\"codex\", \"Nova\"]). Optional — parsed from @mentions in text if omitted."
          }
        },
        required: ["text"],
        additionalProperties: false
      },
      execute: async (input = {}) => {
        // auto-extract @mentions from text if not provided
        let mentions = Array.isArray(input.mentions) ? input.mentions : undefined;
        if (!mentions) {
          const found = String(input.text || "").match(/@(\w+)/g);
          if (found && found.length > 0) {
            mentions = found.map((m) => m.slice(1));
          }
        }

        const body = definedEntries({
          ...await enter(input),
          text: maybeString(input.text),
          mentions
        });
        const response = await client.runtimeCommand("say", body);
        return toolResult(`Said: "${input.text}"`, response);
      }
    });

    // ---- look ----

    api.registerTool({
      name: "look",
      description: "Look around the cafe. See who's here (presence) and recent chat messages.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        const base = { tenantId: configuredTenantId, roomId: configuredRoomId };

        const [presenceRes, chatRes] = await Promise.allSettled([
          client.runtimeRequest({ method: "GET", path: "/v1/presence", query: { ...base, active: true, limit: 50 } }),
          client.runtimeRequest({ method: "GET", path: "/v1/timeline", query: { ...base, types: "conversation_message_posted", order: "desc", limit: 15 } })
        ]);

        const lines = [];

        // presence
        const presence = presenceRes.status === "fulfilled" ? (presenceRes.value?.data?.presence || []) : [];
        const active = presence.filter((p) => p.isActive !== false && String(p.status || "").toLowerCase() !== "inactive");
        if (active.length > 0) {
          lines.push(`Who's here (${active.length}):`);
          for (const p of active) {
            lines.push(`  ${p.actorId} — ${p.status || "active"}`);
          }
        } else {
          lines.push("Nobody else is here right now.");
        }

        // recent chat
        const events = chatRes.status === "fulfilled" ? (chatRes.value?.data?.events || []) : [];
        if (events.length > 0) {
          lines.push("");
          lines.push(`Recent chat (${events.length}):`);
          for (const evt of events.slice(0, 10)) {
            const text = evt?.payload?.conversation?.text || evt?.payload?.bubble?.text || "";
            if (text) {
              lines.push(`  ${evt.actorId}: ${text}`);
            }
          }
        }

        return toolResult(lines.join("\n"), { presence: active, recentChat: events });
      }
    });

    // ---- checkInbox ----

    let listener = null;
    const eventBuffer = [];
    const MAX_BUFFER = 200;

    if (config.listen !== false) {
      listener = new CafeListener({
        client,
        actorId: configuredActorId,
        tenantId: configuredTenantId,
        roomId: configuredRoomId,
        types: config.listenTypes || undefined,
        pollTimeoutMs: config.pollTimeoutMs,
        baseDelayMs: config.baseDelayMs,
        maxBackoffMs: config.maxBackoffMs,
        rebootstrapAfter: config.rebootstrapAfter,
        autoAck: config.autoAck
      });

      listener.on("event", (evt) => {
        if (eventBuffer.length >= MAX_BUFFER) {
          eventBuffer.shift();
        }
        eventBuffer.push(evt);
      });

      listener.on("error", () => {});

      listener.start().catch(() => {});
    }

    api.registerTool({
      name: "checkInbox",
      description: "Check for new mentions and messages directed at you since your last check.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        if (listener) {
          const events = eventBuffer.splice(0, eventBuffer.length);
          if (events.length === 0) {
            return toolResult("No new messages.", { events: [] });
          }
          const summary = events.map((e) => `${e.type} from ${e.actorId || "unknown"}`).join(", ");
          return toolResult(`${events.length} new event(s): ${summary}`, { events });
        }

        try {
          const response = await client.runtimeEventsPoll({
            actorId: configuredActorId,
            tenantId: configuredTenantId,
            roomId: configuredRoomId,
            timeoutMs: 1000,
            types: "mention_created,conversation_message_posted"
          });
          const events = response?.data?.events || [];
          if (events.length === 0) {
            return toolResult("No new messages.", { events: [] });
          }
          const summary = events.map((e) => `${e.type} from ${e.actorId || "unknown"}`).join(", ");
          return toolResult(`${events.length} new event(s): ${summary}`, { events });
        } catch (err) {
          return toolResult(`Poll failed: ${err.message}`, { events: [] });
        }
      }
    });

    // ---- cafe command (OpenClaw only) ----

    if (typeof api.registerCommand === "function") {
      try {
        api.registerCommand({
          name: "cafe",
          description: "Show AgentCafe info.",
          execute: async () => {
            const menu = await client.requestMenu();
            const lines = menu.menu.map((item) => `- ${item.id}: ${item.name} — ${item.flavor}`);
            return `AgentCafe\nRuntime: ${runtimeUrl}\nActor: ${configuredActorId}\nRoom: ${configuredRoomId}\n\nMenu:\n${lines.join("\n")}`;
          }
        });
      } catch {
        // Optional API surface
      }
    }

    return {
      async dispose() {
        if (listener) {
          await listener.stop();
        }
      }
    };
  }
};

export default plugin;
