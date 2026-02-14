export const OPERATOR_ACTIONS = Object.freeze({
  PAUSE_ROOM: "pause_room",
  RESUME_ROOM: "resume_room",
  MUTE_AGENT: "mute_agent",
  UNMUTE_AGENT: "unmute_agent",
  FORCE_LEAVE: "force_leave"
});

const ACTION_SET = new Set(Object.values(OPERATOR_ACTIONS));
const SPEAK_ACTIONS = new Set(["say", "conversation_message"]);

function toKey(actorId) {
  return String(actorId || "").trim();
}

export function isOperatorAction(action) {
  return ACTION_SET.has(String(action || "").trim());
}

export function evaluateOperatorBlock(state, { actorId, action } = {}) {
  const who = toKey(actorId);
  if (!who) {
    return { blocked: false, reasonCode: null, details: {} };
  }
  const act = String(action || "").trim();

  if (state?.roomPaused && act !== "leave") {
    return {
      blocked: true,
      reasonCode: "ROOM_PAUSED",
      details: {
        actorId: who,
        action: act,
        pausedBy: state.pausedBy || null,
        pausedAt: state.pausedAt || null
      }
    };
  }

  if (SPEAK_ACTIONS.has(act) && state?.mutedActors && state.mutedActors[who]) {
    const muted = state.mutedActors[who];
    return {
      blocked: true,
      reasonCode: "ACTOR_MUTED",
      details: {
        actorId: who,
        action: act,
        mutedBy: muted.mutedBy || null,
        mutedAt: muted.mutedAt || null,
        reason: muted.reason || null
      }
    };
  }

  return { blocked: false, reasonCode: null, details: {} };
}
