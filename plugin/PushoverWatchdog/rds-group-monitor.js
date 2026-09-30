'use strict';

const BASE_INTERRUPTION_UNREADABLE_FRAMES = 4;
const INTERRUPTION_WINDOW_MS = 60_000;
const DEFAULT_INTERRUPTION_EVENTS_PER_MINUTE = 1;
const MAX_INTERRUPTION_EVENTS_PER_MINUTE = 600;
const MAX_TRACKED_INTERRUPTION_EVENTS = 1024;

function normalizeInterruptionEventsPerMinute(value, fallback = DEFAULT_INTERRUPTION_EVENTS_PER_MINUTE) {
  const fallbackValue = Number.isFinite(Number(fallback))
    ? Math.trunc(Number(fallback))
    : DEFAULT_INTERRUPTION_EVENTS_PER_MINUTE;
  const numericValue = Number(value);
  const normalized = Number.isFinite(numericValue) ? Math.trunc(numericValue) : fallbackValue;
  return Math.max(1, Math.min(MAX_INTERRUPTION_EVENTS_PER_MINUTE, normalized));
}


function resetRdsGroupInterruptionState(state) {
  state.rdsGroupUnreadableStreak = 0;
  state.rdsGroupInterruptionEventTimes = [];
}

function advanceRdsGroupInterruptionState(state, events, threshold = BASE_INTERRUPTION_UNREADABLE_FRAMES) {
  const result = { thresholdReached: false };
  const limit = Math.max(1, Math.trunc(Number(threshold) || BASE_INTERRUPTION_UNREADABLE_FRAMES));

  for (const event of events || []) {
    if (event?.usable) {
      state.rdsGroupUnreadableStreak = 0;
      continue;
    }

    if (!state.rdsGroupArmed) {
      state.rdsGroupUnreadableStreak = 0;
      continue;
    }

    state.rdsGroupUnreadableStreak = Math.min(1_000_000_000, state.rdsGroupUnreadableStreak + 1);
    if (state.rdsGroupUnreadableStreak === limit) result.thresholdReached = true;
  }

  return result;
}

function registerInterruptionEvent(timestamps, nowMs, threshold) {
  const now = Number(nowMs);
  if (!Number.isFinite(now) || now < 0) {
    return { timestamps: [], count: 0, thresholdReached: false };
  }

  const cutoff = now - INTERRUPTION_WINDOW_MS;
  const recent = Array.isArray(timestamps)
    ? timestamps.filter(timestamp => Number.isFinite(timestamp) && timestamp >= 0 && timestamp >= cutoff && timestamp <= now)
    : [];

  recent.push(now);
  if (recent.length > MAX_TRACKED_INTERRUPTION_EVENTS) {
    recent.splice(0, recent.length - MAX_TRACKED_INTERRUPTION_EVENTS);
  }

  const limit = normalizeInterruptionEventsPerMinute(threshold);
  return {
    timestamps: recent,
    count: recent.length,
    thresholdReached: recent.length >= limit
  };
}

module.exports = {
  BASE_INTERRUPTION_UNREADABLE_FRAMES,
  INTERRUPTION_WINDOW_MS,
  DEFAULT_INTERRUPTION_EVENTS_PER_MINUTE,
  MAX_INTERRUPTION_EVENTS_PER_MINUTE,
  normalizeInterruptionEventsPerMinute,
  registerInterruptionEvent,
  advanceRdsGroupInterruptionState,
  resetRdsGroupInterruptionState
};
