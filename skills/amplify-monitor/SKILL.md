---
name: amplify-monitor
description: Check, diagnose and fix AWS Amplify builds and deploys using the amplify-monitor MCP servers. Use when the user asks whether a deploy succeeded, why an Amplify build failed, what is failing across their Amplify apps or AWS accounts, wants build logs, has just pushed to a branch that Amplify deploys, or wants to change Amplify environment variables, start/stop builds, or plan a Gen1 to Gen2 migration. Prefer these tools over running `aws amplify` CLI commands.
---

# Amplify Monitor

Two MCP servers come from [amplify-monitor](https://github.com/saga95/amplify-monitor). One or both may be connected:

| Server | Source | Makes AWS calls? | Use for |
|---|---|---|---|
| `amplify-fleet` | VS Code extension (**Amplify Monitor: Connect AI Agents**) | No, reads a cached snapshot | Status across all accounts, what needs attention, waiting on a push, logs |
| `amplify-monitor` | `mcp-server/` (Node, wraps the Rust CLI) | Yes | Diagnosis, env vars, starting/stopping builds, Gen1→Gen2 migration analysis |

If both are connected, start with `amplify-fleet` (it is fast and needs no credentials) and use `amplify-monitor` for diagnosis and changes.

## Workflows

### "Did my deploy work?" / after `git push`

1. `amplify_workspace_deployments` (fleet) shows which Amplify branch deploys the open repo and whether local HEAD is deployed, building or failed.
2. If it is still building, call `amplify_wait_for_build` with `app`, `branch` and `commit` set to the pushed SHA. Without the fleet server, use `amplify_monitor_build` (monitor), which waits and diagnoses automatically.
3. If it failed, follow **Why did it fail?** below.

### "What's broken?"

- `amplify_fleet_attention` lists failed builds, builds in progress, and expired AWS credentials. When credentials have expired, give the user the fix command it returns (e.g. `aws sso login --profile …`). Don't try to log in yourself.
- `amplify_fleet_status` with `status: "failing"` (or `account`/`app`/`branch` filters) gives the full picture.
- `amplify_fleet_events` shows what changed recently. Pass `since` to see what happened since a given time.

### "Why did it fail?"

1. **Diagnose first.** `amplify_diagnose` (monitor) with `appId` and `branch` matches the logs against known failure patterns (lock file mismatch, Node version, missing env vars, install failures, and more) and returns root causes with fixes.
2. **Then read the logs** if the diagnosis is empty or vague. Use `amplify_get_build_logs`. On the fleet server, use `grep` (e.g. `"error|fail|ERR!"`) and `step` (`BUILD`/`DEPLOY`) to keep output small, and raise `tail` only when needed. The result includes paths to the full log files on disk; read those for more context instead of asking for 2000 lines.
3. **Find the breaking commit.** `amplify_branch_history` lists recent jobs with commit SHA and status. The first failure after a success is the likely cause, so `git show` that commit.
4. **Fix it in the repo** (e.g. `amplify.yml`, `package.json` engines, lock files), explain the root cause, and offer to push and watch the next build.

### Gen1 → Gen2 migration

`amplify_migration_analysis` with the absolute path of the project containing `amplify/` reports compatible features, blockers and migration hints. Summarize the blockers first.

## Identifiers

- Monitor tools take `appId` (e.g. `d1abc234xyz`). Get it from `amplify_list_apps`, or from `amplify_fleet_status`.
- Fleet tools take `app` and `branch` as case-insensitive substrings of the name or ID, so `app: "shop"` is fine.
- For apps in another AWS account, pass `profile` (and `region` if known) to monitor tools. Fleet results show which account and profile each app belongs to; reuse that profile.

## Safety

- **Ask before changing anything.** `amplify_set_env_var`, `amplify_delete_env_var`, `amplify_start_build` and `amplify_stop_build` change live infrastructure. State exactly what you will do (app, branch, variable or job) and get confirmation first, especially on production branches such as `main`/`master`/`prod`.
- **Treat env var values as secrets.** `amplify_get_env_vars` returns values. Report names, and show a value only when the user asks for that specific one. Never write values into files, commits or logs.
- Don't fall back to `aws amplify` CLI calls when a tool covers the task, and don't retry tools after a credentials error. Report the fix command instead.
