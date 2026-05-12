#!/usr/bin/env node
"use strict";
/**
 * server.js — MCP server for Render.
 *
 * Install via Claude Code: Settings → MCP Servers → Add from GitHub
 * Then ask Claude: "call bootstrap_auth to set up your session"
 */
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const PLUGIN_DIR    = path.dirname(require.main.filename);
const CONFIG        = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "plugin.config.json"), "utf8"));
const AUTH_JSON     = path.join(PLUGIN_DIR, "auth", "auth.json");
const LOGIN_DIR     = path.join(PLUGIN_DIR, "auth", "login");
const PROTECTED_URL = "https://dashboard.render.com";
const MARKER_TEXT   = "";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function interpolate(value, inputs) {
  if (typeof value !== "string") return value;
  return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, k) => String(inputs[k] ?? ""));
}

async function tryLocator(page, sel, timeout) {
  try { await page.locator(sel).waitFor({ state: "visible", timeout: timeout || 4000 }); return true; }
  catch (_) { return false; }
}

const URL_STATE_WAIT_MS = 2000;
const URL_STATE_POLL_MS = 100;

async function waitForUrlState(page, urlState) {
  if (!urlState || !urlState.url_pattern) return;
  const pattern = new RegExp(urlState.url_pattern);
  const deadline = Date.now() + URL_STATE_WAIT_MS;
  let currentUrl = page.url();

  while (Date.now() <= deadline) {
    currentUrl = page.url();
    if (pattern.test(currentUrl)) return;
    await page.waitForTimeout(Math.min(URL_STATE_POLL_MS, Math.max(0, deadline - Date.now())));
  }

  throw new Error(`URL ${currentUrl} does not match expected pattern ${urlState.url_pattern}`);
}

// ─── Step executor ────────────────────────────────────────────────────────────

async function executeStep(page, step, inputs) {
  const type  = step.type;
  const raw   = step.selector || step.css_selector || (step.target && step.target.css) || "";
  const sel   = interpolate(raw, inputs);

  if (type === "wait") { await page.waitForTimeout(Number(step.ms) || 1000); return; }
  if (type === "navigate") {
    await page.goto(interpolate(step.url || "", inputs), { timeout: 30000, waitUntil: "domcontentloaded" });
    return;
  }
  if (type === "scroll") {
    if (sel) { await page.locator(sel).first().scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {}); }
    else      { await page.evaluate(`window.scrollBy(${Number(step.delta_x)||0}, ${Number(step.delta_y)||0})`); }
    return;
  }
  if (type === "fill" || type === "type") {
    await page.locator(sel).first().fill(interpolate(step.value || "", inputs), { timeout: 15000 });
    return;
  }
  if (type === "click") {
    try { await page.locator(sel).first().click({ timeout: 15000 }); return; }
    catch (err) {
      if (String(err).includes("intercepts pointer events")) {
        try { await page.locator(sel).last().click({ timeout: 10000 }); return; } catch (_) {}
      }
      throw err;
    }
  }
  if (type === "select") {
    await page.locator(sel).first().selectOption(interpolate(step.value || "", inputs), { timeout: 15000 });
    return;
  }
  if (type === "check") {
    const pattern = interpolate(step.pattern || step.check_pattern || "", inputs);
    if (pattern && !new RegExp(pattern).test(page.url()))
      throw new Error(`URL check failed: ${page.url()} does not match ${pattern}`);
    return;
  }
  // Unknown type — skip
}

