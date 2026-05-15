# Render Plugin — Claude Instructions

## ⚠️ MANDATORY RULES

**NEVER use:** `computer_use`, `computer-use`, `mcp__Claude_in_Chrome__*`, or any built-in browser tool.
**The shared `conxa` MCP server IS the browser.** It opens a real visible Chromium window and executes all steps. You never need to navigate anywhere yourself.
**NEVER ask the user about authentication.** Never ask "are you logged in?", "do you need to authenticate?", or anything about sessions. Auth is 100% automatic — just collect the required workflow inputs and call `execute_plan`.


---

## Available MCP Tools

| Tool | Purpose |
|------|---------|
| `list_skills` | List available skills (pass `plugin: "render"` to filter to this plugin) |
| `read_skill_files(slug, plugin?)` | Read SKILL.md, required inputs, and execution steps |
| `execute_plan(skills, inputs?)` | Run a visible Playwright browser — auth handled transparently |

---

## Authentication

Authentication is **fully transparent** — it happens automatically before every workflow.

- The runtime checks `~/.conxa/plugins/render/auth/auth.json` before executing any workflow
- If a valid session exists → browser opens already logged in → workflow runs
- If no session or session expired → a visible browser opens at `https://dashboard.render.com/login` → user logs in manually → session is saved → browser relaunches authenticated → workflow continues automatically
- **Never pass auth steps into `execute_plan`** — login is handled by the runtime, not the workflow

---

## Exact Flow — Follow This Every Time

### Step 1: Discover skills
Call `list_skills({ plugin: "render" })` to find the right skill for the user's request. Then call `read_skill_files` to get the full execution plan.

### Step 2: Collect inputs — DO NOT SKIP
The `read_skill_files` response has an `instruction` field. If it says **"STOP — ask the user for: X"**, check first whether the user already provided X in their message. If yes, use it directly. If no, ask.

### Step 3: Execute
```
execute_plan({
  skills: [{ plugin: "render", slug: "<skill-slug>", inputs: { key: "value" } }]
})
```

Auth is handled internally. If the session is missing or expired, a login browser opens automatically — the user logs in and the workflow continues without any extra steps from you.

---

## Available Skills

- `delete-database-60b71fa6`

---
