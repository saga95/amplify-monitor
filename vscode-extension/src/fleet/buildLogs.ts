/**
 * Build log cache shared by the extension and the bundled MCP server.
 *
 * Layout: <fleetDir>/logs/<profile>/<appId>/<branch>/<jobId>/{job.json, BUILD.txt, DEPLOY.txt, ...}
 * Agents never fetch logs from AWS. They read this cache, or drop a request file in
 * <fleetDir>/log-requests/ that the VS Code extension fulfils with the AWS CLI.
 *
 * Must not import `vscode` or the AWS CLI client (it ships inside the MCP server).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { FleetSnapshot } from './types';

export const LOGS_DIR = 'logs';
export const LOG_REQUESTS_DIR = 'log-requests';
export const JOB_META = 'job.json';

export interface JobLogTarget {
    profile: string;
    region: string;
    appId: string;
    appName?: string;
    branch: string;
    jobId: string;
}

export interface JobLogStep {
    stepName: string;
    status: string;
    startTime?: string;
    endTime?: string;
    /** Absolute path of the downloaded log, when the step produced one. */
    file?: string;
    bytes: number;
    lines: number;
    truncated?: boolean;
}

export interface JobLogs extends JobLogTarget {
    status: string;
    commitId?: string;
    commitMessage?: string;
    fetchedAt: string;
    /** False while the job is still running: logs are partial and will be re-fetched. */
    complete: boolean;
    dir: string;
    consoleUrl: string;
    steps: JobLogStep[];
    /** Lines that look like errors, across all steps, in order. */
    errorLines: string[];
}

export interface LogRequest extends JobLogTarget {
    id: string;
    requestedAt: string;
    force?: boolean;
}

export interface LogRequestResult {
    id: string;
    ok: boolean;
    error?: string;
    dir?: string;
    finishedAt: string;
}

const SAFE = /[^A-Za-z0-9._-]/g;

function safeSegment(value: string): string {
    const cleaned = value.replace(SAFE, '_').replace(/^\.+/, '_');
    return cleaned || '_';
}

export function jobLogDir(fleetDir: string, t: Pick<JobLogTarget, 'profile' | 'appId' | 'branch' | 'jobId'>): string {
    return path.join(fleetDir, LOGS_DIR, safeSegment(t.profile), safeSegment(t.appId), safeSegment(t.branch), safeSegment(t.jobId));
}

export function readJobLogs(fleetDir: string, t: Pick<JobLogTarget, 'profile' | 'appId' | 'branch' | 'jobId'>): JobLogs | undefined {
    try {
        return JSON.parse(fs.readFileSync(path.join(jobLogDir(fleetDir, t), JOB_META), 'utf-8')) as JobLogs;
    } catch {
        return undefined;
    }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
    return text.replace(ANSI, '');
}

const ERROR_PATTERN = /\[ERROR\]|\bnpm ERR!|\berror TS\d+|\bERR_[A-Z_]+|\b(Error|TypeError|SyntaxError|ReferenceError):|\bfailed to compile\b|\bbuild failed\b|Command failed|exit(ed)? (with )?(code|status) [1-9]|_FAILED\b|\bfatal:|Cannot find module|Module not found|ELIFECYCLE|exceeded|out of memory|heap limit/i;
const NOT_ERROR = /\b0 errors?\b|no errors|errors?: 0\b/i;

/** Pull out lines that look like errors (deduplicated, capped). */
export function extractErrorLines(text: string, max = 80): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of text.split('\n')) {
        const line = raw.trimEnd();
        if (!ERROR_PATTERN.test(line) || NOT_ERROR.test(line)) {
            continue;
        }
        // Dedupe ignoring the leading timestamp Amplify adds to every line.
        const key = line.replace(/^\S+Z\s+/, '');
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        out.push(line.length > 400 ? `${line.slice(0, 397)}...` : line);
        if (out.length >= max) {
            break;
        }
    }
    return out;
}

/** Find the snapshot branch/job an agent means, from loose filters. */
export function resolveLogTarget(
    snapshot: FleetSnapshot,
    args: { account?: string; app?: string; branch?: string; jobId?: string }
): { target?: JobLogTarget; status?: string; error?: string } {
    const account = args.account?.trim().toLowerCase();
    const app = args.app?.trim().toLowerCase();
    const branch = args.branch?.trim().toLowerCase();
    if (!app || !branch) {
        return { error: 'Both app and branch are required.' };
    }
    const matches: Array<{ target: JobLogTarget; status?: string; exact: boolean }> = [];
    for (const a of snapshot.accounts) {
        if (account && !a.label.toLowerCase().includes(account) && !a.profile.toLowerCase().includes(account)) {
            continue;
        }
        for (const ap of a.apps) {
            if (!ap.name.toLowerCase().includes(app) && ap.appId.toLowerCase() !== app) {
                continue;
            }
            for (const b of ap.branches) {
                if (!b.branchName.toLowerCase().includes(branch)) {
                    continue;
                }
                const job = args.jobId ? b.recentJobs.find(j => Number(j.jobId) === Number(args.jobId) || j.jobId === args.jobId) : b.latestJob;
                const jobId = job?.jobId ?? args.jobId;
                if (!jobId) {
                    continue;
                }
                matches.push({
                    target: { profile: a.profile, region: ap.region, appId: ap.appId, appName: ap.name, branch: b.branchName, jobId },
                    status: job?.status,
                    exact: b.branchName.toLowerCase() === branch && (ap.name.toLowerCase() === app || ap.appId.toLowerCase() === app),
                });
            }
        }
    }
    if (matches.length === 0) {
        return { error: 'No matching app/branch with jobs. Call amplify_fleet_status to see tracked apps and branches.' };
    }
    const exact = matches.filter(m => m.exact);
    const pool = exact.length ? exact : matches;
    if (pool.length > 1) {
        return {
            error: `Ambiguous: ${pool.slice(0, 6).map(m => `${m.target.appName}/${m.target.branch} (profile ${m.target.profile})`).join(', ')}. `
                + 'Pass a more specific app, branch or account.',
        };
    }
    return { target: pool[0].target, status: pool[0].status };
}

