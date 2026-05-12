"use strict";
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const recovery = require("./recovery");
const validator = require("./validator");
const tracker = require("./tracker");

function skillDir(name) {
  return path.join(__dirname, "..", "skills", name);
}

function interpolate(value, inputs) {
  if (typeof value !== "string") return value;
  return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key) => String(inputs[key] ?? ""));
}

function parseArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "");
    args[key] = argv[i + 1] ?? "";
  }
  return args;
}

async function trySelector(page, selector, timeout) {
  try {
    await page.locator(selector).waitFor({ state: "visible", timeout: timeout || 5000 });
    return true;
  } catch (_) {
    return false;
  }
}

async function applyRecovery(page, ctx, attemptFn) {
  for (const layer of [1, 2, 3]) {
    let plan;
    try {
      plan = await recovery.runLayer(layer, ctx);
    } catch (_) {
      continue;
    }
    if (!plan || !Array.isArray(plan.candidates)) continue;
    for (const sel of plan.candidates) {
      if (!(await trySelector(page, sel, 3000))) continue;
      try {
        await attemptFn(sel);
        return { selector: sel, layer };
      } catch (_) {
        // candidate visible but action failed — try next candidate / next layer
      }
    }
  }
  return null;
}

const RECOVERY_ACTION_TYPES = new Set(["type", "fill", "click", "select", "focus"]);
const PLAIN_RETRY_ACTION_TYPES = new Set(["navigate", "check"]);
const TIMING_RETRY_ATTEMPTS = 2;
const TIMING_RETRY_WAIT_MS = 1000;
const NAV_CHECK_TOTAL_ATTEMPTS = 3;
const URL_STATE_WAIT_MS = 2000;
const URL_STATE_POLL_MS = 100;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCheck(page, step, inputs) {
  const kind = String(step.kind || "url").toLowerCase();
  if (kind === "url") {
    const pattern = interpolate(step.pattern || step.check_pattern || "", inputs);
    const url = page.url();
    if (!url.includes(pattern)) throw new Error(`URL check failed: ${url} does not include ${pattern}`);
    return;
  }
  if (kind === "url_exact" || kind === "url_must_be") {
    const expected = interpolate(step.url || step.expected_url || step.pattern || step.check_pattern || "", inputs);
    const url = page.url();
    if (url !== expected) throw new Error(`URL exact check failed: ${url} does not equal ${expected}`);
    return;
  }
  if (kind === "selector") {
    const selector = interpolate(step.selector || "", inputs);
    await page.locator(selector).first().waitFor({ state: "attached", timeout: 5000 });
    return;
  }
  if (kind === "text") {
    const text = interpolate(step.text || "", inputs);
    await page.locator(`text=${JSON.stringify(text)}`).first().waitFor({ state: "visible", timeout: 5000 });
    return;
  }
  if (kind === "snapshot") {
    return;
  }
  throw new Error(`Unknown check kind: ${kind}`);
}

async function runScroll(page, step, inputs) {
  const selector = interpolate(step.selector || "", inputs);
  if (selector) {
    await page.locator(selector).first().scrollIntoViewIfNeeded({ timeout: 5000 });
    return;
  }
  await page.evaluate(`window.scrollBy(${Number(step.delta_x) || 0}, ${Number(step.delta_y) || 0})`);
}

async function performAction(page, step, inputs, selector) {
  const type = step.type;
  if (type === "wait") {
    await new Promise((resolve) => setTimeout(resolve, Number(step.ms) || 1000));
    return;
  }
  if (type === "navigate") {
    const url = interpolate(step.url || "", inputs);
    await page.goto(url, { timeout: 15000, waitUntil: "domcontentloaded" });
    return;
  }
  if (type === "scroll") {
    await runScroll(page, step, inputs);
    return;
  }
  if (type === "check") {
    await runCheck(page, step, inputs);
    return;
  }
  if (type === "fill" || type === "type") {
    const value = interpolate(step.value || "", inputs);
    await page.locator(selector).first().fill(value, { timeout: 15000 });
    return;
  }
  if (type === "click") {
    try {
      await page.locator(selector).first().click({ timeout: 15000 });
      return;
    } catch (err) {
      if (String(err).includes("intercepts pointer events")) {
        // Step 1: scoped under known popup containers (target the popup button, not the one behind it)
        const modalContainers = [
          '[role="dialog"]',
          '[role="alertdialog"]',
          '[aria-modal="true"]',
          '[data-floating-ui-portal]',
          '.modal',
        ];
        for (const container of modalContainers) {
          const scoped = `${container} ${selector}`;
          if (await trySelector(page, scoped, 2000)) {
            try {
              await page.locator(scoped).first().click({ timeout: 10000 });
              return;
            } catch (_) {}
          }
        }
        // Step 2: .last() — popups are appended last in DOM order, so .last() finds the popup button
        try {
          await page.locator(selector).last().click({ timeout: 10000 });
          return;
        } catch (_) {}
      }
      throw err;
    }
  }
  if (type === "select") {
    const value = interpolate(step.value || "", inputs);
    await page.locator(selector).first().selectOption(value, { timeout: 15000 });
    return;
  }
  if (type === "focus") {
    await page.locator(selector).first().focus({ timeout: 15000 });
    return;
  }
  throw new Error(`Unknown step type: ${type}`);
}

