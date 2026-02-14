import { AppError } from "../shared/errors.mjs";

const TABLE_COORDS = {
  table_1: { x: 2, y: 2 },
  table_2: { x: 6, y: 2 },
  table_3: { x: 10, y: 2 },
  table_4: { x: 14, y: 2 },
  table_5: { x: 2, y: 6 },
  table_6: { x: 6, y: 6 },
  table_7: { x: 10, y: 6 },
  table_8: { x: 14, y: 6 }
};

function actorKey(tenantId, roomId, actorId) {
  return `${tenantId}:${roomId}:${actorId}`;
}

export class IntentPlanner {
  constructor() {
    this.actorPositions = new Map();
  }

  getPosition({ tenantId, roomId, actorId }) {
    const key = actorKey(tenantId, roomId, actorId);
    const existing = this.actorPositions.get(key);
    if (existing) {
      return { ...existing };
    }
    const seed = { x: 10, y: 6 };
    this.actorPositions.set(key, seed);
    return { ...seed };
  }

  setPosition({ tenantId, roomId, actorId, x, y }) {
    const key = actorKey(tenantId, roomId, actorId);
    this.actorPositions.set(key, { x, y });
  }

  resolveTarget(intent, payload) {
    if (intent === "sit_at_table") {
      const tableId = payload.tableId;
      if (typeof tableId !== "string" || !tableId.trim()) {
        throw new AppError("ERR_MISSING_FIELD", "Missing required field: tableId", { field: "tableId" });
      }
      const target = TABLE_COORDS[tableId];
      if (!target) {
        throw new AppError("ERR_VALIDATION", `Unknown table id: ${tableId}`, { code: "ERR_UNKNOWN_TABLE", tableId });
      }
      return {
        target,
        label: tableId
      };
    }

    if (intent === "navigate_to") {
      const x = Number(payload.x);
      const y = Number(payload.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new AppError("ERR_VALIDATION", "navigate_to requires numeric x/y", {
          code: "ERR_OUT_OF_BOUNDS",
          x: payload.x,
          y: payload.y
        });
      }
      return {
        target: { x: Math.max(0, Math.min(19, Math.round(x))), y: Math.max(0, Math.min(11, Math.round(y))) },
        label: `(${Math.round(x)}, ${Math.round(y)})`
      };
    }

    throw new AppError("ERR_UNSUPPORTED_ACTION", `Unsupported intent: ${intent}`, { intent }, 404);
  }

  planPath(from, to) {
    const moves = [];
    const dx = to.x - from.x;
    const dy = to.y - from.y;

    if (dx > 0) {
      moves.push({ direction: "E", steps: dx });
    } else if (dx < 0) {
      moves.push({ direction: "W", steps: Math.abs(dx) });
    }

    if (dy > 0) {
      moves.push({ direction: "S", steps: dy });
    } else if (dy < 0) {
      moves.push({ direction: "N", steps: Math.abs(dy) });
    }

    return moves;
  }
}
