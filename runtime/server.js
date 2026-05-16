#!/usr/bin/env node
"use strict";
const { Server }              = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const fs   = require("fs");
const os   = require("os");
const path = require("path");

// Write PID so bootstrap.js can detect a running server (prevents duplicate forks)
const _PID_FILE = path.join(os.homedir(), ".conxa", "runtime", "server.pid");
try { fs.writeFileSync(_PID_FILE, String(process.pid)); } catch (_) {}
const _cleanPid = () => { try { fs.unlinkSync(_PID_FILE); } catch (_) {} };
process.on("exit", _cleanPid);
process.on("SIGINT",  () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

const { getPluginConfig, getPluginDir, getAuthJson, getRegistry } = require("./config");
const { getCachedBrowser, isAuthenticated, getAuthContext, gracefulShutdown } = require("./browser");
const {
  appendRecoveryEvent, interpolate, enrichStepsWithRecovery,
  waitForUrlState, runPlan, runSkill, checkRetryBudget, clearRetryBudget,
} = require("./run");

// ─── Registry helpers ─────────────────────────────────────────────────────────

// Returns { slug → { pluginSlug, skill, skillDir } } for fast lookup
function buildSkillIndex() {
  const registry = getRegistry();
  const index = {};
  for (const [pluginSlug, entry] of Object.entries(registry)) {
    const pluginDir = getPluginDir(pluginSlug);
    for (const skill of (entry.skills || [])) {
      const key = `${pluginSlug}:${skill.slug}`;
      index[key] = { pluginSlug, skill, skillDir: path.join(pluginDir, skill.path || `skills/${skill.slug}`) };
    }
  }
  return index;
}

function resolveSkill(pluginSlug, skillSlug, index) {
  // Exact match with plugin prefix
  if (pluginSlug) {
    const key = `${pluginSlug}:${skillSlug}`;
    if (index[key]) return index[key];
    // Try slug normalization
    for (const [k, v] of Object.entries(index)) {
      if (v.pluginSlug === pluginSlug && (v.skill.slug === skillSlug || v.skill.slug.replace(/-/g, "_") === skillSlug.replace(/-/g, "_")))
        return v;
    }
  }
  // Slug-only: match across all plugins
  for (const v of Object.values(index)) {
    if (v.skill.slug === skillSlug || v.skill.slug.replace(/-/g, "_") === skillSlug.replace(/-/g, "_"))
      return v;
  }
  return null;
}

// ─── Lazy discover on startup ─────────────────────────────────────────────────

try {
  require("./cli").discover();
} catch (_) {}

// ─── MCP server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: "conxa", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = [
    {
      name: "list_skills",
      description: "List all installed Conxa skills across all plugins. Pass plugin slug to filter. Call once to plan, then call execute_plan immediately.",
      inputSchema: {
        type: "object",
        properties: {
          plugin: { type: "string", description: "Optional plugin slug to filter skills" },
        },
        required: [],
      },
    },
    {
      name: "execute_plan",
      description: "Run one or more skills in sequence in a single browser session. Auth is 100% automatic. On failure: L4 (vision) and L5 (intent) data are returned. Fix execution.json or pass step_overrides, then retry with resume_from.",
      inputSchema: {
        type: "object",
        properties: {
          skills: {
            type: "array",
            description: "Ordered list of skills to run",
            items: {
              type: "object",
              properties: {
                plugin: { type: "string", description: "Plugin slug (optional if skill slug is unique across all plugins)" },
                slug:   { type: "string", description: "Skill slug from list_skills" },
                inputs: { type: "object", description: "Input values for this skill" },
              },
              required: ["slug"],
            },
          },
          resume_from: {
            type: "integer",
            description: "0-based step index to resume from. Use after fixing execution.json.",
          },
          step_overrides: {
            type: "object",
            description: "Per-skill, per-step overrides. Keyed by skill slug then 0-based step index. Non-persistent.",
          },
        },
        required: ["skills"],
      },
    },
    {
      name: "read_skill_files",
      description: "DEBUG ONLY — inspect raw execution steps and recovery data for a skill.",
      inputSchema: {
        type: "object",
        properties: {
          slug:   { type: "string" },
          plugin: { type: "string", description: "Plugin slug (optional)" },
        },
        required: ["slug"],
      },
    },
  ];
  console.error(`[ListTools] Registering ${tools.length} tools`);
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const skillIndex = buildSkillIndex();

  // ── list_skills ───────────────────────────────────────────────────────────
  if (name === "list_skills") {
    const filterPlugin = args && args.plugin ? String(args.plugin) : null;
    const registry = getRegistry();
    const skills = [];
    for (const [pluginSlug, entry] of Object.entries(registry)) {
      if (filterPlugin && pluginSlug !== filterPlugin) continue;
      const pluginDir = getPluginDir(pluginSlug);
      for (const skill of (entry.skills || [])) {
        const skillDir = path.join(pluginDir, skill.path || `skills/${skill.slug}`);
        const iPath = path.join(skillDir, "input.json");
        const mdPath = path.join(skillDir, "SKILL.md");
        let requiredInputs = [], inputProps = {}, description = skill.slug;
        if (fs.existsSync(iPath)) {
          try {
            const s = JSON.parse(fs.readFileSync(iPath, "utf8"));
            requiredInputs = s.required || [];
            inputProps = s.properties || {};
            description = s.description || description;
          } catch (_) {}
        }
        // Fall back to first line of SKILL.md as description
        if (description === skill.slug && fs.existsSync(mdPath)) {
          try {
            const firstLine = fs.readFileSync(mdPath, "utf8").split("\n").find(l => l.startsWith("# "));
            if (firstLine) description = firstLine.replace(/^#\s*/, "").trim();
          } catch (_) {}
        }
        skills.push({ plugin: pluginSlug, slug: skill.slug, description, required_inputs: requiredInputs, inputs: inputProps });
      }
    }
    console.error(`[list_skills] Returning ${skills.length} skills`);
    return { content: [{ type: "text", text: [
      "RULES: auth automatic, no confirmations, no read_skill_files in normal flow.",
      "FLOW: list_skills → ask for any missing inputs → execute_plan({ skills: [{ plugin, slug, inputs }] })",
      "",
      "SKILLS:",
      JSON.stringify(skills, null, 2),
    ].join("\n") }] };
  }

  // ── read_skill_files ─────────────────────────────────────────────────────
  if (name === "read_skill_files") {
    const slugArg   = args && args.slug   ? String(args.slug)   : "";
    const pluginArg = args && args.plugin ? String(args.plugin) : null;
    const resolved  = resolveSkill(pluginArg, slugArg, skillIndex);
    if (!resolved) return { content: [{ type: "text", text: `Skill not found: ${slugArg}. Use list_skills.` }] };
    const { skillDir } = resolved;
    const execPath = path.join(skillDir, "execution.json");
    const recPath  = path.join(skillDir, "recovery.json");
    const mdPath   = path.join(skillDir, "SKILL.md");
    const iPath    = path.join(skillDir, "input.json");
    const inputSchema    = fs.existsSync(iPath)    ? JSON.parse(fs.readFileSync(iPath,    "utf8")) : null;
    const requiredInputs = inputSchema && inputSchema.required ? inputSchema.required : [];
    const rawExecution   = fs.existsSync(execPath) ? JSON.parse(fs.readFileSync(execPath, "utf8")) : null;
    const rawRecovery    = fs.existsSync(recPath)  ? JSON.parse(fs.readFileSync(recPath,  "utf8")) : null;
    const rawSteps       = Array.isArray(rawExecution) ? rawExecution
                         : (rawExecution && Array.isArray(rawExecution.steps)) ? rawExecution.steps : [];
    return { content: [{ type: "text", text: JSON.stringify({
      plugin:          resolved.pluginSlug,
      slug:            resolved.skill.slug,
      skill_md:        fs.existsSync(mdPath) ? fs.readFileSync(mdPath, "utf8") : null,
      required_inputs: requiredInputs,
      instruction:     requiredInputs.length > 0
        ? `STOP — ask the user to provide these inputs before calling execute_plan: ${requiredInputs.join(", ")}`
        : "No inputs required. You may call execute_plan directly.",
      execution: enrichStepsWithRecovery(rawSteps, rawRecovery),
      recovery:  rawRecovery,
    }, null, 2) }] };
  }

  // ── execute_plan ─────────────────────────────────────────────────────────
  if (name === "execute_plan") {
    const skillRuns = (args && Array.isArray(args.skills)) ? args.skills : [];
    if (skillRuns.length === 0)
      return { content: [{ type: "text", text: "execute_plan: provide { skills: [{ slug, inputs }] }" }] };

    const resumeFrom = (Number.isInteger(args.resume_from) && args.resume_from > 0) ? args.resume_from : 0;
    const overrides  = (args.step_overrides && typeof args.step_overrides === "object") ? args.step_overrides : {};
    const isFlatOverrides = Object.keys(overrides).length > 0
      && Object.keys(overrides).every(k => /^\d+$/.test(k));

    // Resolve each skill run
    const resolved = [];
    for (const run of skillRuns) {
      const slug      = String(run.slug || "");
      const pluginArg = run.plugin ? String(run.plugin) : null;
      const inputs    = (run.inputs && typeof run.inputs === "object") ? run.inputs : {};
      const found     = resolveSkill(pluginArg, slug, skillIndex);
      if (!found) return { content: [{ type: "text", text: `Skill not found: ${slug}. Call list_skills.` }] };
      const { skillDir, pluginSlug } = found;
      const rawExec = fs.existsSync(path.join(skillDir, "execution.json"))
        ? JSON.parse(fs.readFileSync(path.join(skillDir, "execution.json"), "utf8")) : null;
      const rawRec  = fs.existsSync(path.join(skillDir, "recovery.json"))
        ? JSON.parse(fs.readFileSync(path.join(skillDir, "recovery.json"),  "utf8")) : null;
      const rawSteps = Array.isArray(rawExec) ? rawExec : (rawExec && Array.isArray(rawExec.steps)) ? rawExec.steps : [];
      const slugOv   = isFlatOverrides
        ? (resolved.length === 0 ? overrides : {})
        : (overrides[slug] && typeof overrides[slug] === "object" ? overrides[slug] : {});
      const enriched = enrichStepsWithRecovery(rawSteps, rawRec).map((s, idx) => {
        const ov = slugOv[String(idx)] ?? slugOv[idx];
        return (ov && typeof ov === "object") ? { ...s, ...ov } : s;
      });
      resolved.push({ steps: enriched, inputs, slug, skillDir, pluginSlug });
    }

    // Determine which plugin to use for auth (first skill's plugin)
    const primaryPlugin = resolved[0].pluginSlug;

    // ── Layer 0: Retry budget gate ────────────────────────────────────────
    if (resumeFrom > 0) {
      if (!checkRetryBudget(resolved[0].slug, resumeFrom)) {
        return { content: [{ type: "text", text: `Retry budget exhausted (5 attempts at step ${resumeFrom}). Fix the root cause in execution.json before retrying from step 0.` }] };
      }
    }

    // ── Acquire browser (cached per-plugin slug) ──────────────────────────
    let _browser, _context;
    try {
      ({ browser: _browser, context: _context } = await getCachedBrowser(primaryPlugin));
    } catch (authErr) {
      return { content: [{ type: "text", text: String(authErr) }] };
    }

    const runtimeLog = { consoleErrors: [], pageErrors: [], failedRequests: [] };
    const page = await _context.newPage();

    page.on("console", msg => {
      if (["error", "warning"].includes(msg.type()) && runtimeLog.consoleErrors.length < 50)
        runtimeLog.consoleErrors.push({ type: msg.type(), text: msg.text() });
    });
    page.on("pageerror", err => {
      if (runtimeLog.pageErrors.length < 20) runtimeLog.pageErrors.push(err.message);
    });
    page.on("requestfailed", req => {
      if (runtimeLog.failedRequests.length < 30)
        runtimeLog.failedRequests.push({ url: req.url(), failure: req.failure()?.errorText });
    });

    // ── Resume state verification ─────────────────────────────────────────
    if (resumeFrom > 0 && resolved.length > 0) {
      const { steps: firstSteps, inputs: firstInputs } = resolved[0];
      for (let i = resumeFrom - 1; i >= 0; i--) {
        if (firstSteps[i] && firstSteps[i].type === "navigate") {
          try { await page.goto(interpolate(firstSteps[i].url || "", firstInputs), { timeout: 30000, waitUntil: "domcontentloaded" }); }
          catch (_) {}
          break;
        }
      }
      const resumeStep = firstSteps[resumeFrom];
      if (resumeStep?.url_state?.before?.url_pattern) {
        try { await waitForUrlState(page, resumeStep.url_state.before); }
        catch (_) {
          const actual = page.url(), expected = resumeStep.url_state.before.url_pattern;
          await page.close().catch(() => {});
          return { content: [{ type: "text", text: `Session state diverged. Expected URL pattern: ${expected}, got: ${actual}. Restart from step 0 or fix execution.json.` }] };
        }
      }
    }

    // ── Execute skills ────────────────────────────────────────────────────
    try {
      for (let si = 0; si < resolved.length; si++) {
        const { steps, inputs, slug, skillDir } = resolved[si];
        const startAt = si === 0 ? resumeFrom : 0;
        console.error(`[execute_plan] Running ${slug} (${steps.length} steps, starting at ${startAt})...`);
        try {
          await runPlan(page, steps, inputs, startAt, slug);
        } catch (runErr) {
          runErr.skillSlug = slug;
          runErr.skillDir  = skillDir;
          throw runErr;
        }
      }

      // ── Success ───────────────────────────────────────────────────────────
      const authJson = getAuthJson(primaryPlugin);
      const state = await _context.storageState();
      fs.mkdirSync(path.dirname(authJson), { recursive: true });
      fs.writeFileSync(authJson, JSON.stringify(state, null, 2));
      const shot = await page.screenshot({ type: "png" }).catch(() => null);
      const url  = page.url();
      await page.close().catch(() => {});
      for (const r of resolved) {
        clearRetryBudget(r.slug);
        appendRecoveryEvent({ event: "run_success", slug: r.slug, steps_executed: r.steps.length });
      }
      console.error(`[execute_plan] Done. URL: ${url}`);
      const content = [{ type: "text", text: `Done. URL: ${url}` }];
      if (shot) content.push({ type: "image", data: shot.toString("base64"), mimeType: "image/png" });
      return { content };

    } catch (err) {
      const url        = page.url();
      const failedAt   = typeof err.failedAt === "number" ? err.failedAt : null;
      const failedDir  = err.skillDir || null;
      const failedSlug = err.skillSlug || null;

      const failShot = await page.screenshot({ type: "png" }).catch(() => null);

      let visualRefData = null, visualRefMime = null;
      if (failedDir && failedAt !== null) {
        const visualDir = path.join(failedDir, "visuals");
        const stepNum   = failedAt + 1;
        for (const ext of [".jpg", ".jpeg", ".png"]) {
          const candidate = path.join(visualDir, `Image_${stepNum}${ext}`);
          if (fs.existsSync(candidate)) {
            visualRefData = fs.readFileSync(candidate).toString("base64");
            visualRefMime = ext === ".png" ? "image/png" : "image/jpeg";
            break;
          }
        }
      }

      let pageStructure = null, viewport = null, scrollY = null;
      try {
        viewport = page.viewportSize();
        scrollY  = await page.evaluate(() => window.scrollY).catch(() => null);
        pageStructure = await page.evaluate(() => {
          const seen = new Set();
          return Array.from(document.querySelectorAll(
            'button, a[href], input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="option"]'
          )).map(el => {
            const text = (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().slice(0, 80);
            const tag  = el.tagName.toLowerCase();
            const type = el.getAttribute("type")        || "";
            const role = el.getAttribute("role")        || "";
            const id   = el.id                          || undefined;
            const dt   = el.getAttribute("data-testid") || el.getAttribute("data-test") || undefined;
            const key  = `${tag}|${type}|${text}`;
            if (!text && !type && !id && !dt) return null;
            if (seen.has(key)) return null;
            seen.add(key);
            return { tag, type: type || undefined, role: role || undefined, text: text || undefined, id: id || undefined, "data-testid": dt || undefined };
          }).filter(Boolean).slice(0, 250);
        });
      } catch (_) {}

      await page.close().catch(() => {});

      appendRecoveryEvent({
        event: "terminal_failure", slug: failedSlug, step_index: failedAt,
        error: err.message,
        console_errors_count:  runtimeLog.consoleErrors.length,
        failed_requests_count: runtimeLog.failedRequests.length,
      });
      console.error(`[execute_plan] Failed: ${err.message}`);

      const resumeHint = failedAt !== null
        ? `\nFix the selector, then call execute_plan with resume_from: ${failedAt}.`
        : "";

      const content = [
        { type: "text", text: `Execution failed at step ${failedAt !== null ? failedAt + 1 : "?"}: ${err.message}\nPage URL: ${url}${resumeHint}` },
      ];

      content.push({ type: "text", text: "\nLayer 4 — vision recovery" });
      if (err.preShot) {
        content.push({ type: "text", text: "Pre-step screenshot (page state BEFORE the failed action):" });
        content.push({ type: "image", data: err.preShot.toString("base64"), mimeType: "image/png" });
      }
      if (visualRefData) {
        content.push({ type: "text", text: `Reference image — red box marks where step ${failedAt + 1} should interact:` });
        content.push({ type: "image", data: visualRefData, mimeType: visualRefMime });
      }
      if (failShot) {
        content.push({ type: "text", text: "Current page at failure:" });
        content.push({ type: "image", data: failShot.toString("base64"), mimeType: "image/png" });
      }

      const l5 = ["\nLayer 5 — intent recovery"];
      if (viewport) l5.push(`viewport: ${JSON.stringify(viewport)}, scrollY: ${scrollY}`);
      if (pageStructure && pageStructure.length > 0)
        l5.push(`Interactive elements (${pageStructure.length}):\n${JSON.stringify(pageStructure, null, 2)}`);
      if (runtimeLog.consoleErrors.length  > 0) l5.push(`Console errors:\n${JSON.stringify(runtimeLog.consoleErrors,  null, 2)}`);
      if (runtimeLog.pageErrors.length     > 0) l5.push(`Page errors:\n${JSON.stringify(runtimeLog.pageErrors,        null, 2)}`);
      if (runtimeLog.failedRequests.length > 0) l5.push(`Failed requests:\n${JSON.stringify(runtimeLog.failedRequests,null, 2)}`);
      content.push({ type: "text", text: l5.join("\n") });

      return { content };
    }
  }

  return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
});

// ─── MCP server start ─────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
server.connect(transport);

process.on("SIGINT",  gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