async function runSkill(page, skillDir, inputs) {
  const execPath = path.join(skillDir, "execution.json");
  if (!fs.existsSync(execPath)) throw new Error(`execution.json not found in ${skillDir}`);
  const exec  = JSON.parse(fs.readFileSync(execPath, "utf8"));
  const steps = Array.isArray(exec) ? exec
              : Array.isArray(exec.steps) ? exec.steps
              : Array.isArray(exec.execution_plan) ? exec.execution_plan : [];

  const recoveryPath = path.join(skillDir, "recovery.json");
  const recovery = fs.existsSync(recoveryPath)
    ? JSON.parse(fs.readFileSync(recoveryPath, "utf8"))
    : { steps: [] };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    try {
      if (step.url_state && step.url_state.before && step.url_state.before.url_pattern) {
        await waitForUrlState(page, step.url_state.before);
      }
      await executeStep(page, step, inputs);
      if (step.url_state && step.url_state.after && step.url_state.after.url_pattern) {
        await waitForUrlState(page, step.url_state.after);
      }
    } catch (err) {
      if (String(err.message || err).includes("expected pattern")) {
        throw new Error(`Step ${step.id || i} (${step.type}) failed: ${err.message}`);
      }
      // Attempt fallback selectors from recovery.json
      const stepNumber = i + 1;
      const rec = (recovery.steps || []).find(r =>
        (step.id && r.id === step.id) || Number(r.step_id) === stepNumber
      );
      let recovered = false;
      if (rec) {
        const selectorContext = rec.selector_context && typeof rec.selector_context === "object" ? rec.selector_context : {};
        const fallback = rec.fallback && typeof rec.fallback === "object" ? rec.fallback : {};
        const anchors = Array.isArray(rec.anchors) ? rec.anchors : [];
        const candidates = Array.from(new Set([
          ...(Array.isArray(rec.fallback_selectors) ? rec.fallback_selectors : []),
          ...(Array.isArray(rec.candidates) ? rec.candidates : []),
          ...(typeof selectorContext.primary === "string" ? [selectorContext.primary] : []),
          ...(Array.isArray(selectorContext.alternatives) ? selectorContext.alternatives : []),
          ...(Array.isArray(fallback.text_variants) ? fallback.text_variants.map(t => `text=${JSON.stringify(String(t).trim())}`) : []),
          ...anchors
            .filter(a => a && typeof a.text === "string" && a.text.trim())
            .map(a => `text=${JSON.stringify(a.text.trim())}`),
        ].filter(Boolean)));
        for (const cand of candidates) {
          if (await tryLocator(page, cand, 3000)) {
            try {
              await executeStep(page, { ...step, selector: cand }, inputs);
              if (step.url_state && step.url_state.after && step.url_state.after.url_pattern) {
                await waitForUrlState(page, step.url_state.after);
              }
              recovered = true;
              break;
            }
            catch (_) {}
          }
        }
      }
      if (!recovered) throw new Error(`Step ${step.id || i} (${step.type}) failed: ${err.message}`);
    }
  }
}

async function runPlan(page, steps, inputs) {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    try {
      if (step.url_state && step.url_state.before && step.url_state.before.url_pattern) {
        await waitForUrlState(page, step.url_state.before);
      }
      await executeStep(page, step, inputs);
      if (step.url_state && step.url_state.after && step.url_state.after.url_pattern) {
        await waitForUrlState(page, step.url_state.after);
      }
    } catch (err) {
      // Layer 1: step-embedded alternative selectors
      const candidates = Array.from(new Set([
        ...(Array.isArray(step.fallback_selectors) ? step.fallback_selectors : []),
        ...(Array.isArray(step.candidates) ? step.candidates : []),
        ...(Array.isArray(step.anchors) ? step.anchors.filter(a => a && typeof a.text === "string").map(a => `text=${JSON.stringify(a.text.trim())}`) : []),
        ...(Array.isArray(step.fallback_text_variants) ? step.fallback_text_variants.map(t => `text=${JSON.stringify(String(t).trim())}`) : []),
      ].filter(Boolean)));

      let recovered = false;
      // Layer 2: try each candidate selector
      for (const cand of candidates) {
        if (await tryLocator(page, cand, 3000)) {
          try {
            await executeStep(page, { ...step, selector: cand }, inputs);
            if (step.url_state && step.url_state.after && step.url_state.after.url_pattern) {
              await waitForUrlState(page, step.url_state.after);
            }
            recovered = true;
            break;
          } catch (_) {}
        }
      }
      // Layer 3: derive text selector from step value or label
      if (!recovered) {
        const textHints = [step.value, step.label, step.aria_label].filter(v => v && typeof v === "string" && v.length < 60);
        for (const hint of textHints) {
          const textSel = `text=${JSON.stringify(hint.trim())}`;
          if (await tryLocator(page, textSel, 3000)) {
            try {
              await executeStep(page, { ...step, selector: textSel }, inputs);
              recovered = true;
              break;
            } catch (_) {}
          }
        }
      }
      if (!recovered) throw new Error(`Step ${i} (${step.type}) failed: ${err.message}`);
    }
  }
}

