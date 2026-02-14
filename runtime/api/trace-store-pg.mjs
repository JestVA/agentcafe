import { InMemoryTraceStore } from "./trace-store.mjs";

function ts(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function mapTraceRow(row) {
  if (!row) {
    return null;
  }
  return {
    traceId: row.trace_id,
    correlationId: row.correlation_id,
    requestId: row.request_id,
    route: row.route,
    method: row.method,
    actorId: row.actor_id || null,
    tenantId: row.tenant_id || null,
    roomId: row.room_id || null,
    status: row.status,
    startedAt: ts(row.started_at),
    endedAt: ts(row.ended_at)
  };
}

function mapStepRows(rows = []) {
  return rows.map((row) => ({
    ts: ts(row.ts),
    code: row.code,
    details: row.details && typeof row.details === "object" ? row.details : {}
  }));
}

export class PgTraceStore extends InMemoryTraceStore {
  constructor({ pool, maxTraces = 2000, maxSteps = 80 } = {}) {
    super({ maxTraces, maxSteps });
    this.pool = pool;
    this.writeQueue = Promise.resolve();
  }

  async init() {
    return true;
  }

  enqueue(task) {
    this.writeQueue = this.writeQueue
      .then(task)
      .catch((error) => {
        process.stderr.write(
          `[api][trace-store-pg] write failed: ${error instanceof Error ? error.message : String(error)}\n`
        );
      });
  }

  start(input) {
    const trace = super.start(input);
    this.enqueue(async () => {
      await this.pool.query(
        `
        INSERT INTO traces (
          trace_id, correlation_id, request_id, route, method, actor_id, tenant_id, room_id, status, started_at
        ) VALUES (
          $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz
        )
        ON CONFLICT (correlation_id)
        DO UPDATE SET
          trace_id = EXCLUDED.trace_id,
          request_id = EXCLUDED.request_id,
          route = EXCLUDED.route,
          method = EXCLUDED.method,
          actor_id = EXCLUDED.actor_id,
          tenant_id = EXCLUDED.tenant_id,
          room_id = EXCLUDED.room_id,
          status = EXCLUDED.status,
          started_at = EXCLUDED.started_at,
          ended_at = NULL,
          updated_at = now()
        `,
        [
          trace.traceId,
          trace.correlationId,
          trace.requestId,
          trace.route,
          trace.method,
          trace.actorId,
          trace.tenantId,
          trace.roomId,
          trace.status,
          trace.startedAt
        ]
      );
    });
    return trace;
  }

  step(correlationId, code, details = {}) {
    super.step(correlationId, code, details);
    const trace = this.byCorrelationId.get(correlationId);
    if (!trace || !trace.steps.length) {
      return;
    }
    const latest = trace.steps[trace.steps.length - 1];
    this.enqueue(async () => {
      await this.pool.query(
        `
        INSERT INTO trace_steps (
          correlation_id, ts, code, details
        ) VALUES (
          $1, $2::timestamptz, $3, $4::jsonb
        )
        `,
        [correlationId, latest.ts, code, JSON.stringify(details || {})]
      );
    });
  }

  finish(correlationId, status, details = {}) {
    super.finish(correlationId, status, details);
    const trace = this.byCorrelationId.get(correlationId);
    if (!trace) {
      return;
    }
    this.enqueue(async () => {
      await this.pool.query(
        `
        UPDATE traces
        SET status = $2, ended_at = $3::timestamptz, updated_at = now()
        WHERE correlation_id = $1
        `,
        [correlationId, status, trace.endedAt || new Date().toISOString()]
      );
    });
  }

  async get(correlationId) {
    const local = super.get(correlationId);
    if (local) {
      return local;
    }

    const traceResult = await this.pool.query(
      `
      SELECT
        trace_id, correlation_id, request_id, route, method, actor_id, tenant_id, room_id, status, started_at, ended_at
      FROM traces
      WHERE correlation_id = $1
      LIMIT 1
      `,
      [correlationId]
    );
    const trace = mapTraceRow(traceResult.rows[0]);
    if (!trace) {
      return null;
    }

    const stepsResult = await this.pool.query(
      `
      SELECT ts, code, details
      FROM trace_steps
      WHERE correlation_id = $1
      ORDER BY step_seq DESC
      LIMIT $2
      `,
      [correlationId, this.maxSteps]
    );
    const steps = mapStepRows(stepsResult.rows).reverse();
    return {
      ...trace,
      steps
    };
  }
}