async function dispatchStep(page, step, inputs, skill, stepIdx) {
  const type = step.type;
  const sel = interpolate(step.selector || "", inputs);
  const start = Date.now();
  const row = { step: stepIdx, type, selector: sel, attempts: 0 };

  try {
    // Pre-step url_state check: wait briefly for the expected URL, then fail on mismatch.
    const urlStateBefore = step.url_state && step.url_state.before;
    if (urlStateBefore && urlStateBefore.url_pattern) {
      const preCheck = await waitForUrlState(page, urlStateBefore, URL_STATE_WAIT_MS);
      if (!preCheck.ok) {
        throw new Error(`pre-step url_state failed: ${preCheck.reason}`);
      }
    }

    let lastError = null;

    if (RECOVERY_ACTION_TYPES.has(type)) {
      // L1: timing retries — wait and retry before escalating to recovery layers
      for (let attempt = 1; attempt <= TIMING_RETRY_ATTEMPTS; attempt += 1) {
        row.attempts = attempt;
        if (attempt > 1) await new Promise((r) => setTimeout(r, TIMING_RETRY_WAIT_MS));
        try {
          await performAction(page, step, inputs, sel);
          row.status = "ok";
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
        }
      }
      // L2–L4: stored alternatives → visual spatial → agent recovery
      if (lastError) {
        // Skip recovery for disabled elements — application-state issue, not UI drift
        let isDisabled = false;
        if (sel) {
          try {
            const loc = page.locator(sel).first();
            isDisabled = await loc.isDisabled({ timeout: 1000 }).catch(() => false);
            if (!isDisabled) {
              const aria = await loc.getAttribute("aria-disabled", { timeout: 1000 }).catch(() => null);
              isDisabled = aria === "true";
            }
          } catch (_) {}
        }
        if (isDisabled) {
          row.error = "element disabled — application-state issue, not UI drift; recovery skipped";
        } else {
          const result = await applyRecovery(
            page,
            { skill, step: stepIdx, error: String(lastError), page },
            (s) => performAction(page, step, inputs, s)
          );
          if (result) {
            row.status = "recovered";
            row.recovered_via = result.selector;
            row.recovered_layer = result.layer;
            lastError = null;
          }
        }
      }
    } else if (PLAIN_RETRY_ACTION_TYPES.has(type)) {
      for (let attempt = 1; attempt <= NAV_CHECK_TOTAL_ATTEMPTS; attempt += 1) {
        row.attempts = attempt;
        try {
          await performAction(page, step, inputs, sel);
          row.status = "ok";
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          if (attempt === NAV_CHECK_TOTAL_ATTEMPTS) throw lastError;
        }
      }
    } else {
      row.attempts = 1;
      await performAction(page, step, inputs, sel);
      row.status = "ok";
    }

    if (lastError) throw lastError;

    // Post-step url_state check: continue as soon as it matches, fail after 2s.
    const urlStateAfter = step.url_state && step.url_state.after;
    if (urlStateAfter && urlStateAfter.url_pattern && row.status !== "failed") {
      const postCheck = await waitForUrlState(page, urlStateAfter, URL_STATE_WAIT_MS);
      if (!postCheck.ok) {
        throw new Error(`post-step url_state failed: ${postCheck.reason}`);
      }
    }
  } catch (err) {
    row.status = "failed";
    row.error = String(err).split("\n")[0].slice(0, 300);
  }

  row.latency_ms = Date.now() - start;
  return row;
}

async function waitForUrlState(page, urlState, timeoutMs) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  let lastCheck = await validator.validateUrlState(page, urlState);
  if (lastCheck.ok) return lastCheck;

  while (Date.now() < deadline) {
    await sleep(Math.min(URL_STATE_POLL_MS, Math.max(0, deadline - Date.now())));
    lastCheck = await validator.validateUrlState(page, urlState);
    if (lastCheck.ok) return lastCheck;
  }

  return lastCheck;
}

