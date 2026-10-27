#!/usr/bin/env node
/**
 * Amplify Fleet MCP server (stdio, zero dependencies).
 *
 * Serves the multi-account status snapshot that the Amplify Monitor VS Code
 * extension keeps up to date, so AI agents (Claude Code, Codex, Antigravity,
 * Copilot, Cursor, ...) can answer "what is deployed / what is failing" without
 * running the AWS CLI or holding AWS credentials themselves.
 *
 * It never calls AWS. Every tool reads <fleetDir>/status.json.
 */
import * as fs from 'fs';
import * as path from 'path';
import { defaultFleetDir, readSnapshot, relativeTime, renderMarkdown, SNAPSHOT_JSON, statusIcon } from './snapshotStore';
import { FleetBranch, FleetSnapshot, TERMINAL_JOB_STATUSES, shortSha } from './types';
import { formatJobLogs, newLogRequest, readJobLogs, readLogRequestResult, resolveLogTarget, writeLogRequest } from './buildLogs';

const SERVER_NAME = 'amplify-fleet';
const SERVER_VERSION = '1.0.0';
const DEFAULT_PROTOCOL = '2025-06-18';

function fleetDir(): string {
    if (process.env.AMPLIFY_MONITOR_FLEET_DIR) {
        return process.env.AMPLIFY_MONITOR_FLEET_DIR;
    }
    // When installed by the extension the server lives in <fleetDir>/server/.
    const parent = path.resolve(__dirname, '..');
    if (fs.existsSync(path.join(parent, SNAPSHOT_JSON))) {
        return parent;
    }
    return defaultFleetDir();
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const filterProps = {
    account: { type: 'string', description: 'Filter by account label or AWS profile name (case-insensitive substring).' },
    app: { type: 'string', description: 'Filter by Amplify app name or app ID (case-insensitive substring).' },
    branch: { type: 'string', description: 'Filter by branch name (case-insensitive substring).' },
};

const tools = [
    {
        name: 'amplify_fleet_status',
        description: 'Current build/deploy status of every Amplify app and branch across all AWS accounts the developer monitors in VS Code. '
            + 'Includes the latest job status, commit SHA and message for each branch. Reads a cached snapshot (no AWS calls). '
            + 'Use this instead of running `aws amplify` commands.',
        inputSchema: {
            type: 'object',
            properties: {
                ...filterProps,
                status: { type: 'string', enum: ['failing', 'building', 'ok', 'warning', 'error', 'unknown'], description: 'Only branches with this health.' },
                format: { type: 'string', enum: ['markdown', 'json'], description: 'Output format (default markdown).' },
            },
        },
    },
    {
        name: 'amplify_fleet_attention',
        description: 'Only what needs attention right now: failed builds, builds in progress, and AWS accounts whose credentials expired (with the fix command).',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'amplify_branch_history',
        description: 'Recent Amplify jobs (commit SHA, message, status, duration) for one branch. Useful to find which commit broke a build.',
        inputSchema: {
            type: 'object',
            properties: { ...filterProps },
            required: ['app', 'branch'],
        },
    },
    {
        name: 'amplify_workspace_deployments',
        description: 'For git repositories open in VS Code: which Amplify branches deploy them and whether the local HEAD commit is deployed, building, failed or not built yet.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'amplify_fleet_events',
        description: 'Recent build transitions (started, succeeded, failed, cancelled) and account credential problems, newest first.',
        inputSchema: {
            type: 'object',
            properties: {
                since: { type: 'string', description: 'ISO timestamp; only events after it.' },
                limit: { type: 'number', description: 'Max events (default 20).' },
            },
        },
    },
    {
        name: 'amplify_get_build_logs',
        description: 'Build/deploy output of an Amplify job: error lines first, then the end of each step log (BUILD, DEPLOY, ...), plus paths to the full log files. '
            + 'Defaults to the latest job on the branch. Logs are fetched and cached by the VS Code extension; the agent makes no AWS calls.',
        inputSchema: {
            type: 'object',
            properties: {
                ...filterProps,
                jobId: { type: 'string', description: 'Job number (e.g. "104"). Defaults to the latest job.' },
                step: { type: 'string', description: 'BUILD, DEPLOY, VERIFY or ALL (default ALL).' },
                tail: { type: 'number', description: 'Lines from the end of each log (default 120, max 2000).' },
                grep: { type: 'string', description: 'Only lines matching this regex (case-insensitive).' },
                refresh: { type: 'boolean', description: 'Re-download even if cached (useful while a job is running).' },
            },
            required: ['app', 'branch'],
        },
    },
    {
        name: 'amplify_wait_for_build',
        description: 'Wait until the latest Amplify job on a branch finishes (or until a job for a given commit finishes) and return the result. '
            + 'Watches the snapshot the VS Code extension refreshes, so it makes no AWS calls. Use after `git push` to know if the deploy succeeded.',
        inputSchema: {
            type: 'object',
            properties: {
                ...filterProps,
                commit: { type: 'string', description: 'Commit SHA (prefix ok) to wait for. Defaults to whatever job is latest.' },
                timeoutSeconds: { type: 'number', description: 'Max time to wait, default 600, max 1800.' },
            },
            required: ['app', 'branch'],
        },
    },
];

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>;

function str(args: Args, key: string): string | undefined {
    const v = args[key];
    return typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : undefined;
}

function load(dir: string): { snapshot?: FleetSnapshot; warning?: string } {
    const snapshot = readSnapshot(dir);
    if (!snapshot) {
        return {
            warning: `No fleet snapshot found in ${dir}. Open VS Code with the Amplify Monitor extension and configure accounts `
                + '(command "Amplify Monitor: Configure Fleet Accounts").',
        };
    }
    const ageMs = Date.now() - Date.parse(snapshot.generatedAt);
    const staleAfter = Math.max(snapshot.pollIntervalSeconds * 3, 300) * 1000;
    if (ageMs > staleAfter) {
        return {
            snapshot,
            warning: `⚠️ Snapshot is ${relativeTime(snapshot.generatedAt)} old (generated ${snapshot.generatedAt}). `
                + 'VS Code / Amplify Monitor may not be running, so data may be out of date.',
        };
    }
    return { snapshot };
}

interface BranchRow {
    account: string;
    profile: string;
    accountId?: string;
    appName: string;
    appId: string;
    region: string;
    branch: FleetBranch;
}

function rows(s: FleetSnapshot, args: Args): BranchRow[] {
    const account = str(args, 'account');
    const app = str(args, 'app');
    const branch = str(args, 'branch');
    const status = str(args, 'status');
    const out: BranchRow[] = [];
    for (const a of s.accounts) {
        if (account && !a.label.toLowerCase().includes(account) && !a.profile.toLowerCase().includes(account)) {
            continue;
        }
        for (const ap of a.apps) {
            if (app && !ap.name.toLowerCase().includes(app) && ap.appId.toLowerCase() !== app) {
                continue;
            }
            for (const b of ap.branches) {
                if (branch && !b.branchName.toLowerCase().includes(branch)) {
                    continue;
                }
                if (status && b.health !== status) {
                    continue;
                }
                out.push({ account: a.label, profile: a.profile, accountId: a.accountId, appName: ap.name, appId: ap.appId, region: ap.region, branch: b });
            }
        }
    }
    return out;
}

function rowsToMarkdown(list: BranchRow[]): string {
    if (list.length === 0) {
        return 'No matching branches.';
    }
    const lines = ['| Account | App | Branch | Status | Commit | Message | When | Job |', '|---|---|---|---|---|---|---|---|'];
    for (const r of list) {
        const j = r.branch.latestJob;
        lines.push(`| ${r.account} | ${r.appName} (\`${r.appId}\`, ${r.region}) | ${r.branch.branchName} | ${statusIcon(j?.status)} ${j?.status ?? 'NO JOBS'} | `
            + `${j?.commitId ? `\`${shortSha(j.commitId)}\`` : ''} | ${(j?.commitMessage ?? '').split('\n')[0].replace(/\|/g, '\\|')} | `
            + `${relativeTime(j?.endTime || j?.startTime)} | ${j ? `#${j.jobId}` : ''} |`);
    }
    return lines.join('\n');
}

function withWarning(text: string, warning?: string): string {
    return warning ? `${warning}\n\n${text}` : text;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function callTool(name: string, args: Args, dir: string = fleetDir()): Promise<string> {
    const { snapshot, warning } = load(dir);
    if (!snapshot) {
        return warning ?? 'No snapshot.';
    }

    switch (name) {
        case 'amplify_fleet_status': {
            const filtered = ['account', 'app', 'branch', 'status'].some(k => str(args, k));
            if (str(args, 'format') === 'json') {
                const payload = filtered ? { generatedAt: snapshot.generatedAt, branches: rows(snapshot, args) } : snapshot;
                return withWarning(JSON.stringify(payload, null, 2), warning);
            }
            if (!filtered) {
                return withWarning(renderMarkdown(snapshot), warning);
            }
            return withWarning(`Snapshot ${snapshot.generatedAt}\n\n${rowsToMarkdown(rows(snapshot, args))}`, warning);
        }

        case 'amplify_fleet_attention': {
            const items = snapshot.attention;
            if (items.length === 0) {
                return withWarning(`All ${snapshot.summary.branches} tracked branches across ${snapshot.summary.accounts} accounts are healthy (snapshot ${snapshot.generatedAt}).`, warning);
            }
            return withWarning(items.map(i => {
                let line = `- [${i.severity}] ${i.message}`;
                if (i.fixCommand) { line += `\n  fix: ${i.fixCommand}`; }
                if (i.appId) { line += `\n  profile=${i.profile} appId=${i.appId} region=${i.region} branch=${i.branch ?? ''} jobId=${i.jobId ?? ''}`; }
                if (i.consoleUrl) { line += `\n  console: ${i.consoleUrl}`; }
                return line;
            }).join('\n'), warning);
        }

        case 'amplify_branch_history': {
            const list = rows(snapshot, args);
            if (list.length === 0) {
                return withWarning('No matching branch. Call amplify_fleet_status to see tracked apps and branches.', warning);
            }
            return withWarning(list.slice(0, 3).map(r => {
                const header = `### ${r.account} / ${r.appName} / ${r.branch.branchName} (profile ${r.profile}, app ${r.appId}, ${r.region})`;
                const jobs = r.branch.recentJobs.map(j => `- #${j.jobId} ${statusIcon(j.status)} ${j.status} \`${shortSha(j.commitId) ?? ''}\` `
                    + `"${(j.commitMessage ?? '').split('\n')[0]}" — ${relativeTime(j.endTime || j.startTime)}`
                    + (j.durationSeconds !== undefined ? `, ${Math.round(j.durationSeconds / 60)}m${j.durationSeconds % 60}s` : ''));
                return [header, ...(jobs.length ? jobs : ['No jobs.'])].join('\n');
            }).join('\n\n'), warning);
        }

        case 'amplify_workspace_deployments': {
            if (snapshot.workspace.length === 0) {
                return withWarning('No git repository in the open VS Code workspace is linked to a monitored Amplify app.', warning);
            }
            return withWarning(JSON.stringify(snapshot.workspace, null, 2), warning);
        }

        case 'amplify_fleet_events': {
            const since = typeof args.since === 'string' ? Date.parse(args.since) : NaN;
            const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 100) : 20;
            const events = snapshot.recentEvents
                .filter(e => !Number.isFinite(since) || Date.parse(e.at) > since)
                .slice(0, limit);
            if (events.length === 0) {
                return withWarning('No events.', warning);
            }
            return withWarning(events.map(e => `- ${e.at} [${e.kind}] ${e.message}`).join('\n'), warning);
        }

        case 'amplify_get_build_logs': {
            const resolved = resolveLogTarget(snapshot, {
                account: typeof args.account === 'string' ? args.account : undefined,
                app: typeof args.app === 'string' ? args.app : undefined,
                branch: typeof args.branch === 'string' ? args.branch : undefined,
                jobId: args.jobId !== undefined ? String(args.jobId) : undefined,
            });
            if (!resolved.target) {
                return withWarning(resolved.error ?? 'Not found.', warning);
            }
            const format = {
                step: typeof args.step === 'string' ? args.step : undefined,
                tail: typeof args.tail === 'number' ? args.tail : undefined,
                grep: typeof args.grep === 'string' ? args.grep : undefined,
            };
            const cached = readJobLogs(dir, resolved.target);
            if (cached && cached.complete && args.refresh !== true) {
                return withWarning(formatJobLogs(cached, format), warning);
            }
            // Ask the VS Code extension to fetch them with the developer's AWS profile.
            const request = newLogRequest(resolved.target, args.refresh === true);
            writeLogRequest(dir, request);
            const deadline = Date.now() + 90_000;
            while (Date.now() < deadline) {
                await sleep(1000);
                const result = readLogRequestResult(dir, request.id);
                if (result) {
                    const logs = result.ok ? readJobLogs(dir, resolved.target) : undefined;
                    return logs
                        ? withWarning(formatJobLogs(logs, format), warning)
                        : `Fetching logs failed: ${result.error ?? 'unknown error'}`;
                }
            }
            return withWarning('Timed out waiting for the Amplify Monitor VS Code extension to fetch the logs. Make sure VS Code is open with the extension enabled.'
                + (cached ? `\n\nLast cached (partial) logs:\n\n${formatJobLogs(cached, format)}` : ''), warning);
        }

        case 'amplify_wait_for_build': {
            const timeout = Math.min(Math.max(Number(args.timeoutSeconds) || 600, 10), 1800) * 1000;
            const commit = str(args, 'commit');
            const started = Date.now();
            let current: FleetSnapshot | undefined = snapshot;
            for (;;) {
                const list = current ? rows(current, args) : [];
                if (list.length === 0) {
                    return 'No matching branch. Call amplify_fleet_status to see tracked apps and branches.';
                }
                const row = list[0];
                const job = commit
                    ? row.branch.recentJobs.find(j => j.commitId?.toLowerCase().startsWith(commit))
                    : row.branch.latestJob;
                if (job && TERMINAL_JOB_STATUSES.has(job.status)) {
                    return `${row.account} / ${row.appName} / ${row.branch.branchName}: job #${job.jobId} ${statusIcon(job.status)} ${job.status}`
                        + ` (commit ${shortSha(job.commitId) ?? '?'} "${(job.commitMessage ?? '').split('\n')[0]}")\nconsole: ${job.consoleUrl}`
                        + (job.status === 'FAILED' ? `\nNext: call amplify_get_build_logs with app="${row.appId}" branch="${row.branch.branchName}" jobId="${job.jobId}" to read the build output.` : '');
                }
                if (Date.now() - started > timeout) {
                    return `Timed out after ${Math.round(timeout / 1000)}s. Current: ${job ? `job #${job.jobId} ${job.status}` : commit ? `no job for commit ${commit} yet` : 'no jobs'}.`;
                }
                await sleep(5000);
                current = readSnapshot(dir) ?? current;
            }
        }

        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}

