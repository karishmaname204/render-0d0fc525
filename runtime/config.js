"use strict";
const fs   = require("fs");
const os   = require("os");
const path = require("path");

const CONXA_HOME     = path.join(os.homedir(), ".conxa");
const REGISTRY_PATH  = path.join(CONXA_HOME, "registry.json");
const CONXA_CLAUDE_MD = path.join(CONXA_HOME, "CLAUDE.md");
const CONXA_INDEX_MD  = path.join(CONXA_HOME, "index.md");

function getPluginDir(slug) {
  return path.join(CONXA_HOME, "plugins", slug);
}

function getAuthJson(slug) {
  return path.join(CONXA_HOME, "plugins", slug, "auth", "auth.json");
}

function getPluginConfig(slug) {
  const cfgPath = path.join(getPluginDir(slug), "plugin.json");
  return JSON.parse(fs.readFileSync(cfgPath, "utf8"));
}

function getRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8")); } catch (_) { return {}; }
}

module.exports = {
  CONXA_HOME, REGISTRY_PATH, CONXA_CLAUDE_MD, CONXA_INDEX_MD,
  getPluginDir, getAuthJson, getPluginConfig, getRegistry,
};
