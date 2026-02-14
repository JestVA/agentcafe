const MAX_SCORE = 100;

function gradeFor(score) {
  if (score >= 80) {
    return "excellent";
  }
  if (score >= 60) {
    return "good";
  }
  if (score >= 35) {
    return "fair";
  }
  return "early";
}

export function calculateCollaborationScore(events = []) {
  const contributors = new Set();
  const metrics = {
    tasksCompleted: 0,
    coordinationActions: 0,
    objectEdits: 0,
    conversationTurns: 0,
    contributors: 0
  };

  for (const event of events) {
    const type = String(event?.type || "");
    const actorId = String(event?.actorId || "").trim();
    if (actorId) {
      contributors.add(actorId);
    }

    if (type === "task_completed") {
      metrics.tasksCompleted += 1;
    } else if (type === "task_assigned") {
      metrics.coordinationActions += 1;
    } else if (type === "shared_object_created" || type === "shared_object_updated") {
      metrics.objectEdits += 1;
    } else if (type === "conversation_message_posted") {
      metrics.conversationTurns += 1;
    }
  }

  metrics.contributors = contributors.size;

  const rawScore =
    metrics.tasksCompleted * 30 +
    metrics.coordinationActions * 10 +
    metrics.objectEdits * 3 +
    Math.min(40, metrics.conversationTurns) * 0.5 +
    Math.max(0, metrics.contributors - 1) * 4;

  const score = Math.round(Math.min(MAX_SCORE, rawScore) * 100) / 100;
  return {
    score,
    grade: gradeFor(score),
    metrics
  };
}