// ---------------------------------------------------------------------------
// Minimal MCP stdio transport (newline-delimited JSON-RPC 2.0)
// ---------------------------------------------------------------------------

interface RpcMessage {
    jsonrpc: '2.0';
    id?: number | string | null;
    method?: string;
    params?: Record<string, unknown>;
}

function send(message: unknown): void {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(msg: RpcMessage): Promise<void> {
    const isRequest = msg.id !== undefined && msg.id !== null;
    try {
        let result: unknown;
        switch (msg.method) {
            case 'initialize': {
                const requested = typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : DEFAULT_PROTOCOL;
                result = {
                    protocolVersion: requested,
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
                    instructions: 'Cached, read-only Amplify build status across all AWS accounts monitored by the Amplify Monitor VS Code extension. '
                        + 'Prefer these tools over running the AWS CLI for status questions.',
                };
                break;
            }
            case 'ping':
                result = {};
                break;
            case 'tools/list':
                result = { tools };
                break;
            case 'tools/call': {
                const name = String(msg.params?.name ?? '');
                const args = (msg.params?.arguments ?? {}) as Args;
                try {
                    const text = await callTool(name, args);
                    result = { content: [{ type: 'text', text }] };
                } catch (error) {
                    result = { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
                }
                break;
            }
            case 'resources/list':
                result = { resources: [] };
                break;
            case 'prompts/list':
                result = { prompts: [] };
                break;
            default:
                if (isRequest) {
                    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
                }
                return; // notifications (e.g. notifications/initialized) need no reply
        }
        if (isRequest) {
            send({ jsonrpc: '2.0', id: msg.id, result });
        }
    } catch (error) {
        if (isRequest) {
            send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
        }
    }
}

function main(): void {
    let buffer = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => {
        buffer += chunk;
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (!line) {
                continue;
            }
            let msg: RpcMessage;
            try {
                msg = JSON.parse(line);
            } catch {
                send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
                continue;
            }
            void handle(msg);
        }
    });
    process.stdin.on('end', () => process.exit(0));
}

if (require.main === module) {
    main();
}

export { callTool, tools };
