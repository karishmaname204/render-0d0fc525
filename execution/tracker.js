"use strict";
const fs = require("fs");
const path = require("path");

const TRACKER_URL = process.env.CONXA_TRACKER_URL || "";
const PLUGIN_DIR = path.join(__dirname, "..");
const LOG_PATH = path.join(PLUGIN_DIR, "execution_log.jsonl");

// Three event types only: step_failure | recovery_attempt | run_outcome
// Fire-and-forget: never awaited, never throws.

function _appendFallback(event) {
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify(event) + "\n", "utf8");
  } catch (_) {}
}

function send(event) {
  if (!event || typeof event !== "object") return;
  const payload = { ...event, ts: new Date().toISOString() };
  if (TRACKER_URL) {
    try {
      const body = JSON.stringify(payload);
      // Node 18+: fetch is built-in; fall back to http module otherwise
      if (typeof fetch === "function") {
        fetch(TRACKER_URL + "/api/v1/runs/events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        }).catch(() => _appendFallback(payload));
      } else {
        _appendFallback(payload);
      }
    } catch (_) {
      _appendFallback(payload);
    }
  } else {
    _appendFallback(payload);
  }
}

function stepFailure(runId, pluginId, skillSlug, stepId, reason, selector, observedUrl) {
  send({
    event: "step_failure",
    run_id: runId,
    plugin_id: pluginId,
    skill_slug: skillSlug,
    step_id: stepId,
    data: { reason: String(reason || ""), selector: String(selector || ""), observed_url: String(observedUrl || "") },
  });
}

function recoveryAttempt(runId, pluginId, skillSlug, stepId, strategy, success, resolvedSelector, latencyMs) {
  send({
    event: "recovery_attempt",
    run_id: runId,
    plugin_id: pluginId,
    skill_slug: skillSlug,
    step_id: stepId,
    data: { strategy, success: !!success, resolved_selector: resolvedSelector || null, latency_ms: latencyMs || 0 },
  });
}

function runOutcome(runId, pluginId, skillSlug, status, durationMs, totalSteps, recoveredSteps, failedStepId) {
  send({
    event: "run_outcome",
    run_id: runId,
    plugin_id: pluginId,
    skill_slug: skillSlug,
    data: {
      status,
      duration_ms: durationMs || 0,
      total_steps: totalSteps || 0,
      recovered_steps: recoveredSteps || 0,
      failed_step_id: failedStepId || null,
    },
  });
}

module.exports = { send, stepFailure, recoveryAttempt, runOutcome };