async function runSingleSkill(skill, inputs, resultPath, headless, pluginId, runId) {
  runId = runId || randomUUID();
  pluginId = pluginId || path.basename(path.join(__dirname, ".."));

  try {
    validator.validateInput(skill, inputs);
  } catch (err) {
    console.error(`[executor] input validation failed: ${err.message}`);
    process.exit(1);
  }

  const executionPath = path.join(skillDir(skill), "execution.json");
  if (!fs.existsSync(executionPath)) {
    console.error(`[executor] execution.json not found for skill: ${skill}`);
    process.exit(1);
  }

  const steps = JSON.parse(fs.readFileSync(executionPath, "utf8"));
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ headless, slowMo: 100 });
  const context = await browser.newContext();
  const page = await context.newPage();

  const STEP_DELAY_MS = Number(process.env.STEP_DELAY_MS) || 1200;

  const rows = [];
  const runStart = Date.now();
  console.log(`[executor] skill=${skill} steps=${steps.length} run_id=${runId}`);

  for (let i = 0; i < steps.length; i++) {
    const stepIdx = i + 1;
    const stepType = steps[i].type;
    process.stdout.write(`[executor] step ${stepIdx}/${steps.length} type=${stepType} ... `);
    const row = await dispatchStep(page, steps[i], inputs, skill, stepIdx);
    rows.push(row);
    console.log(row.status + (row.recovered_via ? ` (via ${row.recovered_via})` : ""));

    if (row.status === "failed") {
      tracker.stepFailure(runId, pluginId, skill, stepIdx, row.error || "", row.selector || "", "");
    } else if (row.status === "recovered") {
      tracker.recoveryAttempt(runId, pluginId, skill, stepIdx, "selector_fallback", true, row.recovered_via || null, row.latency_ms || 0);
    }

    if (stepType !== "wait") {
      await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));
    }
  }

  try { await browser.close(); } catch (_) {}

  const ok = rows.filter(r => r.status === "ok").length;
  const recovered = rows.filter(r => r.status === "recovered").length;
  const failed = rows.filter(r => r.status === "failed").length;
  const passed = failed === 0;
  const result = { skill, passed, steps: rows, summary: { total: rows.length, ok, recovered, failed } };
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), "utf8");
  console.log(`[executor] done — ok=${ok} recovered=${recovered} failed=${failed} → ${resultPath}`);

  const failedRow = rows.find(r => r.status === "failed");
  tracker.runOutcome(runId, pluginId, skill, passed ? "success" : "failure", Date.now() - runStart, rows.length, recovered, failedRow ? failedRow.step : null);

  return { passed, result };
}

async function main() {
  const args = parseArgs();

  // Plan mode: execute multiple skills from a plan file
  if (args.plan) {
    const planPath = path.resolve(args.plan);
    if (!fs.existsSync(planPath)) {
      console.error(`[executor] plan file not found: ${planPath}`);
      process.exit(1);
    }

    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    if (!Array.isArray(plan)) {
      console.error(`[executor] plan must be an array of {skill, inputs} objects`);
      process.exit(1);
    }

    const resultPath = args.result ? path.resolve(args.result) : path.join(__dirname, "..", "EXECUTION_PLAN_RESULT.json");
    const headless = args.headless === "1";
    const planResults = [];
    let anyFailed = false;

    for (const entry of plan) {
      const skill = entry.skill;
      const inputs = entry.inputs || {};
      if (!skill) {
        console.error(`[executor] plan entry missing 'skill'`);
        process.exit(1);
      }

      const { passed, result } = await runSingleSkill(skill, inputs, resultPath, headless);
      planResults.push(result);
      if (!passed) anyFailed = true;
    }

    const aggregated = {
      plan: plan.length,
      results: planResults,
      passed: !anyFailed
    };
    fs.writeFileSync(resultPath, JSON.stringify(aggregated, null, 2), "utf8");
    console.log(`[executor] plan complete: ${planResults.length} skills → ${resultPath}`);
    process.exit(anyFailed ? 1 : 0);
  }

  // Legacy single-skill mode
  const skill = args.skill;
  if (!skill) { console.error("[executor] --skill or --plan is required"); process.exit(1); }

  const inputs = args.inputs && fs.existsSync(args.inputs)
    ? JSON.parse(fs.readFileSync(args.inputs, "utf8"))
    : {};

  const resultPath = args.result
    ? path.resolve(args.result)
    : path.join(__dirname, "..", "EXECUTION_RESULT.json");

  const headless = args.headless === "1";

  const { passed } = await runSingleSkill(skill, inputs, resultPath, headless);
  process.exit(passed ? 0 : 1);
}

main().catch(err => {
  console.error("[executor] fatal:", err.message || err);
  process.exit(1);
});
