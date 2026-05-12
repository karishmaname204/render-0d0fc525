const fs = require("fs");
const path = require("path");
const tracker = require("./tracker");

// layer 0 = crashed (all layers exhausted)
// layer 1 = selector alternatives / text-variant fallback
// layer 2 = anchors
// layer 3 = LLM intent recovery
// layer 4 = vision recovery

function skillDir(name) {
  return path.join(__dirname, "..", "skills", name);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function stepId(value) {
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : null;
}

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    if (typeof value !== "string") continue;
    const clean = value.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function loadRecoveryMap(skill) {
  if (!skill) return null;
  const filePath = path.join(skillDir(skill), "recovery.json");
  if (!fs.existsSync(filePath)) return null;
  try {
    return readJson(filePath);
  } catch (_) {
    return null;
  }
}

function getRecoveryEntry(ctx) {
  if (ctx && ctx.recoveryEntry && typeof ctx.recoveryEntry === "object") {
    return ctx.recoveryEntry;
  }
  const recovery = ctx && typeof ctx.recovery === "object" ? ctx.recovery : loadRecoveryMap(ctx && ctx.skill);
  if (!recovery || !Array.isArray(recovery.steps)) return null;
  const currentStep = stepId(ctx && ctx.step);
  if (currentStep == null) return null;
  return recovery.steps.find((entry) => stepId(entry && entry.step_id) === currentStep) || null;
}

function runStoredAlternatives(ctx, entry) {
  if (!entry) return null;
  const selectorCtx = entry.selector_context && typeof entry.selector_context === "object" ? entry.selector_context : {};
  const fallback = entry.fallback && typeof entry.fallback === "object" ? entry.fallback : {};
  const anchors = Array.isArray(entry.anchors) ? entry.anchors : [];

  const primary = typeof selectorCtx.primary === "string" ? selectorCtx.primary : "";
  const alternatives = Array.isArray(selectorCtx.alternatives) ? selectorCtx.alternatives : [];
  const textVariants = (Array.isArray(fallback.text_variants) ? fallback.text_variants : [])
    .filter((t) => typeof t === "string" && t.trim())
    .map((t) => `text=${JSON.stringify(t.trim())}`);
  const anchorSelectors = anchors
    .filter((a) => a && typeof a.text === "string" && a.text.trim())
    .sort((a, b) => (Number(b.priority) || 1) - (Number(a.priority) || 1))
    .map((a) => `text=${JSON.stringify(a.text.trim())}`);

  const candidates = uniqueStrings([primary, ...alternatives, ...textVariants, ...anchorSelectors]);
  if (!candidates.length) return null;
  return { layer: 1, strategy: "selector_fallback", candidates, recovery_entry: entry };
}

function truncateText(value, maxLength) {
  const text = typeof value === "string" ? value : JSON.stringify(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

async function captureDomSnapshot(page, limit) {
  if (!page || typeof page.evaluate !== "function") return "";
  const elementLimit = typeof limit === "number" ? limit : 120;
  const textLimit = typeof limit === "number" ? 60000 : 12000;
  const bodyTextLimit = typeof limit === "number" ? 10000 : 3000;
  try {
    return truncateText(await page.evaluate((elementLimit, bodyTextLimit) => {
      const visibleText = (node) => (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
      const all = Array.from(document.querySelectorAll("button,a,input,textarea,select,[role],[aria-label],[placeholder],[data-testid]"));
      const elements = (elementLimit > 0 ? all.slice(0, elementLimit) : all).map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            tag: el.tagName.toLowerCase(),
            id: el.id || "",
            role: el.getAttribute("role") || "",
            name: el.getAttribute("name") || "",
            type: el.getAttribute("type") || "",
            text: visibleText(el).slice(0, 120),
            aria: el.getAttribute("aria-label") || "",
            placeholder: el.getAttribute("placeholder") || "",
            testid: el.getAttribute("data-testid") || "",
            visible: rect.width > 0 && rect.height > 0,
          };
        });
      return {
        url: location.href,
        title: document.title,
        body_text: visibleText(document.body).slice(0, bodyTextLimit),
        elements,
      };
    }, elementLimit, bodyTextLimit), textLimit);
  } catch (_) {
    try {
      return truncateText(await page.content(), textLimit);
    } catch (_) {
      return "";
    }
  }
}

async function captureScreenshotBase64(page) {
  if (!page || typeof page.screenshot !== "function") return "";
  try {
    const buffer = await page.screenshot({ type: "jpeg", quality: 45, fullPage: false, timeout: 2000 });
    return buffer.toString("base64");
  } catch (_) {
    return "";
  }
}

async function runAgentRecovery(ctx, entry) {
  if (!ctx || !ctx.page) return null;

  const [domResult, screenshotResult] = await Promise.allSettled([
    captureDomSnapshot(ctx.page, 0),
    captureScreenshotBase64(ctx.page),
  ]);
  const dom = domResult.status === "fulfilled" ? domResult.value : "";
  const screenshot = screenshotResult.status === "fulfilled" ? screenshotResult.value : "";

  const pluginRoot = path.join(__dirname, "..");
  const responsePath = path.join(pluginRoot, "RECOVERY_RESPONSE.json");

  // Clear any stale response from a previous recovery attempt
  try { fs.unlinkSync(responsePath); } catch (_) {}

  // Write context for Claude Code — the orchestrating agent IS the L4 recovery layer
  try {
    fs.writeFileSync(
      path.join(pluginRoot, "RECOVERY_CONTEXT.json"),
      JSON.stringify({
        skill: ctx.skill,
        step: ctx.step,
        error: ctx.error || "",
        recovery_entry: entry,
        dom_snapshot: typeof dom === "string" ? dom : JSON.stringify(dom),
        screenshot_saved: !!screenshot,
        timestamp: new Date().toISOString(),
        instructions: "Write RECOVERY_RESPONSE.json with: {\"selectors\": [\"...correct playwright selector...\"]}. Analyze RECOVERY_CONTEXT.json dom_snapshot and RECOVERY_SCREENSHOT.jpeg to find the right selector for the failed intent.",
      }, null, 2),
      "utf8"
    );
    if (screenshot) {
      fs.writeFileSync(path.join(pluginRoot, "RECOVERY_SCREENSHOT.jpeg"), Buffer.from(screenshot, "base64"));
    }
  } catch (_) { return null; }

  // Pause execution and poll for Claude Code's response — browser stays open
  const timeoutMs = Number(process.env.AGENT_RECOVERY_TIMEOUT_MS) || 120000;
  const deadline = Date.now() + timeoutMs;
  process.stdout.write(`\n[recovery] L4 agent recovery — step ${ctx.step} paused, waiting for RECOVERY_RESPONSE.json (${timeoutMs / 1000}s timeout)\n`);

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    if (!fs.existsSync(responsePath)) continue;
    try {
      const response = JSON.parse(fs.readFileSync(responsePath, "utf8"));
      const selectors = Array.isArray(response.selectors) ? response.selectors.filter((s) => typeof s === "string" && s.trim()) : [];
      if (!selectors.length) continue;
      try { fs.unlinkSync(responsePath); } catch (_) {}
      process.stdout.write(`[recovery] agent provided selector(s): ${selectors.join(", ")}\n`);
      return { layer: 3, strategy: "selector_fallback", candidates: selectors, recovery_entry: entry };
    } catch (_) {}
  }

  process.stdout.write(`[recovery] agent recovery timeout — step ${ctx.step} will fail\n`);
  return null;
}

