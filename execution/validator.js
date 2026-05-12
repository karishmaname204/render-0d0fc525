const fs = require("fs");
const path = require("path");

function skillDir(name) {
  return path.join(__dirname, "..", "skills", name);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function validateInput(skillName, inputs) {
  const inputPath = path.join(skillDir(skillName), "input.json");
  if (!fs.existsSync(inputPath)) return;
  const schema = readJson(inputPath);
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) {
    throw new Error("Inputs must be an object");
  }

  for (const field of schema.inputs || []) {
    const name = field.name;
    const value = inputs[name];

    if (!field.optional && (value === undefined || value === null || value === "")) {
      throw new Error(`Missing required input: ${name}`);
    }
    if (value === undefined || value === null || value === "") continue;

    if (field.type) {
      const actual = Array.isArray(value) ? "array" : typeof value;
      if (field.type === "integer") {
        if (!Number.isInteger(value)) throw new Error(`Invalid input type for ${name}: expected integer`);
      } else if (field.type === "array") {
        if (!Array.isArray(value)) throw new Error(`Invalid input type for ${name}: expected array`);
      } else if (field.type === "object") {
        if (actual !== "object" || Array.isArray(value)) {
          throw new Error(`Invalid input type for ${name}: expected object`);
        }
      } else if (actual !== field.type) {
        throw new Error(`Invalid input type for ${name}: expected ${field.type}`);
      }
    }

    const allowed = field.enum || field.options;
    if (allowed && !allowed.includes(value)) {
      throw new Error(`Invalid input value for ${name}: expected one of ${allowed.join(", ")}`);
    }

    if (typeof value === "string") {
      if (field.minLength !== undefined && value.length < field.minLength) {
        throw new Error(`Invalid input length for ${name}: minimum ${field.minLength}`);
      }
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        throw new Error(`Invalid input length for ${name}: maximum ${field.maxLength}`);
      }
      if (field.pattern && !(new RegExp(field.pattern).test(value))) {
        throw new Error(`Invalid input format for ${name}`);
      }
    }
  }
}

function validateOutput(skillName, output) {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new Error("Output must be an object");
  }
  if (output.skill !== skillName) {
    throw new Error(`Output skill mismatch: expected ${skillName}`);
  }
  if (typeof output.passed !== "boolean") {
    throw new Error("Output field 'passed' must be boolean");
  }
  if (!Array.isArray(output.steps)) {
    throw new Error("Output field 'steps' must be an array");
  }
  if (!output.summary || typeof output.summary !== "object" || Array.isArray(output.summary)) {
    throw new Error("Output field 'summary' must be an object");
  }

  const counts = { ok: 0, recovered: 0, failed: 0 };
  const allowedStatuses = new Set(["ok", "recovered", "failed"]);
  for (let i = 0; i < output.steps.length; i++) {
    const step = output.steps[i];
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      throw new Error(`Output step ${i + 1} must be an object`);
    }
    if (step.step !== i + 1) {
      throw new Error(`Output step ${i + 1} has invalid step number`);
    }
    if (typeof step.type !== "string" || step.type === "") {
      throw new Error(`Output step ${i + 1} missing type`);
    }
    if (!allowedStatuses.has(step.status)) {
      throw new Error(`Output step ${i + 1} has invalid status`);
    }
    if (typeof step.latency_ms !== "number" || step.latency_ms < 0) {
      throw new Error(`Output step ${i + 1} has invalid latency_ms`);
    }
    counts[step.status]++;
  }

  const summary = output.summary;
  if (
    summary.total !== output.steps.length ||
    summary.ok !== counts.ok ||
    summary.recovered !== counts.recovered ||
    summary.failed !== counts.failed
  ) {
    throw new Error("Output summary does not match steps");
  }
  if (output.passed !== (counts.failed === 0)) {
    throw new Error("Output field 'passed' does not match failed step count");
  }

  const outputPath = path.join(skillDir(skillName), "output.json");
  if (!fs.existsSync(outputPath)) return;
  const schema = readJson(outputPath);
  for (const field of schema.outputs || []) {
    if (!field.optional && output[field.name] === undefined) {
      throw new Error(`Missing required output: ${field.name}`);
    }
  }
}

// Validate the current page URL against a url_state entry.
// Hard check: url_pattern must match (if present).
// Returns { ok: boolean, reason?: string }.
async function validateUrlState(page, urlState) {
  if (!urlState || typeof urlState !== "object") return { ok: true };
  const pattern = typeof urlState.url_pattern === "string" ? urlState.url_pattern.trim() : "";
  const titleIncludes = typeof urlState.title_includes === "string" ? urlState.title_includes.trim() : "";

  if (pattern) {
    let url;
    try { url = page.url(); } catch (_) { return { ok: true }; }
    let matches = false;
    try { matches = new RegExp(pattern).test(url); } catch (_) { matches = true; }
    if (!matches) {
      return { ok: false, reason: `URL ${url} does not match expected pattern ${pattern}` };
    }
  }

  if (titleIncludes) {
    try {
      const title = await page.title();
      if (!title.toLowerCase().includes(titleIncludes.toLowerCase())) {
        // Soft — log only, do not fail
        console.warn(`[validator] title "${title}" does not include "${titleIncludes}" (soft check)`);
      }
    } catch (_) {}
  }

  return { ok: true };
}

module.exports = { validateInput, validateOutput, validateUrlState };
