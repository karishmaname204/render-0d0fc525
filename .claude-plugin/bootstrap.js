#!/usr/bin/env node
"use strict";
const fs   = require("fs");
const os   = require("os");
const path = require("path");
const { execSync, fork } = require("child_process");

const CONXA_HOME       = path.join(os.homedir(), ".conxa");
const RUNTIME_DIR      = path.join(CONXA_HOME, "runtime");
const SERVER_JS        = path.join(RUNTIME_DIR, "server.js");
const PID_FILE         = path.join(RUNTIME_DIR, "server.pid");
const BOOTSTRAP_FLAG   = path.join(CONXA_HOME, ".bootstrapped");
const SETTINGS_JSON    = path.join(os.homedir(), ".claude", "settings.json");
const GLOBAL_CLAUDE_MD = path.join(os.homedir(), ".claude", "CLAUDE.md");
const CONXA_CLAUDE_MD  = path.join(CONXA_HOME, "CLAUDE.md");

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

function installThisPlugin() {
  const pluginDir = path.join(__dirname, "..");
  const runtimeCli = path.join(RUNTIME_DIR, "cli.js");
  const cli = fs.existsSync(runtimeCli) ? runtimeCli : path.join(__dirname, "cli.js");
  try {
    execSync(`node "${cli}" install "${pluginDir}"`, { stdio: ["ignore", "pipe", "inherit"] });
  } catch (e) {
    process.stderr.write(`[conxa] Warning: plugin install step failed: ${e.message}\n`);
  }
}

function isServerRunning() {
  if (!fs.existsSync(PID_FILE)) return false;
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
    if (isNaN(pid)) return false;
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function startServer() {
  if (isServerRunning()) {
    process.stderr.write("[conxa] Shared runtime already running, plugin data installed.\n");
    process.exit(0);
    return;
  }
  const child = fork(SERVER_JS, [], { stdio: "inherit" });
  try { fs.writeFileSync(PID_FILE, String(child.pid)); } catch (_) {}
  child.on("exit", code => {
    try { fs.unlinkSync(PID_FILE); } catch (_) {}
    process.exit(code || 0);
  });
}

if (fs.existsSync(BOOTSTRAP_FLAG) && fs.existsSync(SERVER_JS)) {
  registerGlobalMcp();
  registerGlobalClaudeMd();
  installThisPlugin();
  startServer();
} else {
  const srcCli = path.join(__dirname, "cli.js");
  if (!fs.existsSync(srcCli)) {
    process.stderr.write("[conxa] bootstrap: cli.js not found next to bootstrap.js\n");
    process.exit(1);
  }
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  try {
    execSync(`node "${srcCli}" init`, { stdio: ["ignore", "pipe", "inherit"] });
  } catch (e) {
    process.stderr.write(`[conxa] bootstrap: init failed: ${e.message}\n`);
    process.exit(1);
  }
  if (!fs.existsSync(SERVER_JS)) {
    process.stderr.write("[conxa] bootstrap: server.js not found after init\n");
    process.exit(1);
  }
  registerGlobalMcp();
  registerGlobalClaudeMd();
  installThisPlugin();
  startServer();
}
