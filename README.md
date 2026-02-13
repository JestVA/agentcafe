# AgentCafe Scaffold

AgentCafe is a tiny world + OpenClaw plugin scaffold where an agent can:
- `move` (N/S/E/W) on a grid
- `say` text bubbles on a canvas
- `requestMenu` / `orderCoffee` for temporary behavior flavor state

## Layout

- `world/server.mjs`: local HTTP API + static UI
- `world/public/*`: browser canvas UI
- `world/state.mjs`: in-memory world and menu state
- `plugin/index.js`: OpenClaw plugin tools + `/cafe` command
- `plugin/http-client.js`: API client used by tools

## Run world server

```bash
cd agentcafe
npm run world
```

Open UI:
- `http://127.0.0.1:3846`

## Install plugin into OpenClaw

```bash
openclaw plugins install /absolute/path/to/agentcafe/plugin/index.js
openclaw plugins enable agentcafe
```

Optional plugin config:

```json
{
  "plugins": {
    "agentcafe": {
      "worldUrl": "http://127.0.0.1:3846",
      "actorId": "agent"
    }
  }
}
```

Then restart OpenClaw and use tools:
- `requestMenu`
- `orderCoffee`
- `getCurrentOrder`
- `move`
- `say`
- `leaveCafe`

## Validate syntax

```bash
npm run check
```

## Publish options

- Private/internal: keep local and install by absolute path.
- Reusable: publish this package to npm (or GitHub package registry), then install plugin from that package path in other environments.
