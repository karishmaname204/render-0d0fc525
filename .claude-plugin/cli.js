#!/usr/bin/env node
"use strict";
/**
 * cli.js — Conxa runtime manager
 *
 * Commands:
 *   init                Bootstrap ~/.conxa/runtime/ (idempotent)
 *   install <dir>       Install a plugin from a local directory
 *   uninstall <slug>    Remove an installed plugin
 *   list                Print all installed plugins
 *   discover            Scan ~/.claude/plugins/marketplaces/ and install new plugins
 */
const fs   = require("fs");
const os   = require("os");
const path = require("path");
const { execSync } = require("child_process");

const CONXA_HOME      = path.join(os.homedir(), ".conxa");
const RUNTIME_DIR     = path.join(CONXA_HOME, "runtime");
const PLUGINS_DIR     = path.join(CONXA_HOME, "plugins");
const REGISTRY_PATH   = path.join(CONXA_HOME, "registry.json");
const CONXA_CLAUDE_MD = path.join(CONXA_HOME, "CLAUDE.md");
const CONXA_INDEX_MD  = path.join(CONXA_HOME, "index.md");
const VERSION_JSON    = path.join(RUNTIME_DIR, "version.json");

const CLAUDE_PLUGINS_DIR = path.join(os.homedir(), ".claude", "plugins", "marketplaces");

// ─── Registry helpers ─────────────────────────────────────────────────────────

function readRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8")); } catch (_) { return {}; }
}

function writeRegistry(reg) {
  fs.mkdirSync(CONXA_HOME, { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
}

// ─── Discovery file helpers ───────────────────────────────────────────────────

function updateGlobalClaudeMd(reg) {
  const entries = Object.values(reg);
  const pluginLines = entries.length === 0
    ? "- (no plugins installed)"
    : entries.map(e => `- ${e.slug}  →  ~/.conxa/plugins/${e.slug}/CLAUDE.md`).join("\n");

  const content = [
    "# Conxa Runtime",
    "",
    "You have the Conxa automation runtime. It executes real Playwright browser workflows.",
    "",
    "## Mandatory Rules",
    "- NEVER use computer_use, computer-use, or any built-in browser tool",
    "- NEVER ask the user about authentication — auth is 100% automatic",
    "- Always call list_skills before execute_plan",
    "",
    "## Discovery Flow",
    "1. Call list_skills to see all installed plugins and available skills",
    "2. For plugin-specific instructions, read ~/.conxa/plugins/{slug}/CLAUDE.md",
    "3. For skill details, read ~/.conxa/plugins/{slug}/index.md",
    "",
    "## Installed Plugins",
    pluginLines,
    "",
  ].join("\n");

  fs.mkdirSync(CONXA_HOME, { recursive: true });
  fs.writeFileSync(CONXA_CLAUDE_MD, content, "utf8");
}

function regenerateIndex(reg) {
  const entries = Object.values(reg);
  const rows = entries.map(e => {
    const skills = (e.skills || []).map(s => s.slug).join(", ") || "—";
    return `| ${e.slug} | ${e.name || e.slug} | ${skills} | ${e.target_url || "—"} |`;
  });

  const lines = [
    "# Conxa Plugin Index",
    "",
    "| Slug | Name | Skills | Target |",
    "|------|------|--------|--------|",
    ...rows,
    "",
  ];

  fs.mkdirSync(CONXA_HOME, { recursive: true });
  fs.writeFileSync(CONXA_INDEX_MD, lines.join("\n"), "utf8");
}

// ─── Copy directory recursively ───────────────────────────────────────────────

function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

// ─── init ─────────────────────────────────────────────────────────────────────

function init() {
  if (fs.existsSync(VERSION_JSON)) {
    const v = JSON.parse(fs.readFileSync(VERSION_JSON, "utf8"));
    process.stderr.write(`[conxa] Runtime already bootstrapped at ${RUNTIME_DIR} (v${v.version})\n`);
    return;
  }
  process.stderr.write(`[conxa] Bootstrapping runtime at ${RUNTIME_DIR} ...\n`);

  const srcDir = path.join(__dirname, "..", "runtime");
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  for (const file of ["server.js", "run.js", "browser.js", "config.js", "runtime.js", "package.json", "cli.js"]) {
    const src = path.join(srcDir, file);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(RUNTIME_DIR, file));
  }

  process.stderr.write("[conxa] Running npm install...\n");
  execSync("npm install --prefer-offline --silent", { cwd: RUNTIME_DIR, stdio: ["ignore", "pipe", "inherit"] });

  process.stderr.write("[conxa] Installing Playwright Chromium...\n");
  execSync("npx playwright install chromium", { cwd: RUNTIME_DIR, stdio: ["ignore", "pipe", "inherit"] });

  const pkg = fs.existsSync(path.join(RUNTIME_DIR, "package.json"))
    ? JSON.parse(fs.readFileSync(path.join(RUNTIME_DIR, "package.json"), "utf8"))
    : {};
  fs.writeFileSync(VERSION_JSON, JSON.stringify({
    version: pkg.version || "1.0.0",
    installed_at: new Date().toISOString(),
    node_version: process.version,
  }, null, 2));

  // Write initial global CLAUDE.md and index.md with empty registry
  updateGlobalClaudeMd({});
  regenerateIndex({});

  // Write bootstrap flag so subsequent plugin installs skip re-init
  fs.writeFileSync(path.join(CONXA_HOME, ".bootstrapped"), "1", "utf8");

  process.stderr.write("[conxa] Bootstrap complete.\n");
}

// ─── install ──────────────────────────────────────────────────────────────────

function install(pluginDir) {
  if (!pluginDir) throw new Error("install: plugin directory path required");
  const absDir = path.resolve(pluginDir);
  if (!fs.existsSync(absDir)) throw new Error(`Plugin directory not found: ${absDir}`);

  const cfgPath = path.join(absDir, "plugin.json");
  if (!fs.existsSync(cfgPath)) throw new Error(`No plugin.json found in ${absDir}`);

  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  if (!cfg.slug)          throw new Error("plugin.json missing: slug");
  if (!cfg.target_url)    throw new Error("plugin.json missing: target_url");
  if (!cfg.protected_url) throw new Error("plugin.json missing: protected_url");

  const slug    = cfg.slug;
  const destDir = path.join(PLUGINS_DIR, slug);

  process.stderr.write(`[conxa] Installing plugin '${slug}' from ${absDir}...\n`);
  fs.mkdirSync(destDir, { recursive: true });

  // Copy plugin manifest
  fs.copyFileSync(cfgPath, path.join(destDir, "plugin.json"));

  // Copy discovery files
  for (const name of ["CLAUDE.md", "index.md", "schema.json", "README.md"]) {
    const src = path.join(absDir, name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(destDir, name));
  }

  // Copy skills/
  const skillsSrc = path.join(absDir, "skills");
  if (fs.existsSync(skillsSrc)) copyDirSync(skillsSrc, path.join(destDir, "skills"));

  // Copy auth/credentials.example.json (never auth.json)
  const credsEx = path.join(absDir, "auth", "credentials.example.json");
  if (fs.existsSync(credsEx)) {
    fs.mkdirSync(path.join(destDir, "auth"), { recursive: true });
    fs.copyFileSync(credsEx, path.join(destDir, "auth", "credentials.example.json"));
  }

  // Update master registry
  const skillsList = (cfg.skills || []).map(s => ({ slug: s.slug, path: s.path || `skills/${s.slug}` }));
  const entry = {
    slug,
    name:          cfg.name,
    version:       cfg.version || "1.0.0",
    path:          destDir,
    target_url:    cfg.target_url,
    protected_url: cfg.protected_url,
    skills:        skillsList,
    installed_at:  new Date().toISOString(),
  };
  const reg = readRegistry();
  reg[slug] = entry;
  writeRegistry(reg);

  // Regenerate global discovery files
  updateGlobalClaudeMd(reg);
  regenerateIndex(reg);

  process.stderr.write(`[conxa] Plugin '${slug}' installed. Skills: ${skillsList.map(s => s.slug).join(", ")}\n`);
  return entry;
}

// ─── uninstall ────────────────────────────────────────────────────────────────

function uninstall(slug) {
  if (!slug) throw new Error("uninstall: slug required");
  const destDir = path.join(PLUGINS_DIR, slug);
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
    process.stderr.write(`[conxa] Removed plugin directory: ${destDir}\n`);
  }
  const reg = readRegistry();
  if (reg[slug]) {
    delete reg[slug];
    writeRegistry(reg);
    updateGlobalClaudeMd(reg);
    regenerateIndex(reg);
    process.stderr.write(`[conxa] Removed '${slug}' from registry\n`);
  } else {
    process.stderr.write(`[conxa] Plugin '${slug}' was not in registry\n`);
  }
}

