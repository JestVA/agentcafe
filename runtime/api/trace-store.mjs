import { randomUUID } from "node:crypto";

export const REASON_CODES = {
  RC_REQUEST_RECEIVED: "RC_REQUEST_RECEIVED",
  RC_RATE_LIMIT_OK: "RC_RATE_LIMIT_OK",
  RC_IDEMPOTENCY_NEW: "RC_IDEMPOTENCY_NEW",
  RC_IDEMPOTENCY_REPLAY: "RC_IDEMPOTENCY_REPLAY",
  RC_EVENT_APPEND_OK: "RC_EVENT_APPEND_OK",
  RC_EVENT_STREAM_SUBSCRIBED: "RC_EVENT_STREAM_SUBSCRIBED",
  RC_SNAPSHOT_CREATED: "RC_SNAPSHOT_CREATED",
  RC_SNAPSHOT_READ: "RC_SNAPSHOT_READ",
  RC_INTENT_PLANNED: "RC_INTENT_PLANNED",
  RC_INTENT_EXECUTED: "RC_INTENT_EXECUTED",
  RC_OPERATOR_OVERRIDE_BLOCKED: "RC_OPERATOR_OVERRIDE_BLOCKED",
  RC_MODERATION_BLOCKED: "RC_MODERATION_BLOCKED",
  RC_VALIDATION_ERROR: "RC_VALIDATION_ERROR",
  RC_INTERNAL_ERROR: "RC_INTERNAL_ERROR"
};

export class InMemoryTraceStore {
  constructor({ maxTraces = 2000, maxSteps = 80 } = {}) {
    this.maxTraces = maxTraces;
    this.maxSteps = maxSteps;
    this.byCorrelationId = new Map();
    this.order = [];
  }

  start({ requestId, correlationId, route, method, actorId, tenantId, roomId }) {
    const corr = correlationId || randomUUID();
    const trace = {
      traceId: randomUUID(),
      correlationId: corr,
      requestId,
      route,
      method,
      actorId: actorId || null,
      tenantId: tenantId || null,
      roomId: roomId || null,
      status: "in_progress",
      startedAt: new Date().toISOString(),
      endedAt: null,
      steps: []
    };

    this.byCorrelationId.set(corr, trace);
    this.order.push(corr);
    if (this.order.length > this.maxTraces) {
      const stale = this.order.shift();
      if (stale) {
        this.byCorrelationId.delete(stale);
      }
    }
    return trace;
  }

  step(correlationId, code, details = {}) {
    const trace = this.byCorrelationId.get(correlationId);
    if (!trace) {
      return;
    }
    trace.steps.push({
      ts: new Date().toISOString(),
      code,
      details
    });
    if (trace.steps.length > this.maxSteps) {
      trace.steps.splice(0, trace.steps.length - this.maxSteps);
    }
  }

  finish(correlationId, status, details = {}) {
    const trace = this.byCorrelationId.get(correlationId);
    if (!trace) {
      return;
    }
    trace.status = status;
    trace.endedAt = new Date().toISOString();
    if (Object.keys(details).length) {
      this.step(correlationId, status === "error" ? REASON_CODES.RC_INTERNAL_ERROR : REASON_CODES.RC_EVENT_APPEND_OK, details);
    }
  }

  get(correlationId) {
    const trace = this.byCorrelationId.get(correlationId);
    if (!trace) {
      return null;
    }
    return {
      ...trace,
      steps: trace.steps.map((step) => ({ ...step }))
    };
  }
}