// ─── Session management ───────────────────────────────────────────────────────

async function isAuthenticated(page) {
  const url = page.url();
  try {
    if (new URL(url).hostname !== new URL(PROTECTED_URL).hostname) return false;
  } catch (_) { return false; }
  if (MARKER_TEXT) {
    const text = await page.textContent("body").catch(() => "");
    if (!text.includes(MARKER_TEXT)) return false;
  }
  return true;
}

async function getAuthContext(headless) {
  const browser = await chromium.launch({ headless: headless !== false });
  const opts = {};
  if (fs.existsSync(AUTH_JSON)) {
    try { opts.storageState = JSON.parse(fs.readFileSync(AUTH_JSON, "utf8")); } catch (_) {}
  }
  const context = await browser.newContext(opts);
  const page    = await context.newPage();

  await page.goto(PROTECTED_URL, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(600);

  if (!(await isAuthenticated(page))) {
    if (!fs.existsSync(LOGIN_DIR))
      throw new Error("Session expired. Ask Claude to call bootstrap_auth first.");
    await runSkill(page, LOGIN_DIR, {});
    const state = await context.storageState();
    fs.mkdirSync(path.dirname(AUTH_JSON), { recursive: true });
    fs.writeFileSync(AUTH_JSON, JSON.stringify(state, null, 2));
    await page.goto(PROTECTED_URL, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    if (!(await isAuthenticated(page))) throw new Error("Auth failed. Call bootstrap_auth again.");
  }

  await page.close();
  return { browser, context };
}

// ─── MCP server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: CONFIG.id, version: CONFIG.version },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = [
    {
      name: "bootstrap_auth",
      description: `Set up your ${CONFIG.name} session. Opens a browser — log in, then close the window. Run once before using any skill.`,
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "list_skills",
      description: "List all available skills with metadata",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "read_skill_files",
      description: "Read execution.json and recovery.json for a skill. Returns steps and recovery info for planning.",
      inputSchema: { type: "object", properties: { slug: { type: "string", description: "Skill slug (use underscores or hyphens)" } }, required: ["slug"] },
    },
    {
      name: "execute_plan",
      description: "Execute a merged multi-skill plan via Playwright. Accepts steps array (merged from multiple execution.json files). Runs visible browser.",
      inputSchema: { type: "object", properties: { steps: { type: "array", description: "Merged array of execution steps from one or more skills" }, inputs: { type: "object", description: "Input values to substitute into step placeholders" } }, required: ["steps"] },
    },
  ];

  for (const skill of (CONFIG.skills || [])) {
    let description = `Execute ${skill.slug} on ${CONFIG.target_url}`;
    let inputSchema = { type: "object", properties: {}, required: [] };
    const mPath = path.join(PLUGIN_DIR, skill.path, "manifest.json");
    const iPath = path.join(PLUGIN_DIR, skill.path, "input.json");
    if (fs.existsSync(mPath)) {
      try { const m = JSON.parse(fs.readFileSync(mPath, "utf8")); description = m.description || m.intent || description; }
      catch (_) {}
    }
    if (fs.existsSync(iPath)) {
      try {
        const loaded = JSON.parse(fs.readFileSync(iPath, "utf8"));
        inputSchema = { type: "object", ...loaded };
      } catch (_) {}
    }
    tools.push({ name: skill.slug.replace(/-/g, "_"), description, inputSchema });
  }
  console.error(`[ListTools] Registering ${tools.length} tools: ${tools.map(t => t.name).join(", ")}`);
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "bootstrap_auth") {
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page    = await context.newPage();
    await page.goto(CONFIG.target_url, { waitUntil: "domcontentloaded", timeout: 30000 });
    // Wait until user navigates to the protected area (up to 5 min)
    try {
      const protectedHostPath = new URL(PROTECTED_URL).pathname.replace(/\/$/, "");
      await page.waitForURL(u => u.pathname.startsWith(protectedHostPath) || u.href.includes(PROTECTED_URL), { timeout: 300000 });
    } catch (_) {}
    const state = await context.storageState();
    fs.mkdirSync(path.dirname(AUTH_JSON), { recursive: true });
    fs.writeFileSync(AUTH_JSON, JSON.stringify(state, null, 2));
    await browser.close();
    return { content: [{ type: "text", text: `Session saved. You can now use ${CONFIG.name} skills.` }] };
  }

  // ── list_skills ───────────────────────────────────────────────────────────
  if (name === "list_skills") {
    const skills = CONFIG.skills || [];
    console.error(`[list_skills] Returning ${skills.length} skills: ${skills.map(s => s.slug).join(", ")}`);
    return { content: [{ type: "text", text: JSON.stringify(skills, null, 2) }] };
  }

  // ── read_skill_files ─────────────────────────────────────────────────────
  if (name === "read_skill_files") {
    const slugArg = (args && args.slug) ? String(args.slug) : "";
    console.error(`[read_skill_files] Looking for skill: ${slugArg}`);
    const skill = (CONFIG.skills || []).find(s => s.slug === slugArg || s.slug === slugArg.replace(/_/g, "-") || s.slug === slugArg.replace(/-/g, "_"));
    if (!skill) {
      console.error(`[read_skill_files] Skill not found. Available: ${(CONFIG.skills || []).map(s => s.slug).join(", ")}`);
      return { content: [{ type: "text", text: `Skill not found: ${slugArg}. Use list_skills to see available skills.` }] };
    }
    const skillDir = path.join(PLUGIN_DIR, skill.path);
    const execPath = path.join(skillDir, "execution.json");
    const recPath  = path.join(skillDir, "recovery.json");
    const result = {
      slug: skill.slug,
      path: skill.path,
      execution: fs.existsSync(execPath) ? JSON.parse(fs.readFileSync(execPath, "utf8")) : null,
      recovery:  fs.existsSync(recPath)  ? JSON.parse(fs.readFileSync(recPath,  "utf8")) : null,
    };
    console.error(`[read_skill_files] Found ${skill.slug}: ${result.execution ? result.execution.length + " steps" : "no execution.json"}`);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }

  // ── execute_plan ─────────────────────────────────────────────────────────
  if (name === "execute_plan") {
    const steps  = (args && Array.isArray(args.steps))  ? args.steps  : [];
    const inputs = (args && typeof args.inputs === "object" && args.inputs) ? args.inputs : {};
    console.error(`[execute_plan] Starting with ${steps.length} steps, inputs: ${JSON.stringify(inputs)}`);
    if (steps.length === 0) return { content: [{ type: "text", text: "execute_plan: no steps provided." }] };

    let _browser, _context;
    try {
      ({ browser: _browser, context: _context } = await getAuthContext(false));
      console.error(`[execute_plan] Auth context ready`);
    } catch (authErr) {
      console.error(`[execute_plan] Auth failed: ${authErr}`);
      return { content: [{ type: "text", text: String(authErr) }] };
    }

    const page = await _context.newPage();
    try {
      console.error(`[execute_plan] Running ${steps.length} steps...`);
      await runPlan(page, steps, inputs);
      const state = await _context.storageState();
      fs.mkdirSync(path.dirname(AUTH_JSON), { recursive: true });
      fs.writeFileSync(AUTH_JSON, JSON.stringify(state, null, 2));
      const shot = await page.screenshot({ type: "png" }).catch(() => null);
      const url  = page.url();
      await _browser.close();
      console.error(`[execute_plan] Success! URL: ${url}`);
      const content = [{ type: "text", text: `Plan executed successfully. URL: ${url}` }];
      if (shot) content.push({ type: "image", data: shot.toString("base64"), mimeType: "image/png" });
      return { content };
    } catch (err) {
      console.error(`[execute_plan] Failed: ${err.message}`);
      await _browser.close().catch(() => {});
      return { content: [{ type: "text", text: `Plan execution failed at: ${err.message}` }] };
    }
  }

  const skillSlug = name.replace(/_/g, "-");
  const skill = (CONFIG.skills || []).find(s => s.slug === skillSlug);
  if (!skill) throw new Error(`Unknown tool: ${name}`);

  let _browser, _context;
  try {
    ({ browser: _browser, context: _context } = await getAuthContext(false));
  } catch (authErr) {
    return { content: [{ type: "text", text: String(authErr) }] };
  }

  const page = await _context.newPage();
  try {
    await runSkill(page, path.join(PLUGIN_DIR, skill.path), args || {});
    const state = await _context.storageState();
    fs.mkdirSync(path.dirname(AUTH_JSON), { recursive: true });
    fs.writeFileSync(AUTH_JSON, JSON.stringify(state, null, 2));
    const shot = await page.screenshot({ type: "png" }).catch(() => null);
    const url  = page.url();
    await _browser.close();
    const content = [{ type: "text", text: `${skill.slug} completed. URL: ${url}` }];
    if (shot) content.push({ type: "image", data: shot.toString("base64"), mimeType: "image/png" });
    return { content };
  } catch (err) {
    await _browser.close().catch(() => {});
    return { content: [{ type: "text", text: `Skill failed: ${err}` }] };
  }
});

