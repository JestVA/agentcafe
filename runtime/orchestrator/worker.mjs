import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildMentionReply,
  isMentionInboxItem,
  isTaskInboxItem,
  selectThreadMessages,
  shouldRouteMention
} from "./loop.mjs";

const API_URL = String(process.env.ORCH_API_URL || process.env.AGENTCAFE_RUNTIME_API_URL || "http://127.0.0.1:3850").replace(/\/$/, "");
const API_KEY = String(
  process.env.ORCH_API_KEY || process.env.API_AUTH_TOKEN || process.env.AGENTCAFE_RUNTIME_API_KEY || ""
).trim();
const TENANT_ID = String(process.env.ORCH_TENANT_ID || process.env.AGENTCAFE_TENANT_ID || "default").trim() || "default";
const ROOM_ID = String(process.env.ORCH_ROOM_ID || process.env.AGENTCAFE_ROOM_ID || "main").trim() || "main";
const ACTOR_ID = String(process.env.ORCH_ACTOR_ID || process.env.AGENTCAFE_ACTOR_ID || "orchestrator").trim() || "orchestrator";
const STATE_FILE =
  process.env.ORCH_STATE_FILE ||
  path.resolve(`./runtime/data/orchestrator-state-${ACTOR_ID.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);

const HEARTBEAT_INTERVAL_MS = Math.max(5_000, Number(process.env.ORCH_HEARTBEAT_INTERVAL_MS || 30_000));
const PRESENCE_TTL_MS = Math.max(10_000, Number(process.env.ORCH_PRESENCE_TTL_MS || 120_000));
const IDLE_AFTER_MS = Math.max(15_000, Number(process.env.ORCH_IDLE_AFTER_MS || 5 * 60_000));
const POLL_INTERVAL_MS = Math.max(2_000, Number(process.env.ORCH_POLL_INTERVAL_MS || 20_000));
const READ_ONLY_COOLDOWN_MS = Math.max(5_000, Number(process.env.ORCH_READ_ONLY_COOLDOWN_MS || 60_000));
const MAX_CONTEXT_MESSAGES = Math.max(1, Math.min(Number(process.env.ORCH_MAX_CONTEXT_MESSAGES || 8), 20));
const MAX_REPLY_CHARS = Math.max(40, Math.min(Number(process.env.ORCH_MAX_REPLY_CHARS || 120), 500));
const INBOX_BATCH_LIMIT = Math.max(1, Math.min(Number(process.env.ORCH_INBOX_BATCH_LIMIT || 25), 200));
const RETRY_ATTEMPTS = Math.max(1, Math.min(Number(process.env.ORCH_RETRY_ATTEMPTS || 3), 8));
const RETRY_BASE_MS = Math.max(100, Number(process.env.ORCH_RETRY_BASE_MS || 300));
const TASK_AUTO_PROGRESS_MIN = Math.max(0, Math.min(Number(process.env.ORCH_TASK_AUTO_PROGRESS_MIN || 10), 100));
const METRICS_PUBLISH_INTERVAL_MS = Math.max(3_000, Number(process.env.ORCH_METRICS_PUBLISH_INTERVAL_MS || 15_000));
const METRICS_OBJECT_KEY =
  String(process.env.ORCH_METRICS_OBJECT_KEY || `orchestrator_metrics_${ACTOR_ID}`).trim() ||
  `orchestrator_metrics_${ACTOR_ID}`;

const STREAM_TYPES = parseCsvList(process.env.ORCH_STREAM_TYPES || "mention_created,task_assigned");
const ALLOWED_MENTION_SOURCES = parseCsvSet(process.env.ORCH_ALLOWED_MENTION_SOURCES);
const DENIED_MENTION_SOURCES = parseCsvSet(process.env.ORCH_DENIED_MENTION_SOURCES);
const ALLOWED_THREAD_PREFIXES = parseCsvList(process.env.ORCH_ALLOWED_THREAD_PREFIXES);

const REASON_CODES = {
  STARTUP: "RC_ORCH_STARTUP",
  MENTION_RECEIVED: "RC_ORCH_MENTION_RECEIVED",
  MENTION_ROUTED: "RC_ORCH_MENTION_ROUTED",
  TASK_RECEIVED: "RC_ORCH_TASK_RECEIVED",
  CONTEXT_FETCHED: "RC_ORCH_CONTEXT_FETCHED",
  REPLY_POSTED: "RC_ORCH_REPLY_POSTED",
  TASK_UPDATED: "RC_ORCH_TASK_UPDATED",
  INBOX_ACKED: "RC_ORCH_INBOX_ACKED",
  READ_ONLY: "RC_ORCH_READ_ONLY",
  METRICS_PUBLISH: "RC_ORCH_METRICS_PUBLISH",
  RETRY: "RC_ORCH_RETRY",
  ERROR: "RC_ORCH_ERROR"
};

class StateStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = {
      version: 2,
      cursor: 0,
      lastActivityAt: null,
      processedInboxIds: [],
      metrics: defaultMetrics()
    };
  }

  async init() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.state = {
        version: 2,
        cursor: Number(parsed?.cursor || 0),
        lastActivityAt: parsed?.lastActivityAt || null,
        processedInboxIds: Array.isArray(parsed?.processedInboxIds)
          ? parsed.processedInboxIds.map((item) => String(item)).filter(Boolean).slice(-1500)
          : [],
        metrics: normalizeMetrics(parsed?.metrics)
      };
    } catch {
      await this.persist();
    }
  }

  hasProcessed(inboxId) {
    return this.state.processedInboxIds.includes(String(inboxId || ""));
  }

  async setCursor(cursor) {
    const n = Number(cursor || 0);
    if (!Number.isFinite(n) || n <= this.state.cursor) {
      return;
    }
    this.state.cursor = n;
    await this.persist();
  }

  async markProcessed(inboxId) {
    const id = String(inboxId || "").trim();
    if (!id || this.state.processedInboxIds.includes(id)) {
      return;
    }
    this.state.processedInboxIds.push(id);
    if (this.state.processedInboxIds.length > 1500) {
      this.state.processedInboxIds = this.state.processedInboxIds.slice(-1500);
    }
    await this.persist();
  }

  async touchActivity() {
    this.state.lastActivityAt = new Date().toISOString();
    await this.persist();
  }

  async setMetrics(metrics) {
    this.state.metrics = normalizeMetrics(metrics);
    await this.persist();
  }

  async persist() {
    const dir = path.dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2), "utf8");
    await rename(tmp, this.filePath);
  }
}

class RuntimeApi {
  constructor({ baseUrl, apiKey }) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  async request(method, route, { query, body, idempotencyKey, retryable = false } = {}) {
    const url = new URL(`${this.baseUrl}${route}`);
    if (query && typeof query === "object") {
      for (const [key, value] of Object.entries(query)) {
        if (value == null || value === "") {
          continue;
        }
        url.searchParams.set(key, String(value));
      }
    }

    const headers = {
      accept: "application/json"
    };
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (idempotencyKey) {
      headers["idempotency-key"] = idempotencyKey;
    }

    return withRetry(
      async () => {
        const response = await fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body)
        });

        let payload = null;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }

        if (!response.ok || payload?.ok === false) {
          const code = payload?.error?.code || "ERR_HTTP";
          const message = payload?.error?.message || `${response.status} ${response.statusText}`;
          const error = new Error(message);
          error.code = code;
          error.status = response.status;
          error.details = payload?.error || null;
          throw error;
        }

        return payload;
      },
      {
        attempts: retryable ? RETRY_ATTEMPTS : 1,
        baseMs: RETRY_BASE_MS
      }
    );
  }

  async health() {
    return this.request("GET", "/healthz", { retryable: true });
  }

  async getPresence() {
    return this.request("GET", "/v1/presence", {
      query: {
        tenantId: TENANT_ID,
        roomId: ROOM_ID,
        actorId: ACTOR_ID
      },
      retryable: true
    });
  }

  async enterIfNeeded() {
    const presence = await this.getPresence();
    if (presence?.data?.presence?.status && presence.data.presence.status !== "inactive") {
      return;
    }

    await this.request("POST", "/v1/commands/enter", {
      idempotencyKey: `orch-enter-${TENANT_ID}-${ROOM_ID}-${ACTOR_ID}`,
      body: {
        tenantId: TENANT_ID,
        roomId: ROOM_ID,
        actorId: ACTOR_ID
      },
      retryable: true
    });
  }

  async heartbeat(status, correlationId = null) {
    return this.request("POST", "/v1/presence/heartbeat", {
      idempotencyKey: `orch-heartbeat-${ACTOR_ID}-${Date.now()}-${randomUUID().slice(0, 8)}`,
      body: {
        tenantId: TENANT_ID,
        roomId: ROOM_ID,
        actorId: ACTOR_ID,
        status,
        ttlMs: PRESENCE_TTL_MS,
        correlationId
      },
      retryable: true
    });
  }

  async listUnreadInbox() {
    return this.request("GET", "/v1/inbox", {
      query: {
        tenantId: TENANT_ID,
        roomId: ROOM_ID,
        actorId: ACTOR_ID,
        unreadOnly: true,
        order: "asc",
        limit: INBOX_BATCH_LIMIT
      },
      retryable: true
    });
  }

  async listAssignedTasks() {
    return this.request("GET", "/v1/tasks", {
      query: {
        tenantId: TENANT_ID,
        roomId: ROOM_ID,
        assigneeActorId: ACTOR_ID,
        limit: 100
      },
      retryable: true
    });
  }

  async getTask(taskId) {
    return this.request("GET", `/v1/tasks/${encodeURIComponent(taskId)}`, {
      query: {
        tenantId: TENANT_ID
      },
      retryable: true
    });
  }

  async patchTask(taskId, body, idempotencyKey) {
    return this.request("PATCH", `/v1/tasks/${encodeURIComponent(taskId)}`, {
      idempotencyKey,
      body,
      retryable: true
    });
  }

  async timelineConversation(limit = 50) {
    return this.request("GET", "/v1/timeline", {
      query: {
        tenantId: TENANT_ID,
        roomId: ROOM_ID,
        types: "conversation_message_posted",
        order: "desc",
        limit
      },
      retryable: true
    });
  }

  async postThreadReply({ text, threadId, sourceMessageId, sourceActorId, inboxId, correlationId }) {
    const mentions = sourceActorId ? [sourceActorId] : [];
    return this.request("POST", "/v1/conversations/messages", {
      idempotencyKey: `orch-reply-${ACTOR_ID}-${inboxId || sourceMessageId || randomUUID()}`,
      body: {
        tenantId: TENANT_ID,
        roomId: ROOM_ID,
        actorId: ACTOR_ID,
        text,
        threadId: threadId || sourceMessageId || undefined,
        parentMessageId: sourceMessageId || undefined,
        replyToMessageId: sourceMessageId || undefined,
        mentions,
        metadata: {
          orchestrator: {
            actorId: ACTOR_ID,
            source: "agentcafe-orchestrator"
          }
        },
        correlationId,
        causationId: sourceMessageId || undefined
      },
      retryable: true
    });
  }

  async ackInbox(item, correlationId = null) {
    return this.request("POST", `/v1/inbox/${encodeURIComponent(item.inboxId)}/ack`, {
      idempotencyKey: `orch-ack-${ACTOR_ID}-${item.inboxId}`,
      body: {
        tenantId: item.tenantId,
        roomId: item.roomId,
        actorId: ACTOR_ID,
        ackedBy: ACTOR_ID,
        correlationId
      },
      retryable: true
    });
  }

  async listMetricsObjects() {
    return this.request("GET", "/v1/objects", {
      query: {
        tenantId: TENANT_ID,
        roomId: ROOM_ID,
        objectType: "note",
        limit: 200
      },
      retryable: true
    });
  }

  async createMetricsObject({ title, content, data, idempotencyKey }) {
    return this.request("POST", "/v1/objects", {
      idempotencyKey,
      body: {
        tenantId: TENANT_ID,
        roomId: ROOM_ID,
        actorId: ACTOR_ID,
        objectType: "note",
        objectKey: METRICS_OBJECT_KEY,
        title,
        content,
        data,
        metadata: {
          orchestrator: {
            actorId: ACTOR_ID,
            source: "agentcafe-orchestrator"
          }
        }
      },
      retryable: true
    });
  }

  async patchMetricsObject(objectId, { title, content, data, idempotencyKey }) {
    return this.request("PATCH", `/v1/objects/${encodeURIComponent(objectId)}`, {
      idempotencyKey,
      body: {
        tenantId: TENANT_ID,
        actorId: ACTOR_ID,
        title,
        content,
        data,
        metadata: {
          orchestrator: {
            actorId: ACTOR_ID,
            source: "agentcafe-orchestrator"
          }
        }
      },
      retryable: true
    });
  }
}

class OrchestratorWorker {
  constructor({ api, state }) {
    this.api = api;
    this.state = state;
    this.status = "idle";
    this.readOnlyUntil = 0;
    this.processing = Promise.resolve();
    this.stopRequested = false;
    this.pollTimer = null;
    this.heartbeatTimer = null;
    this.idleTimer = null;
    this.metricsTimer = null;
    this.metricsObjectId = null;
    this.metricsPublishInFlight = false;
    this.metrics = normalizeMetrics(this.state.state?.metrics);
  }

  log(level, reasonCode, message, extra = {}) {
    const row = {
      ts: new Date().toISOString(),
      level,
      service: "agentcafe-orchestrator",
      actorId: ACTOR_ID,
      tenantId: TENANT_ID,
      roomId: ROOM_ID,
      reasonCode,
      message,
      ...extra
    };
    process.stdout.write(`${JSON.stringify(row)}\n`);
  }

  markActivity() {
    this.metrics.lastActionAt = new Date().toISOString();
  }

  bumpMetric(name, delta = 1) {
    const current = Number(this.metrics[name] || 0);
    this.metrics[name] = current + Number(delta || 0);
    this.markActivity();
  }

  recordError(error, context = {}) {
    this.bumpMetric("errors", 1);
    this.metrics.lastErrorCode = error?.code || null;
    this.metrics.lastErrorMessage = error?.message || String(error);
    this.log("warn", REASON_CODES.ERROR, "orchestrator error", {
      code: error?.code || null,
      error: error?.message || String(error),
      ...context
    });
  }

  async setStatus(status, correlationId = null) {
    if (this.status === status) {
      return;
    }
    this.status = status;
    try {
      await this.api.heartbeat(status, correlationId);
    } catch (error) {
      this.recordError(error, { phase: "set_status", status });
    }
  }

  inReadOnlyMode() {
    return Date.now() < this.readOnlyUntil;
  }

  async setReadOnly(error) {
    this.readOnlyUntil = Date.now() + READ_ONLY_COOLDOWN_MS;
    this.bumpMetric("readOnlyCooldowns", 1);
    await this.setStatus("idle");
    this.log("warn", REASON_CODES.READ_ONLY, "entering read-only cooldown", {
      until: new Date(this.readOnlyUntil).toISOString(),
      error: error?.message || null,
      code: error?.code || null
    });
    await this.publishMetrics({ force: true });
  }

  async bootstrap() {
    await this.state.init();
    this.metrics = normalizeMetrics(this.state.state?.metrics);
    await this.api.health();
    await this.api.enterIfNeeded();
    await this.setStatus("thinking");

    const [inbox, tasks] = await Promise.all([this.api.listUnreadInbox(), this.api.listAssignedTasks()]);
    const unreadMentions = (inbox?.data?.items || []).filter((item) => isMentionInboxItem(item, ACTOR_ID));
    const unreadTaskItems = (inbox?.data?.items || []).filter((item) => isTaskInboxItem(item, ACTOR_ID));
    const openTasks = (tasks?.data?.tasks || []).filter((task) => String(task.state || "").toLowerCase() !== "done");

    this.log("info", REASON_CODES.STARTUP, "orchestrator bootstrap complete", {
      cursor: this.state.state.cursor,
      unreadMentions: unreadMentions.length,
      unreadTaskItems: unreadTaskItems.length,
      openTasks: openTasks.length,
      allowedSources: [...ALLOWED_MENTION_SOURCES],
      deniedSources: [...DENIED_MENTION_SOURCES],
      allowedThreadPrefixes: ALLOWED_THREAD_PREFIXES
    });

    await this.processInbox("bootstrap");
    await this.processOpenTasks("bootstrap");
    await this.setStatus("idle");
    await this.publishMetrics({ force: true });
  }

  startBackgroundLoops() {
    this.pollTimer = setInterval(() => {
      this.enqueueProcess("poll");
    }, POLL_INTERVAL_MS);

    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.api.heartbeat(this.status);
      } catch (error) {
        this.recordError(error, { phase: "heartbeat_timer" });
      }
    }, HEARTBEAT_INTERVAL_MS);

    this.idleTimer = setInterval(async () => {
      const lastActivityMs = Date.parse(this.state.state.lastActivityAt || 0);
      if (!Number.isFinite(lastActivityMs)) {
        return;
      }
      if (Date.now() - lastActivityMs >= IDLE_AFTER_MS && this.status !== "idle") {
        await this.setStatus("idle");
      }
    }, Math.min(IDLE_AFTER_MS, 30_000));

    this.metricsTimer = setInterval(() => {
      void this.publishMetrics();
    }, METRICS_PUBLISH_INTERVAL_MS);
  }

  stopBackgroundLoops() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }
  }

  enqueueProcess(trigger) {
    this.processing = this.processing
      .then(async () => {
        await this.processInbox(trigger);
        await this.processOpenTasks(trigger);
      })
      .catch((error) => {
        this.recordError(error, { trigger, phase: "enqueue_process" });
      });
  }

  async processInbox(trigger) {
    const response = await this.api.listUnreadInbox();
    const items = Array.isArray(response?.data?.items) ? response.data.items : [];

    for (const item of items) {
      if (this.state.hasProcessed(item.inboxId)) {
        continue;
      }

      if (isMentionInboxItem(item, ACTOR_ID)) {
        await this.handleMentionItem(item, trigger);
        continue;
      }

      if (isTaskInboxItem(item, ACTOR_ID)) {
        await this.handleTaskInboxItem(item, trigger);
      }
    }
  }

  async processOpenTasks(trigger) {
    const payload = await this.api.listAssignedTasks();
    const tasks = Array.isArray(payload?.data?.tasks) ? payload.data.tasks : [];

    for (const task of tasks) {
      const patch = buildTaskAutoPatch(task);
      if (!patch) {
        continue;
      }

      const correlationId = `orch-${ACTOR_ID}-task-passive-${task.taskId}`;
      try {
        await this.setStatus("busy", correlationId);
        await this.api.patchTask(
          task.taskId,
          {
            tenantId: TENANT_ID,
            actorId: ACTOR_ID,
            ...patch,
            metadata: {
              ...(task.metadata && typeof task.metadata === "object" ? task.metadata : {}),
              orchestrator: {
                actorId: ACTOR_ID,
                source: "agentcafe-orchestrator",
                trigger,
                mode: "passive_scan"
              }
            },
            correlationId
          },
          `orch-task-passive-${ACTOR_ID}-${task.taskId}-${patch.state}-${patch.progress}`
        );
        this.bumpMetric("taskUpdates", 1);
        await this.state.touchActivity();
        this.log("info", REASON_CODES.TASK_UPDATED, "task auto-progressed", {
          trigger,
          taskId: task.taskId,
          state: patch.state,
          progress: patch.progress,
          mode: "passive_scan"
        });
      } catch (error) {
        const permanent = isPermanentWriteError(error);
        if (permanent) {
          await this.setReadOnly(error);
        } else {
          this.recordError(error, {
            trigger,
            phase: "passive_task_patch",
            taskId: task.taskId
          });
        }
      } finally {
        await this.setStatus("idle", correlationId);
      }
    }
  }

  async handleMentionItem(item, trigger) {
    const correlationId = `orch-${ACTOR_ID}-${item.inboxId}`;
    const sourceActorId = item.sourceActorId || item.payload?.sourceActorId || null;
    const sourceMessageId = item.payload?.sourceMessageId || null;
    const threadId = item.threadId || item.payload?.threadId || sourceMessageId || null;

    this.log("info", REASON_CODES.MENTION_RECEIVED, "processing mention inbox item", {
      trigger,
      inboxId: item.inboxId,
      sourceEventId: item.sourceEventId,
      sourceActorId,
      threadId
    });

    if (this.inReadOnlyMode()) {
      await this.ackAndMark(item, correlationId, "read_only");
      return;
    }

    const routed = shouldRouteMention({
      sourceActorId,
      threadId,
      sourceMessageId,
      allowedSources: ALLOWED_MENTION_SOURCES,
      deniedSources: DENIED_MENTION_SOURCES,
      allowedThreadPrefixes: ALLOWED_THREAD_PREFIXES
    });

    if (!routed.allow) {
      this.bumpMetric("routingSkips", 1);
      this.log("info", REASON_CODES.MENTION_ROUTED, "mention skipped by routing rules", {
        trigger,
        inboxId: item.inboxId,
        sourceActorId,
        threadId,
        reason: routed.reason
      });
      await this.ackAndMark(item, correlationId, routed.reason || "routing_skip");
      return;
    }

    await this.setStatus("thinking", correlationId);

    const timeline = await this.api.timelineConversation(60);
    const threadMessages = selectThreadMessages(timeline?.data?.events || [], {
      threadId,
      sourceMessageId,
      limit: MAX_CONTEXT_MESSAGES
    });

    this.log("info", REASON_CODES.CONTEXT_FETCHED, "thread context resolved", {
      inboxId: item.inboxId,
      threadId,
      messageCount: threadMessages.length
    });

    const text = buildMentionReply({
      actorId: ACTOR_ID,
      sourceActorId,
      threadMessages,
      maxChars: MAX_REPLY_CHARS
    });

    try {
      await this.setStatus("busy", correlationId);
      await this.api.postThreadReply({
        text,
        threadId,
        sourceMessageId,
        sourceActorId,
        inboxId: item.inboxId,
        correlationId
      });
      this.bumpMetric("replies", 1);
      this.log("info", REASON_CODES.REPLY_POSTED, "posted thread reply", {
        inboxId: item.inboxId,
        threadId,
        sourceActorId
      });
    } catch (error) {
      const permanent = isPermanentWriteError(error);
      if (!permanent) {
        this.recordError(error, {
          trigger,
          phase: "post_thread_reply",
          inboxId: item.inboxId
        });
        await this.setStatus("idle", correlationId);
        return;
      }

      await this.setReadOnly(error);
      await this.ackAndMark(item, correlationId, "reply_blocked");
      return;
    }

    await this.ackAndMark(item, correlationId, "reply_done");
    await this.setStatus("idle", correlationId);
  }

  async handleTaskInboxItem(item, trigger) {
    const correlationId = `orch-${ACTOR_ID}-${item.inboxId}`;
    const taskId = String(item.payload?.taskId || "").trim();

    this.log("info", REASON_CODES.TASK_RECEIVED, "processing task inbox item", {
      trigger,
      inboxId: item.inboxId,
      taskId
    });

    if (!taskId) {
      await this.ackAndMark(item, correlationId, "task_missing_id");
      return;
    }

    if (this.inReadOnlyMode()) {
      await this.ackAndMark(item, correlationId, "read_only");
      return;
    }

    let task;
    try {
      const current = await this.api.getTask(taskId);
      task = current?.data?.task || null;
    } catch (error) {
      if (error?.code === "ERR_NOT_FOUND") {
        await this.ackAndMark(item, correlationId, "task_not_found");
        return;
      }
      this.recordError(error, {
        trigger,
        phase: "get_task",
        inboxId: item.inboxId,
        taskId
      });
      return;
    }

    const patch = buildTaskAutoPatch(task);

    try {
      if (patch) {
        await this.setStatus("busy", correlationId);
        await this.api.patchTask(
          taskId,
          {
            tenantId: TENANT_ID,
            actorId: ACTOR_ID,
            ...patch,
            metadata: {
              ...(task?.metadata && typeof task.metadata === "object" ? task.metadata : {}),
              orchestrator: {
                actorId: ACTOR_ID,
                source: "agentcafe-orchestrator",
                trigger,
                mode: "inbox_assignment"
              }
            },
            correlationId
          },
          `orch-task-inbox-${ACTOR_ID}-${item.inboxId}`
        );
        this.bumpMetric("taskUpdates", 1);
        this.log("info", REASON_CODES.TASK_UPDATED, "task updated from inbox assignment", {
          trigger,
          taskId,
          inboxId: item.inboxId,
          state: patch.state,
          progress: patch.progress,
          mode: "inbox_assignment"
        });
      }
    } catch (error) {
      const permanent = isPermanentWriteError(error);
      if (!permanent) {
        this.recordError(error, {
          trigger,
          phase: "patch_task",
          inboxId: item.inboxId,
          taskId
        });
        await this.setStatus("idle", correlationId);
        return;
      }
      await this.setReadOnly(error);
      await this.ackAndMark(item, correlationId, "task_blocked");
      return;
    }

    await this.ackAndMark(item, correlationId, "task_done");
    await this.setStatus("idle", correlationId);
  }

  async ackAndMark(item, correlationId, reason = null) {
    await this.api.ackInbox(item, correlationId);
    await this.state.markProcessed(item.inboxId);
    await this.state.touchActivity();
    this.bumpMetric("acks", 1);
    this.log("info", REASON_CODES.INBOX_ACKED, "acked inbox item", {
      inboxId: item.inboxId,
      topic: item.topic,
      reason
    });
    await this.publishMetrics();
  }

  metricsSummaryText(snapshot) {
    return [
      `replies=${snapshot.replies}`,
      `acks=${snapshot.acks}`,
      `taskUpdates=${snapshot.taskUpdates}`,
      `routingSkips=${snapshot.routingSkips}`,
      `readOnlyCooldowns=${snapshot.readOnlyCooldowns}`,
      `errors=${snapshot.errors}`
    ].join(" | ");
  }

  buildMetricsSnapshot() {
    return {
      actorId: ACTOR_ID,
      tenantId: TENANT_ID,
      roomId: ROOM_ID,
      status: this.status,
      readOnly: this.inReadOnlyMode(),
      readOnlyUntil: this.inReadOnlyMode() ? new Date(this.readOnlyUntil).toISOString() : null,
      cursor: this.state.state.cursor,
      lastActivityAt: this.state.state.lastActivityAt || null,
      updatedAt: new Date().toISOString(),
      ...normalizeMetrics(this.metrics)
    };
  }

  async publishMetrics({ force = false } = {}) {
    if (!force && this.metricsPublishInFlight) {
      return;
    }
    this.metricsPublishInFlight = true;

    try {
      const snapshot = this.buildMetricsSnapshot();
      const title = `Orchestrator ${ACTOR_ID}`;
      const content = this.metricsSummaryText(snapshot);
      let objectId = this.metricsObjectId;

      if (!objectId) {
        const list = await this.api.listMetricsObjects();
        const objects = Array.isArray(list?.data?.objects) ? list.data.objects : [];
        const existing = objects.find(
          (item) => item.objectKey === METRICS_OBJECT_KEY && item.objectType === "note"
        );
        if (existing?.objectId) {
          objectId = existing.objectId;
          this.metricsObjectId = existing.objectId;
        }
      }

      if (!objectId) {
        const created = await this.api.createMetricsObject({
          title,
          content,
          data: snapshot,
          idempotencyKey: `orch-metrics-create-${ACTOR_ID}`
        });
        const nextId = created?.data?.object?.objectId || null;
        if (nextId) {
          this.metricsObjectId = nextId;
        }
      } else {
        await this.api.patchMetricsObject(objectId, {
          title,
          content,
          data: snapshot,
          idempotencyKey: `orch-metrics-patch-${ACTOR_ID}-${Date.now()}`
        });
      }

      this.metrics.lastPublishedAt = snapshot.updatedAt;
      await this.state.setMetrics(this.metrics);
      this.log("info", REASON_CODES.METRICS_PUBLISH, "published orchestrator metrics", {
        objectKey: METRICS_OBJECT_KEY,
        objectId: this.metricsObjectId,
        summary: content
      });
    } catch (error) {
      this.recordError(error, { phase: "publish_metrics" });
    } finally {
      this.metricsPublishInFlight = false;
    }
  }

  async runStream() {
    while (!this.stopRequested) {
      try {
        await this.streamOnce();
      } catch (error) {
        this.recordError(error, { phase: "stream_once" });
        await sleep(1500);
      }
    }
  }

  async streamOnce() {
    const url = new URL(`${API_URL}/v1/streams/market-events`);
    url.searchParams.set("tenantId", TENANT_ID);
    url.searchParams.set("roomId", ROOM_ID);
    url.searchParams.set("types", STREAM_TYPES.join(","));
    if (this.state.state.cursor > 0) {
      url.searchParams.set("cursor", String(this.state.state.cursor));
    }

    const headers = {
      accept: "text/event-stream"
    };
    if (API_KEY) {
      headers["x-api-key"] = API_KEY;
    }

    const response = await fetch(url, { headers });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      const error = new Error(`stream request failed (${response.status}) ${text}`.trim());
      error.status = response.status;
      throw error;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    const reader = response.body.getReader();

    while (!this.stopRequested) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() || "";

      for (const chunk of chunks) {
        const event = parseSseChunk(chunk);
        if (!event) {
          continue;
        }
        const eventCursor = Number(event.id || event.data?.sequence || 0);
        if (Number.isFinite(eventCursor) && eventCursor > 0) {
          await this.state.setCursor(eventCursor);
        }

        if (event.type === "mention_created") {
          const mentioned = String(event.data?.payload?.mentionedActorId || "").trim();
          if (mentioned && mentioned === ACTOR_ID) {
            this.enqueueProcess("stream_mention");
          }
          continue;
        }

        if (event.type === "task_assigned") {
          const toAssigneeActorId = String(event.data?.payload?.toAssigneeActorId || "").trim();
          if (toAssigneeActorId && toAssigneeActorId === ACTOR_ID) {
            this.enqueueProcess("stream_task_assignment");
          }
        }
      }
    }

    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }

  async stop() {
    this.stopRequested = true;
    this.stopBackgroundLoops();
    await this.processing;
    await this.setStatus("idle");
    await this.publishMetrics({ force: true });
  }
}

function parseSseChunk(chunk) {
  const text = String(chunk || "").trim();
  if (!text) {
    return null;
  }

  let id = null;
  let type = null;
  const dataLines = [];

  for (const line of text.split("\n")) {
    if (line.startsWith("id:")) {
      id = line.slice(3).trim();
      continue;
    }
    if (line.startsWith("event:")) {
      type = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }

  let data = null;
  if (dataLines.length > 0) {
    try {
      data = JSON.parse(dataLines.join("\n"));
    } catch {
      data = null;
    }
  }

  return {
    id,
    type,
    data
  };
}

function parseCsvList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseCsvSet(value) {
  return new Set(parseCsvList(value));
}

function defaultMetrics() {
  return {
    replies: 0,
    acks: 0,
    taskUpdates: 0,
    routingSkips: 0,
    readOnlyCooldowns: 0,
    errors: 0,
    lastActionAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    lastPublishedAt: null
  };
}

function normalizeMetrics(input) {
  return {
    ...defaultMetrics(),
    ...(input && typeof input === "object" ? input : {})
  };
}

function buildTaskAutoPatch(task) {
  if (!task || typeof task !== "object") {
    return null;
  }
  const state = String(task.state || "open").trim().toLowerCase();
  if (state === "done") {
    return null;
  }
  const currentProgress = Number(task.progress || 0);
  const desiredState = state === "open" ? "active" : state;
  const desiredProgress = Math.max(0, Math.min(100, Math.max(currentProgress, TASK_AUTO_PROGRESS_MIN)));

  const stateChanged = desiredState !== state;
  const progressChanged = desiredProgress !== currentProgress;
  if (!stateChanged && !progressChanged) {
    return null;
  }

  return {
    state: desiredState,
    progress: desiredProgress
  };
}

function isPermanentWriteError(error) {
  return (
    error?.code === "ERR_FORBIDDEN" ||
    error?.code === "ERR_OPERATOR_OVERRIDE_BLOCKED" ||
    error?.code === "ERR_MODERATION_BLOCKED" ||
    error?.code === "ERR_PLAN_FEATURE_DISABLED"
  );
}

async function withRetry(fn, { attempts = 3, baseMs = 250 } = {}) {
  let lastError = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || 0);
      const retryable = status >= 500 || status === 0 || error?.code === "ERR_HTTP";
      if (!retryable || i >= attempts) {
        throw error;
      }
      const waitMs = baseMs * i;
      process.stdout.write(
        `${JSON.stringify({
          ts: new Date().toISOString(),
          level: "warn",
          service: "agentcafe-orchestrator",
          reasonCode: REASON_CODES.RETRY,
          message: "retrying failed request",
          attempt: i,
          waitMs,
          error: error?.message || String(error),
          code: error?.code || null,
          status: error?.status || null
        })}\n`
      );
      await sleep(waitMs);
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const api = new RuntimeApi({
  baseUrl: API_URL,
  apiKey: API_KEY
});
const state = new StateStore(STATE_FILE);
const worker = new OrchestratorWorker({ api, state });

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  process.stdout.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      service: "agentcafe-orchestrator",
      reasonCode: REASON_CODES.STARTUP,
      message: "shutdown requested",
      signal
    })}\n`
  );
  await worker.stop();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

(async () => {
  await worker.bootstrap();
  worker.startBackgroundLoops();
  await worker.runStream();
})().catch(async (error) => {
  process.stderr.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      service: "agentcafe-orchestrator",
      reasonCode: REASON_CODES.ERROR,
      message: "fatal orchestrator failure",
      error: error?.message || String(error),
      code: error?.code || null,
      status: error?.status || null
    })}\n`
  );
  try {
    await worker.stop();
  } catch {
    // ignore
  }
  process.exit(1);
});