export interface FormatOptions {
    /** Step to show (BUILD, DEPLOY, VERIFY, ...). Default: every step that has a log. */
    step?: string;
    /** Lines from the end of each step's log. Default 120. */
    tail?: number;
    /** Only lines matching this case-insensitive regex (or plain text). */
    grep?: string;
}

/** Agent-friendly text: error lines first, then the end of each log, plus file paths for full reads. */
export function formatJobLogs(logs: JobLogs, options: FormatOptions = {}): string {
    const tail = Math.min(Math.max(options.tail ?? 120, 10), 2000);
    const lines: string[] = [];
    lines.push(`# Amplify job #${logs.jobId} ${logs.status} — ${logs.appName ?? logs.appId} / ${logs.branch} (profile ${logs.profile}, ${logs.region})`);
    if (logs.commitId) {
        lines.push(`Commit ${logs.commitId.slice(0, 7)}: ${(logs.commitMessage ?? '').split('\n')[0]}`);
    }
    lines.push(`Steps: ${logs.steps.map(s => `${s.stepName}=${s.status}`).join(', ')}`);
    if (!logs.complete) {
        lines.push('⚠️ Job still running; logs are partial.');
    }
    lines.push(`Full logs: ${logs.steps.filter(s => s.file).map(s => s.file).join(' , ') || 'none'}`);
    lines.push(`Console: ${logs.consoleUrl}`);
    lines.push('');

    let grep: RegExp | undefined;
    if (options.grep) {
        try {
            grep = new RegExp(options.grep, 'i');
        } catch {
            grep = new RegExp(options.grep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        }
    }

    if (!grep && logs.errorLines.length > 0) {
        lines.push('## Error lines');
        lines.push('```');
        lines.push(...logs.errorLines);
        lines.push('```');
        lines.push('');
    }

    const wanted = options.step?.trim().toUpperCase();
    const steps = logs.steps.filter(s => s.file && (!wanted || wanted === 'ALL' || s.stepName.toUpperCase() === wanted));
    if (steps.length === 0) {
        lines.push(wanted ? `No log for step ${wanted}.` : 'No step logs were produced.');
    }
    for (const step of steps) {
        let text = '';
        try {
            text = fs.readFileSync(step.file!, 'utf-8');
        } catch {
            lines.push(`## ${step.stepName}: log file missing`);
            continue;
        }
        let selected = text.split('\n');
        let label: string;
        if (grep) {
            selected = selected.filter(l => grep!.test(l)).slice(-tail);
            label = `lines matching /${options.grep}/ (${selected.length})`;
        } else {
            selected = selected.slice(-tail);
            label = `last ${selected.length} of ${step.lines} lines`;
        }
        lines.push(`## ${step.stepName} (${step.status}) — ${label}`);
        lines.push('```');
        lines.push(...selected);
        lines.push('```');
        lines.push('');
    }
    return lines.join('\n');
}

export function newLogRequest(target: JobLogTarget, force = false): LogRequest {
    return { ...target, id: crypto.randomBytes(8).toString('hex'), requestedAt: new Date().toISOString(), force };
}

export function writeLogRequest(fleetDir: string, request: LogRequest): void {
    const dir = path.join(fleetDir, LOG_REQUESTS_DIR);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${request.id}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(request), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
}

export function readLogRequestResult(fleetDir: string, id: string): LogRequestResult | undefined {
    const file = path.join(fleetDir, LOG_REQUESTS_DIR, `${id}.done.json`);
    try {
        const result = JSON.parse(fs.readFileSync(file, 'utf-8')) as LogRequestResult;
        fs.unlinkSync(file);
        return result;
    } catch {
        return undefined;
    }
}

/** Remove cached logs older than maxAgeDays. */
export function pruneLogs(fleetDir: string, maxAgeDays: number): number {
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    let removed = 0;
    const walk = (dir: string, depth: number): void => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            const full = path.join(dir, entry.name);
            if (depth === 3) { // <profile>/<app>/<branch>/<job>
                try {
                    if (fs.statSync(path.join(full, JOB_META)).mtimeMs < cutoff) {
                        fs.rmSync(full, { recursive: true, force: true });
                        removed++;
                    }
                } catch {
                    // No job.json: a download may be in progress, so only remove old leftovers.
                    try {
                        if (fs.statSync(full).mtimeMs < cutoff) {
                            fs.rmSync(full, { recursive: true, force: true });
                            removed++;
                        }
                    } catch { /* ignore */ }
                }
            } else {
                walk(full, depth + 1);
            }
        }
    };
    walk(path.join(fleetDir, LOGS_DIR), 0);
    return removed;
}