const _skillFlagIdx = process.argv.indexOf("--run-skill");
if (_skillFlagIdx !== -1) {
  // ── CLI execution mode ────────────────────────────────────────────────────
  const _skillSlug  = process.argv[_skillFlagIdx + 1];
  const _inputsIdx  = process.argv.indexOf("--inputs");
  const _inputs     = _inputsIdx !== -1 ? JSON.parse(process.argv[_inputsIdx + 1]) : {};
  const _headless   = process.argv.includes("--headless");

  const _skill = (CONFIG.skills || []).find(s => s.slug === _skillSlug);
  if (!_skill) {
    process.stdout.write(JSON.stringify({ status: "failed", error: `Skill not found: ${_skillSlug}` }));
    process.exit(1);
  }

  getAuthContext(_headless).then(async ({ browser, context }) => {
    const page = await context.newPage();
    try {
      await runSkill(page, path.join(PLUGIN_DIR, _skill.path), _inputs);
      const url  = page.url();
      const shot = await page.screenshot({ type: "png" }).catch(() => null);
      const state = await context.storageState();
      fs.mkdirSync(path.dirname(AUTH_JSON), { recursive: true });
      fs.writeFileSync(AUTH_JSON, JSON.stringify(state, null, 2));
      await browser.close();
      process.stdout.write(JSON.stringify({
        status: "success",
        url,
        screenshot: shot ? shot.toString("base64") : null,
      }));
      process.exit(0);
    } catch (err) {
      await browser.close().catch(() => {});
      process.stdout.write(JSON.stringify({ status: "failed", error: String(err) }));
      process.exit(1);
    }
  }).catch(err => {
    process.stdout.write(JSON.stringify({ status: "failed", error: String(err) }));
    process.exit(1);
  });
} else {
  // ── MCP server mode (default) ─────────────────────────────────────────────
  const transport = new StdioServerTransport();
  server.connect(transport);
}