// ─── list ─────────────────────────────────────────────────────────────────────

function list() {
  const reg = readRegistry();
  const entries = Object.values(reg);
  if (entries.length === 0) {
    process.stderr.write("[conxa] No plugins installed.\n");
    return;
  }
  for (const e of entries) {
    process.stderr.write(`  ${e.slug}  v${e.version}  skills: ${(e.skills || []).map(s => s.slug).join(", ")}\n`);
  }
}

// ─── discover ─────────────────────────────────────────────────────────────────

function discover() {
  if (!fs.existsSync(CLAUDE_PLUGINS_DIR)) return;
  const reg = readRegistry();
  let found = 0;
  for (const market of fs.readdirSync(CLAUDE_PLUGINS_DIR)) {
    const marketDir = path.join(CLAUDE_PLUGINS_DIR, market);
    if (!fs.statSync(marketDir).isDirectory()) continue;
    const cfgPath = path.join(marketDir, "plugin.json");
    if (!fs.existsSync(cfgPath)) continue;
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch (_) { continue; }
    const slug = cfg.slug;
    if (!slug) continue;
    if (reg[slug]) continue;
    try {
      install(marketDir);
      found++;
    } catch (e) {
      process.stderr.write(`[conxa] discover: failed to install ${marketDir}: ${e.message}\n`);
    }
  }
  if (found > 0) process.stderr.write(`[conxa] discover: installed ${found} new plugin(s)\n`);
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, cmd, ...rest] = process.argv;
  try {
    switch (cmd) {
      case "init":      init();             break;
      case "install":   install(rest[0]);   break;
      case "uninstall": uninstall(rest[0]); break;
      case "list":      list();             break;
      case "discover":  discover();         break;
      default:
        process.stderr.write("Usage: cli.js <init|install <dir>|uninstall <slug>|list|discover>\n");
        process.exit(1);
    }
  } catch (e) {
    process.stderr.write(`[conxa] Error: ${e.message}\n`);
    process.exit(1);
  }
}

module.exports = { init, install, uninstall, list, discover };
