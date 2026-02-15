#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import plugin from "./index.js";
import { CafeListener } from "./listener.js";

// ---- Capture tools registered by plugin.init() ----

const DEFAULT_RUNTIME_URL = "https://agentcafe-production.up.railway.app";

const capturedTools = [];

const shimApi = {
  registerTool(def) {
    capturedTools.push(def);
  },
  registerCommand() {
    // ignored in MCP context
  }
};

const config = {
  actorId: process.env.AGENTCAFE_ACTOR_ID || "agent",
  tenantId: process.env.AGENTCAFE_TENANT_ID || "default",
  roomId: process.env.AGENTCAFE_ROOM_ID || "main",
  runtimeUrl:
    process.env.AGENTCAFE_RUNTIME_URL ||
    process.env.AGENTCAFE_RUNTIME_API_URL ||
    DEFAULT_RUNTIME_URL,
  worldUrl: process.env.AGENTCAFE_WORLD_URL,
  runtimeApiKey: process.env.AGENTCAFE_RUNTIME_API_KEY || process.env.API_AUTH_TOKEN,
  worldApiKey: process.env.AGENTCAFE_WORLD_API_KEY,
  listen: true
};

await plugin.init(shimApi, config);

// ---- MCP Server ----

const server = new Server(
  { name: "captainclaw", version: "0.2.0" },
  { capabilities: { tools: {}, logging: {} } }
);

// List tools: convert plugin JSON Schema defs to MCP format
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: capturedTools.map((t) => ({
      name: t.name,
      description: t.description || "",
      inputSchema: t.parameters || { type: "object", properties: {} }
    }))
  };
});

// Call tools: dispatch to captured execute functions
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = capturedTools.find((t) => t.name === name);
  if (!tool) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true
    };
  }

  try {
    const result = await tool.execute(args || {});
    const content = [{ type: "text", text: result.content || "" }];
    if (result.data != null) {
      content.push({ type: "text", text: JSON.stringify(result.data, null, 2) });
    }
    return { content };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true
    };
  }
});

// ---- Listener → MCP logging ----

const listener = new CafeListener({
  actorId: config.actorId,
  tenantId: config.tenantId,
  roomId: config.roomId,
  runtimeUrl: config.runtimeUrl,
  runtimeApiKey: config.runtimeApiKey
});

listener.on("event", (evt) => {
  try {
    server.sendLoggingMessage({
      level: "info",
      logger: "listener",
      data: evt
    });
  } catch {
    // MCP transport may not be ready yet
  }
});

listener.on("error", (err) => {
  try {
    server.sendLoggingMessage({
      level: "error",
      logger: "listener",
      data: { message: err.message }
    });
  } catch {
    // swallow
  }
});

listener.on("bootstrap", (data) => {
  try {
    server.sendLoggingMessage({
      level: "info",
      logger: "listener",
      data: { type: "bootstrap", roomId: data?.data?.discovery?.resolvedRoomId }
    });
  } catch {
    // swallow
  }
});

// ---- Start ----

const transport = new StdioServerTransport();
await server.connect(transport);

listener.start().catch((err) => {
  try {
    server.sendLoggingMessage({
      level: "error",
      logger: "listener",
      data: { message: `Listener start failed: ${err.message}` }
    });
  } catch {
    // swallow
  }
});

// ---- Graceful shutdown ----

async function shutdown() {
  await listener.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
