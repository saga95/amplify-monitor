import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FleetJob, FleetSnapshot, shortSha } from './types';

export const SNAPSHOT_JSON = 'status.json';
export const SNAPSHOT_MD = 'status.md';
export const MCP_SERVER_FILE = 'mcp-server.js';

/** Default location shared by the extension, the bundled MCP server and AI agents. */
export function defaultFleetDir(): string {
    return process.env.AMPLIFY_MONITOR_FLEET_DIR || path.join(os.homedir(), '.amplify-monitor', 'fleet');
}

export function resolveFleetDir(configured: string | undefined): string {
    const value = configured?.trim();
    if (!value) {
        return defaultFleetDir();
    }
    return value.startsWith('~') ? path.join(os.homedir(), value.slice(1)) : value;
}

function writeAtomic(file: string, content: string): void {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, file);
}

export function writeSnapshot(dir: string, snapshot: FleetSnapshot): { jsonPath: string; mdPath: string } {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const jsonPath = path.join(dir, SNAPSHOT_JSON);
    const mdPath = path.join(dir, SNAPSHOT_MD);
    writeAtomic(jsonPath, JSON.stringify(snapshot, null, 2));
    writeAtomic(mdPath, renderMarkdown(snapshot));
    return { jsonPath, mdPath };
}

export function readSnapshot(dir: string): FleetSnapshot | undefined {
    try {
        return JSON.parse(fs.readFileSync(path.join(dir, SNAPSHOT_JSON), 'utf-8')) as FleetSnapshot;
    } catch {
        return undefined;
    }
}

const STATUS_ICON: Record<string, string> = {
    SUCCEED: '✅', FAILED: '❌', RUNNING: '🔄', PENDING: '⏳', PROVISIONING: '⏳', CANCELLING: '⏹️', CANCELLED: '⏹️',
};

export function statusIcon(status: string | undefined): string {
    return (status && STATUS_ICON[status]) || '❔';
}

export function relativeTime(iso: string | undefined, now = Date.now()): string {
    if (!iso) {
        return '';
    }
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) {
        return '';
    }
    const s = Math.round((now - t) / 1000);
    if (s < 60) { return 'just now'; }
    if (s < 3600) { return `${Math.floor(s / 60)}m ago`; }
    if (s < 86400) { return `${Math.floor(s / 3600)}h ago`; }
    return `${Math.floor(s / 86400)}d ago`;
}

