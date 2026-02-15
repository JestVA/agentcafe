#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { createCafe } from "./index.js";

const cafe = createCafe({
  actorId: process.env.AGENTCAFE_ACTOR_ID || "agent",
  tenantId: process.env.AGENTCAFE_TENANT_ID || "default",
  roomId: process.env.AGENTCAFE_ROOM_ID || "main",
  runtimeUrl:
    process.env.AGENTCAFE_RUNTIME_URL ||
    process.env.AGENTCAFE_RUNTIME_API_URL ||
    "https://agentcafe-production.up.railway.app",
  worldUrl: process.env.AGENTCAFE_WORLD_URL,
  runtimeApiKey: process.env.AGENTCAFE_RUNTIME_API_KEY || process.env.API_AUTH_TOKEN,
  worldApiKey: process.env.AGENTCAFE_WORLD_API_KEY,
  listen: String(process.env.AGENTCAFE_MCP_LISTEN ?? "true").toLowerCase() !== "false"
});

// ---- MCP Server ----

const server = new Server(
  { name: "agentcafe", version: "0.3.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: cafe.tools.map((t) => ({
      name: t.name,
      description: t.description || "",
      inputSchema: t.parameters || { type: "object", properties: {} }
    }))
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = cafe.tools.find((t) => t.name === name);
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

// ---- Start ----

const transport = new StdioServerTransport();
await server.connect(transport);

// ---- Graceful shutdown ----

async function shutdown() {
  await cafe.dispose();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
