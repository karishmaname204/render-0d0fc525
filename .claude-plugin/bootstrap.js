#!/usr/bin/env node
"use strict";
/**
 * bootstrap.js — One-time shim that installs the shared Conxa runtime.
 *
 * Claude Code starts this file as the `conxa` MCP server on first install.
 * It bootstraps ~/.conxa/runtime/, registers the shared MCP server in
 * ~/.claude/settings.json, injects the Conxa discovery CLAUDE.md into the
 * global ~/.claude/CLAUDE.md, installs this plugin's data, then delegates
 * to the real server.js.
 */
const fs   = require("fs");
const os   = require("os");
const path = require("path");
const { execSync, fork } = require("child_process");

const CONXA_HOME    = path.join(os.homedir(), ".conxa");
const RUNTIME_DIR   = path.join(CONXA_HOME, "runtime");
const SERVER_JS     = path.join(RUNTIME_DIR, "server.js");
const VERSION_JSON  = path.join(RUNTIME_DIR, "version.json");
const SETTINGS_JSON = path.join(os.homedir(), ".claude", "settings.json");
const GLOBAL_CLAUDE_MD = path.join(os.homedir(), ".claude", "CLAUDE.md");
const CONXA_CLAUDE_MD  = path.join(CONXA_HOME, "CLAUDE.md");

// Inject @~/.conxa/CLAUDE.md import into ~/.claude/CLAUDE.md (idempotent).
function registerGlobalClaudeMd() {
  const importLine = `@${CONXA_CLAUDE_MD}`;
  let existing = "";
  try { existing = fs.readFileSync(GLOBAL_CLAUDE_MD, "utf8"); } catch (_) {}
  if (existing.includes(importLine)) return;
  fs.mkdirSync(path.dirname(GLOBAL_CLAUDE_MD), { recursive: true });
  const separator = existing && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(GLOBAL_CLAUDE_MD, `${separator}\n${importLine}\n`, "utf8");
  process.stderr.write(`[conxa] Registered ~/.conxa/CLAUDE.md in ${GLOBAL_CLAUDE_MD}\n`);
}

// Patch ~/.claude/settings.json to register the shared conxa MCP server (idempotent).
function registerGlobalMcp() {
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(SETTINGS_JSON, "utf8")); } catch (_) {}
  const existing = settings.mcpServers && settings.mcpServers.conxa;
  if (existing && existing.args && existing.args[0] === SERVER_JS) return;
  if (!settings.mcpServers) settings.mcpServers = {};
  settings.mcpServers.conxa = { command: "node", args: [SERVER_JS] };
  try {
    fs.mkdirSync(path.dirname(SETTINGS_JSON), { recursive: true });
    fs.writeFileSync(SETTINGS_JSON, JSON.stringify(settings, null, 2) + "\n", "utf8");
    process.stderr.write(`[conxa] Registered shared MCP server in ${SETTINGS_JSON}\n`);
  } catch (e) {
    process.stderr.write(`[conxa] Warning: could not update settings.json: ${e.message}\n`);
  }
}

// Install this plugin's data into ~/.conxa/plugins/ via the runtime CLI (idempotent).
function installThisPlugin() {
  const pluginDir = path.join(__dirname, "..");
  const runtimeCli = path.join(RUNTIME_DIR, "cli.js");
  const cli = fs.existsSync(runtimeCli) ? runtimeCli : path.join(__dirname, "cli.js");
  try {
    execSync(`node "${cli}" install "${pluginDir}"`, { stdio: "inherit" });
  } catch (e) {
    process.stderr.write(`[conxa] Warning: plugin install step failed: ${e.message}\n`);
  }
}

function startServer() {
  const child = fork(SERVER_JS, [], { stdio: "inherit" });
  child.on("exit", code => process.exit(code || 0));
}

if (fs.existsSync(VERSION_JSON)) {
  // Runtime already installed — register (idempotent), install plugin data, start.
  registerGlobalMcp();
  registerGlobalClaudeMd();
  installThisPlugin();
  startServer();
} else {
  // First install: bootstrap runtime from the sibling cli.js.
  const srcCli = path.join(__dirname, "cli.js");
  if (!fs.existsSync(srcCli)) {
    process.stderr.write("[conxa] bootstrap: cli.js not found next to bootstrap.js\n");
    process.exit(1);
  }
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  try {
    execSync(`node "${srcCli}" init`, { stdio: "inherit" });
  } catch (e) {
    process.stderr.write(`[conxa] bootstrap: init failed: ${e.message}\n`);
    process.exit(1);
  }
  if (!fs.existsSync(SERVER_JS)) {
    process.stderr.write("[conxa] bootstrap: server.js still not found after init\n");
    process.exit(1);
  }
  registerGlobalMcp();
  registerGlobalClaudeMd();
  installThisPlugin();
  startServer();
}