function cell(text: string | undefined): string {
    return (text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function jobWhen(job: FleetJob | undefined): string {
    if (!job) {
        return '';
    }
    return relativeTime(job.endTime || job.startTime);
}

/**
 * Markdown view of the snapshot, written for AI coding agents (Claude Code,
 * Codex, Copilot, Antigravity) and humans alike.
 */
export function renderMarkdown(s: FleetSnapshot): string {
    const lines: string[] = [];
    const sum = s.summary;
    lines.push('# Amplify fleet status');
    lines.push('');
    lines.push(`Generated ${s.generatedAt} by the Amplify Monitor VS Code extension. It refreshes every ${s.pollIntervalSeconds}s while VS Code is open`
        + (s.nextPollAt ? `; next refresh around ${s.nextPollAt}.` : '.'));
    lines.push('Agents: read this file (or the `amplify_fleet_status` MCP tool) instead of calling the AWS CLI for build status. '
        + 'For build output use the `amplify_get_build_logs` MCP tool, or read the `logs:` folders listed below.');
    lines.push('');
    lines.push(`**${sum.accounts} accounts · ${sum.apps} apps · ${sum.branches} branches** — `
        + `✅ ${sum.ok} ok · ❌ ${sum.failing} failing · 🔄 ${sum.building} building`
        + (sum.warning ? ` · ⏹️ ${sum.warning} cancelled` : '')
        + (sum.accountErrors ? ` · ⚠️ ${sum.accountErrors} account errors` : ''));
    lines.push('');

    lines.push('## Needs attention');
    lines.push('');
    if (s.attention.length === 0) {
        lines.push('Nothing. All tracked branches are healthy.');
    } else {
        for (const item of s.attention) {
            const icon = item.severity === 'error' ? '❌' : item.severity === 'warning' ? '⚠️' : '🔄';
            let line = `- ${icon} ${item.message}`;
            if (item.fixCommand) { line += ` — fix: \`${item.fixCommand}\``; }
            if (item.appId) { line += ` (profile \`${item.profile}\`, app \`${item.appId}\`, region \`${item.region}\`)`; }
            if (item.logsDir) { line += ` — logs: \`${item.logsDir}\``; }
            lines.push(line);
        }
    }
    lines.push('');

    if (s.workspace.length > 0) {
        lines.push('## This workspace');
        lines.push('');
        for (const repo of s.workspace) {
            lines.push(`- Repo \`${repo.repoKey}\`, local branch \`${repo.localBranch ?? '?'}\`, HEAD \`${shortSha(repo.headCommit) ?? '?'}\``
                + (repo.headSubject ? ` "${cell(repo.headSubject)}"` : ''));
            if (repo.deployments.length === 0) {
                lines.push('  - No Amplify app in the configured accounts is connected to this repository.');
            }
            for (const d of repo.deployments) {
                const latest = d.latestJob ? `latest job #${d.latestJob.jobId} ${statusIcon(d.latestJob.status)} ${d.latestJob.status} at \`${shortSha(d.latestJob.commitId)}\`` : 'no jobs yet';
                lines.push(`  - ${d.accountLabel} / ${d.appName} / \`${d.branch}\`: HEAD is **${d.headState}**; ${latest}`);
            }
        }
        lines.push('');
    }

    for (const account of s.accounts) {
        const id = account.accountId ? ` · ${account.accountId}` : '';
        const regions = account.regions.length ? ` · ${account.regions.join(', ')}` : '';
        lines.push(`## ${account.label} (profile \`${account.profile}\`${id}${regions})`);
        lines.push('');
        if (account.status !== 'ok' && account.status !== 'pending') {
            lines.push(`⚠️ ${account.error}` + (account.fixCommand ? ` Fix: \`${account.fixCommand}\`` : '') + (account.apps.length ? ' Showing last known data.' : ''));
            lines.push('');
        }
        if (account.apps.length === 0) {
            lines.push(account.status === 'pending' ? 'Loading…' : 'No Amplify apps found.');
            lines.push('');
            continue;
        }
        lines.push('| App | Branch | Status | Commit | Message | When | Job | App ID / region |');
        lines.push('|---|---|---|---|---|---|---|---|');
        for (const app of account.apps) {
            if (app.error) {
                lines.push(`| ${cell(app.name)} | | ⚠️ ${cell(app.error)} | | | | | \`${app.appId}\` ${app.region} |`);
            }
            for (const branch of app.branches) {
                const job = branch.latestJob;
                const name = branch.isProduction ? `${branch.branchName} (prod)` : branch.branchName;
                lines.push(`| ${cell(app.name)} | ${cell(name)} | ${statusIcon(job?.status)} ${job?.status ?? 'NO JOBS'} | `
                    + `${job?.commitId ? `\`${shortSha(job.commitId)}\`` : ''} | ${cell(job?.commitMessage?.split('\n')[0])} | ${jobWhen(job)} | `
                    + `${job ? `[#${job.jobId}](${job.consoleUrl})` : ''} | \`${app.appId}\` ${app.region} |`);
            }
            if (app.hiddenBranches > 0) {
                lines.push(`| ${cell(app.name)} | +${app.hiddenBranches} more branches not tracked | | | | | | |`);
            }
        }
        lines.push('');
    }

    if (s.recentEvents.length > 0) {
        lines.push('## Recent events (newest first)');
        lines.push('');
        for (const e of s.recentEvents.slice(0, 20)) {
            lines.push(`- ${e.at} — ${e.message}`);
        }
        lines.push('');
    }
    return lines.join('\n');
}
