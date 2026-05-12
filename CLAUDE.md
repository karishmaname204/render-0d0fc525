# Render Plugin — Claude Instructions

## ⚠️ CRITICAL EXECUTION RULES

**NEVER use any of these tools:**
- `mcp__Claude_in_Chrome__*` (Chrome MCP browser tools)
- `computer_use` or `computer-use`
- Any built-in browser navigation or screenshot tools

**ALWAYS use this plugin's MCP tools to execute browser automation.**

---

## Available MCP Tools

| Tool | Purpose |
|------|---------|
| `bootstrap_auth` | Open browser for user to log in and save session |
| `list_skills` | List all available skills with metadata |
| `read_skill_files(slug)` | Get execution.json + recovery.json for a skill |
| `execute_plan(steps, inputs)` | Run a merged multi-skill plan via Playwright |
| Individual skill tools | Shortcut to run a single skill directly |

---

## Available Skills

- `delete-database-60b71fa6`

---

## Execution Flow

When the user asks you to do something on https://dashboard.render.com/login:

### Step 1: Identify Skills
Determine which skills are needed from the list above.
Example: "Delete my database" → needs: `bootstrap_auth` (if not authed) + `delete_database`

### Step 2: Load Skill Data
For each required skill, call:
```
read_skill_files(slug: "<skill-slug>")
```
This returns `execution` (steps array) and `recovery` (per-step fallbacks).

### Step 3: Merge into a Plan
Combine the steps from all skills into ONE sequence:
- Login steps come first
- Remove duplicate navigation (if multiple skills navigate to the same page, keep only one)
- Annotate each step with its recovery info from the recovery data
- Inject `{{input_key}}` placeholders with actual user-provided values

### Step 4: Execute the Plan
Call:
```
execute_plan(steps: [...merged steps...], inputs: {"key": "value"})
```
The plugin will run a visible Playwright browser and execute all steps. A screenshot is returned on success.

### Step 5: Handle Failures
If `execute_plan` returns an error:
- Check the error message for which step failed
- The step may have recovery alternatives (fallback_selectors, candidates)
- If recovery fails, reload skill files and adjust the plan
- Modify selectors or step order and retry `execute_plan`
- Continue until success or maximum recovery attempts exhausted

---

## Complete Example Flow

**User:** "Delete my database conxa-db"

**You do:**
1. Call `list_skills` → see available skills
2. Identify needed skills: `auth_login`, `delete_database`
3. Call `read_skill_files("auth_login")` → get login steps + recovery
4. Call `read_skill_files("delete_database")` → get delete steps + recovery
5. Merge: [login steps] + [navigate to DB] + [delete DB] + [confirm delete]
6. Call `execute_plan(steps=[merged], inputs={"database": "conxa-db"})`
7. Browser opens, executes all steps, closes
8. Return screenshot confirming deletion

---

## Authentication

If you get: *"Session expired. Ask Claude to call bootstrap_auth first."*
→ Call `bootstrap_auth` (opens a visible browser for the user to log in)
→ Once the user logs in and the browser closes, call `execute_plan` again

---

## Input Parameters

When calling `read_skill_files`, the response includes each step's `inputs` field.
Look for `{{key}}` placeholders in `value` fields — those are the required inputs to inject.
Always provide `inputs` to `execute_plan` with actual values, not placeholders.
