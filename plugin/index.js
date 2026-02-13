import { AgentCafeClient } from "./http-client.js";

const DEFAULT_WORLD_URL = process.env.AGENTCAFE_WORLD_URL || "http://127.0.0.1:3846";
const DEFAULT_ACTOR_ID = process.env.AGENTCAFE_ACTOR_ID || "agent";

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

const plugin = {
  id: "agentcafe",
  name: "agentcafe",
  version: "0.1.0",
  description: "AgentCafe world tools: requestMenu, orderCoffee, getCurrentOrder, move, say, leaveCafe",
  async init(api, config = {}) {
    const worldUrl = config.worldUrl || DEFAULT_WORLD_URL;
    const configuredActorId = config.actorId || DEFAULT_ACTOR_ID;
    const client = new AgentCafeClient({ baseUrl: worldUrl });

    const withActor = (input = {}) => ({
      ...input,
      actorId: toActorId(input.actorId, configuredActorId)
    });

    const ensureActor = async (input = {}) => {
      const data = withActor(input);
      await client.enterCafe({ actorId: data.actorId });
      return data;
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
        return toolResult(`Said: \"${response.bubble.text}\"`, response);
      }
    });

    if (typeof api.registerCommand === "function") {
      try {
        api.registerCommand({
          name: "cafe",
          description: "Show menu and world URL for AgentCafe.",
          execute: async () => {
            const menu = await client.requestMenu();
            return `${buildCommandText(menu.menu)}\nWorld: ${worldUrl}`;
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