async function runVisualSpatial(ctx, entry) {
  const page = ctx && ctx.page;
  const visualRef = entry && typeof entry.visual_ref === "string" ? entry.visual_ref.trim() : "";
  if (!page || !visualRef) return null;
  const visualPath = path.isAbsolute(visualRef) ? visualRef : path.join(skillDir(ctx && ctx.skill), visualRef);
  if (!fs.existsSync(visualPath)) return null;

  let current;
  try {
    current = ctx.currentScreenshot || await page.screenshot({ type: "png", scale: "css", fullPage: false, timeout: 2000 });
  } catch (_) {
    return null;
  }

  const target = entry && typeof entry.target === "object" ? entry.target : {};
  const fallback = entry && typeof entry.fallback === "object" ? entry.fallback : {};
  const refExt = path.extname(visualPath).toLowerCase() === ".png" ? "png" : "jpeg";
  const payload = {
    currentDataUrl: `data:image/png;base64,${Buffer.from(current).toString("base64")}`,
    refDataUrl: `data:image/${refExt};base64,${fs.readFileSync(visualPath).toString("base64")}`,
    targetText: typeof target.text === "string" ? target.text.trim() : "",
    targetRole: typeof target.role === "string" ? target.role.trim() : "",
    fallbackRole: typeof fallback.role === "string" ? fallback.role.trim() : "",
  };

  let candidates = [];
  try {
    candidates = await page.evaluate(async ({ currentDataUrl, refDataUrl, targetText, targetRole, fallbackRole }) => {
      const loadImage = (src) => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
      });
      const [current, reference] = await Promise.all([loadImage(currentDataUrl), loadImage(refDataUrl)]);

      // Shared helpers — defined first so both phases can use them
      const needle = String(targetText || "").toLowerCase();
      const wantedRole = String(fallbackRole || targetRole || "").toLowerCase();
      const seen = new Set();
      const out = [];
      const add = (sel) => { if (sel && !seen.has(sel)) { seen.add(sel); out.push(sel); } };
      const attr = (v) => String(v).replace(/["\\]/g, "\\$&");
      const textOf = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ");
      const selectorsFor = (el) => {
        const tag = el.tagName.toLowerCase();
        const id = el.getAttribute("id");
        const testId = el.getAttribute("data-testid");
        const name = el.getAttribute("name");
        const aria = el.getAttribute("aria-label");
        const placeholder = el.getAttribute("placeholder");
        const text = textOf(el);
        if (id) add(`#${CSS.escape(id)}`);
        if (testId) add(`[data-testid="${attr(testId)}"]`);
        if (name) add(`${tag}[name="${attr(name)}"]`);
        if (aria) add(`${tag}[aria-label="${attr(aria)}"]`);
        if (placeholder) add(`${tag}[placeholder="${attr(placeholder)}"]`);
        if (wantedRole && text) add(`role=${wantedRole}[name="${attr(text)}"]`);
        if (text) add(`text=${JSON.stringify(text)}`);
      };
      const score = (el, component) => {
        if (!el || el === document.body || el === document.documentElement) return -1;
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return -1;
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return -1;
        const text = textOf(el).toLowerCase();
        const role = (el.getAttribute("role") || el.tagName).toLowerCase();
        let value = component.count;
        if (needle && text.includes(needle)) value += 10000;
        if (wantedRole && role.includes(wantedRole)) value += 2000;
        if (/^(button|input|textarea|select|a)$/i.test(el.tagName)) value += 1000;
        return value;
      };

      // Phase 1: Red box hint — find original element position marked in reference screenshot
      {
        const rb = document.createElement("canvas");
        rb.width = reference.naturalWidth; rb.height = reference.naturalHeight;
        const rbCtx = rb.getContext("2d", { willReadFrequently: true });
        rbCtx.drawImage(reference, 0, 0);
        const rbData = rbCtx.getImageData(0, 0, rb.width, rb.height).data;
        let rbMinX = rb.width, rbMaxX = 0, rbMinY = rb.height, rbMaxY = 0, rbCount = 0;
        for (let y = 0; y < rb.height; y++) {
          for (let x = 0; x < rb.width; x++) {
            const i = (y * rb.width + x) * 4;
            if (rbData[i] > 200 && rbData[i + 1] < 80 && rbData[i + 2] < 80) {
              if (x < rbMinX) rbMinX = x; if (x > rbMaxX) rbMaxX = x;
              if (y < rbMinY) rbMinY = y; if (y > rbMaxY) rbMaxY = y;
              rbCount++;
            }
          }
        }
        if (rbCount > 20) {
          const scX = current.naturalWidth / rb.width;
          const scY = current.naturalHeight / rb.height;
          const rbCX = ((rbMinX + rbMaxX) / 2) * scX;
          const rbCY = ((rbMinY + rbMaxY) / 2) * scY;
          for (const el of document.elementsFromPoint(rbCX, rbCY)) {
            for (let cur = el; cur && cur !== document.body; cur = cur.parentElement) {
              if (score(cur, { count: 50000 }) > 0) { selectorsFor(cur); break; }
            }
          }
        }
      }

      // Phase 2: Pixel diff — find changed regions as secondary fallback
      const scale = Math.min(1, 180 / Math.max(current.naturalWidth, current.naturalHeight, reference.naturalWidth, reference.naturalHeight));
      const width = Math.max(1, Math.floor(Math.min(current.naturalWidth, reference.naturalWidth) * scale));
      const height = Math.max(1, Math.floor(Math.min(current.naturalHeight, reference.naturalHeight) * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width * 2; canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(current, 0, 0, width, height);
      context.drawImage(reference, width, 0, width, height);
      const a = context.getImageData(0, 0, width, height).data;
      const b = context.getImageData(width, 0, width, height).data;
      const changed = new Uint8Array(width * height);
      for (let i = 0, p = 0; i < a.length; i += 4, p++) {
        changed[p] = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 42 ? 1 : 0;
      }

      const components = [];
      const queue = [];
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const start = y * width + x;
          if (!changed[start]) continue;
          changed[start] = 0;
          let minX = x, maxX = x, minY = y, maxY = y, count = 0;
          queue.length = 0;
          queue.push(start);
          for (let q = 0; q < queue.length; q++) {
            const idx = queue[q];
            const cx = idx % width;
            const cy = (idx / width) | 0;
            count++;
            if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
            if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
            const next = [idx - 1, idx + 1, idx - width, idx + width];
            for (const ni of next) {
              if (ni < 0 || ni >= changed.length || !changed[ni]) continue;
              const nx = ni % width;
              if ((ni === idx - 1 || ni === idx + 1) && Math.abs(nx - cx) !== 1) continue;
              changed[ni] = 0;
              queue.push(ni);
            }
          }
          if (count >= 6) components.push({ minX, maxX, minY, maxY, count });
        }
      }

      const scaleX = current.naturalWidth / width;
      const scaleY = current.naturalHeight / height;
      components
        .sort((l, r) => r.count - l.count)
        .map((component) => {
          const x = ((component.minX + component.maxX + 1) / 2) * scaleX;
          const y = ((component.minY + component.maxY + 1) / 2) * scaleY;
          let best = null, bestScore = -1;
          for (const el of document.elementsFromPoint(x, y)) {
            for (let cur = el; cur && cur !== document.body; cur = cur.parentElement) {
              const v = score(cur, component);
              if (v > bestScore) { best = cur; bestScore = v; }
            }
          }
          return { best, bestScore };
        })
        .sort((l, r) => r.bestScore - l.bestScore)
        .forEach(({ best }) => { if (best) selectorsFor(best); });

      return out;
    }, payload);
  } catch (_) {
    return null;
  }

  const selectorCandidates = uniqueStrings(candidates);
  if (!selectorCandidates.length) return null;
  return { layer: 2, strategy: "selector_fallback", candidates: selectorCandidates, recovery_entry: entry };
}

async function runLayer(layer, ctx) {
  tracker.send(`${ctx.skill}:${ctx.step}:${layer}`);
  const entry = getRecoveryEntry(ctx);
  switch (layer) {
    case 1: return runStoredAlternatives(ctx, entry);
    case 2: return runVisualSpatial(ctx, entry);
    case 3: return runAgentRecovery(ctx, entry);
    default: throw new Error(`Unknown recovery layer: ${layer}`);
  }
}

async function runRecovery(ctx) {
  for (const layer of [1, 2, 3]) {
    const result = await runLayer(layer, ctx);
    if (result) return result;
  }
  tracker.send(`${ctx.skill}:${ctx.step}:0`);
  throw new Error(`All recovery layers exhausted for ${ctx.skill}:${ctx.step}`);
}

module.exports = { runLayer, runRecovery };
