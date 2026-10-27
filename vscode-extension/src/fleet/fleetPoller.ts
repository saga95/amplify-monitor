import { AMPLIFY_REGIONS, AwsCliClient, AwsCliError, RawAmplifyBranch, RawJobSummary, createLimiter } from './awsCli';
import {
    AccountStatus,
    AttentionItem,
    FleetAccount,
    FleetAccountConfig,
    FleetApp,
    FleetBranch,
    FleetEvent,
    FleetJob,
    FleetSummary,
    TERMINAL_JOB_STATUSES,
    amplifyConsoleUrl,
    healthFromJobStatus,
    normalizeRepoUrl,
    shortSha,
    worstHealth,
} from './types';

export interface PollOptions {
    maxBranchesPerApp: number;
    jobsPerBranch: number;
    concurrency: number;
    /** Re-list jobs for every branch, ignoring the "branch unchanged" shortcut. */
    force: boolean;
    /** Re-scan all regions for profiles without explicit regions. */
    rediscoverRegions: boolean;
}

const REGION_DISCOVERY_TTL_MS = 60 * 60 * 1000;

/**
 * Polls Amplify state for a set of AWS profiles using the AWS CLI.
 *
 * To keep the number of CLI calls low on every tick, list-jobs is skipped for a
 * branch whose activeJobId and updateTime are unchanged and whose last known job
 * already finished. Callers should pass `force: true` periodically as a safety net.
 */
export class FleetPoller {
    private readonly accountIds = new Map<string, string>();
    private readonly discoveredRegions = new Map<string, { regions: string[]; at: number }>();

    constructor(private readonly client: AwsCliClient) {}

    resetCaches(): void {
        this.accountIds.clear();
        this.discoveredRegions.clear();
    }

    async pollAll(configs: FleetAccountConfig[], previous: FleetAccount[], options: PollOptions): Promise<FleetAccount[]> {
        const limit = createLimiter(options.concurrency);
        const prevByProfile = new Map(previous.map(a => [a.profile, a]));
        return Promise.all(configs.map(cfg => this.pollAccount(cfg, prevByProfile.get(cfg.profile), options, limit)));
    }

    private async pollAccount(
        cfg: FleetAccountConfig,
        previous: FleetAccount | undefined,
        options: PollOptions,
        limit: <T>(task: () => Promise<T>) => Promise<T>
    ): Promise<FleetAccount> {
        const label = cfg.label?.trim() || cfg.profile;
        const base: FleetAccount = {
            profile: cfg.profile,
            label,
            accountId: this.accountIds.get(cfg.profile) ?? previous?.accountId,
            regions: [],
            status: 'ok',
            health: 'unknown',
            lastPolledAt: new Date().toISOString(),
            apps: [],
        };

        try {
            if (!base.accountId) {
                base.accountId = await limit(() => this.client.getAccountId(cfg.profile));
                this.accountIds.set(cfg.profile, base.accountId);
            }

            base.regions = await this.resolveRegions(cfg, options, limit);

            const prevApps = new Map((previous?.apps ?? []).map(a => [`${a.region}/${a.appId}`, a]));
            const regionResults = await Promise.all(base.regions.map(async region => {
                const apps = await limit(() => this.client.listApps(cfg.profile, region));
                return apps.filter(app => matchesAppFilter(cfg.apps, app.appId, app.name)).map(app => ({ region, app }));
            }));

            const flat = regionResults.flat();
            base.apps = await Promise.all(flat.map(({ region, app }) => this.pollApp(
                cfg, region, app, prevApps.get(`${region}/${app.appId}`), options, limit)));
            base.apps.sort((a, b) => a.name.localeCompare(b.name));
            base.health = base.apps.length ? worstHealth(base.apps.map(a => a.health)) : 'ok';
        } catch (error) {
            const status = accountStatusFromError(error);
            base.status = status;
            base.health = 'error';
            base.error = error instanceof Error ? error.message : String(error);
            if (status === 'auth-expired' && /sso/i.test(base.error)) {
                base.fixCommand = `aws sso login --profile ${cfg.profile}`;
            } else if (status === 'no-credentials') {
                base.fixCommand = `aws configure --profile ${cfg.profile}`;
            }
            // Keep the last known apps so the developer still sees something useful.
            base.apps = previous?.apps ?? [];
            base.regions = previous?.regions ?? [];
            if (status === 'auth-expired' || status === 'no-credentials') {
                this.accountIds.delete(cfg.profile);
            }
        }
        return base;
    }

    private async resolveRegions(
        cfg: FleetAccountConfig,
        options: PollOptions,
        limit: <T>(task: () => Promise<T>) => Promise<T>
    ): Promise<string[]> {
        const explicit = (cfg.regions ?? []).map(r => r.trim()).filter(r => r && r !== '*');
        if (explicit.length > 0) {
            return explicit;
        }

        const cached = this.discoveredRegions.get(cfg.profile);
        if (cached && !options.rediscoverRegions && Date.now() - cached.at < REGION_DISCOVERY_TTL_MS) {
            return cached.regions;
        }

        // Scan every Amplify region once, then only poll the regions that have apps.
        const found: string[] = [];
        let lastAuthError: unknown;
        await Promise.all(AMPLIFY_REGIONS.map(region => limit(async () => {
            try {
                const apps = await this.client.listApps(cfg.profile, region);
                if (apps.some(app => matchesAppFilter(cfg.apps, app.appId, app.name))) {
                    found.push(region);
                }
            } catch (error) {
                // Opt-in regions that are disabled for the account fail; ignore them,
                // but surface credential problems.
                if (error instanceof AwsCliError && ['auth-expired', 'no-credentials', 'not-installed'].includes(error.kind)) {
                    lastAuthError = error;
                }
            }
        })));
        if (lastAuthError && found.length === 0) {
            throw lastAuthError;
        }

        let regions = found.sort();
        if (regions.length === 0) {
            const fallback = await this.client.getProfileRegion(cfg.profile);
            regions = fallback ? [fallback] : [];
        }
        this.discoveredRegions.set(cfg.profile, { regions, at: Date.now() });
        return regions;
    }

    private async pollApp(
        cfg: FleetAccountConfig,
        region: string,
        raw: { appId: string; name: string; repository?: string; defaultDomain?: string; productionBranch?: { branchName?: string } },
        previous: FleetApp | undefined,
        options: PollOptions,
        limit: <T>(task: () => Promise<T>) => Promise<T>
    ): Promise<FleetApp> {
        const app: FleetApp = {
            appId: raw.appId,
            name: raw.name,
            region,
            repository: raw.repository || undefined,
            repoKey: normalizeRepoUrl(raw.repository),
            defaultDomain: raw.defaultDomain,
            productionBranch: raw.productionBranch?.branchName,
            health: 'unknown',
            consoleUrl: amplifyConsoleUrl(region, raw.appId),
            branches: [],
            hiddenBranches: 0,
        };

        try {
            const allBranches = await limit(() => this.client.listBranches(cfg.profile, region, raw.appId));
            const selected = selectBranches(allBranches, cfg.branches, app.productionBranch, options.maxBranchesPerApp);
            app.hiddenBranches = allBranches.length - selected.length;

            const prevBranches = new Map((previous?.branches ?? []).map(b => [b.branchName, b]));
            app.branches = await Promise.all(selected.map(branch =>
                this.pollBranch(cfg, region, app, branch, prevBranches.get(branch.branchName), options, limit)));
            app.health = app.branches.length ? worstHealth(app.branches.map(b => b.health)) : 'unknown';
        } catch (error) {
            if (error instanceof AwsCliError && (error.kind === 'auth-expired' || error.kind === 'no-credentials')) {
                throw error;
            }
            app.error = error instanceof Error ? error.message : String(error);
            app.health = 'error';
            app.branches = previous?.branches ?? [];
        }
        return app;
    }

    private async pollBranch(
        cfg: FleetAccountConfig,
        region: string,
        app: FleetApp,
        raw: RawAmplifyBranch,
        previous: FleetBranch | undefined,
        options: PollOptions,
        limit: <T>(task: () => Promise<T>) => Promise<T>
    ): Promise<FleetBranch> {
        const branch: FleetBranch = {
            branchName: raw.branchName,
            displayName: raw.displayName,
            stage: raw.stage,
            isProduction: raw.branchName === app.productionBranch,
            health: 'unknown',
            activeJobId: raw.activeJobId,
            updateTime: raw.updateTime,
            url: app.defaultDomain ? `https://${(raw.displayName || raw.branchName)}.${app.defaultDomain}` : undefined,
            consoleUrl: amplifyConsoleUrl(region, app.appId, raw.branchName),
            recentJobs: [],
        };

        const unchanged = !options.force
            && previous?.latestJob
            && TERMINAL_JOB_STATUSES.has(previous.latestJob.status)
            && sameJobId(previous.activeJobId, raw.activeJobId)
            && previous.updateTime === raw.updateTime;

        if (unchanged && previous) {
            branch.recentJobs = previous.recentJobs;
        } else {
            try {
                const jobs = await limit(() => this.client.listJobs(cfg.profile, region, app.appId, raw.branchName, options.jobsPerBranch));
                branch.recentJobs = jobs.map(job => toFleetJob(job, region, app.appId, raw.branchName));
            } catch (error) {
                if (error instanceof AwsCliError && (error.kind === 'auth-expired' || error.kind === 'no-credentials')) {
                    throw error;
                }
                branch.error = error instanceof Error ? error.message : String(error);
                branch.recentJobs = previous?.recentJobs ?? [];
            }
        }

        branch.latestJob = branch.recentJobs[0];
        branch.health = branch.error ? 'error' : healthFromJobStatus(branch.latestJob?.status);
        return branch;
    }
}

export function toFleetJob(job: RawJobSummary, region: string, appId: string, branch: string): FleetJob {
    let durationSeconds: number | undefined;
    if (job.startTime && job.endTime) {
        const ms = Date.parse(job.endTime) - Date.parse(job.startTime);
        durationSeconds = Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 1000) : undefined;
    }
    return {
        jobId: job.jobId,
        status: job.status,
        jobType: job.jobType,
        commitId: job.commitId,
        commitMessage: job.commitMessage?.trim(),
        commitTime: job.commitTime,
        startTime: job.startTime,
        endTime: job.endTime,
        durationSeconds,
        consoleUrl: amplifyConsoleUrl(region, appId, branch, job.jobId),
    };
}

function sameJobId(a: string | undefined, b: string | undefined): boolean {
    if (!a || !b) {
        return a === b;
    }
    const na = Number(a);
    const nb = Number(b);
    return Number.isFinite(na) && Number.isFinite(nb) ? na === nb : a === b;
}

function matchesAppFilter(filter: string[] | undefined, appId: string, name: string): boolean {
    if (!filter || filter.length === 0) {
        return true;
    }
    const id = appId.toLowerCase();
    const n = name.toLowerCase();
    return filter.some(f => {
        const v = f.trim().toLowerCase();
        return v === id || v === n || globMatch(v, n);
    });
}

function globMatch(pattern: string, value: string): boolean {
    if (!pattern.includes('*')) {
        return pattern === value;
    }
    const escaped = pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${escaped}$`, 'i').test(value);
}

export function selectBranches(
    branches: RawAmplifyBranch[],
    filter: string[] | undefined,
    productionBranch: string | undefined,
    maxBranches: number
): RawAmplifyBranch[] {
    const filtered = branches.filter(b =>
        b.branchName === productionBranch
        || !filter || filter.length === 0
        || filter.some(f => globMatch(f.trim(), b.branchName)));

    const sorted = [...filtered].sort((a, b) => {
        if (a.branchName === productionBranch) { return -1; }
        if (b.branchName === productionBranch) { return 1; }
        return (Date.parse(b.updateTime || '') || 0) - (Date.parse(a.updateTime || '') || 0);
    });
    return sorted.slice(0, Math.max(1, maxBranches));
}

function accountStatusFromError(error: unknown): AccountStatus {
    if (error instanceof AwsCliError) {
        switch (error.kind) {
            case 'auth-expired': return 'auth-expired';
            case 'no-credentials': return 'no-credentials';
            case 'access-denied': return 'access-denied';
            default: return 'error';
        }
    }
    return 'error';
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

export function summarize(accounts: FleetAccount[]): FleetSummary {
    const summary: FleetSummary = { accounts: accounts.length, accountErrors: 0, apps: 0, branches: 0, ok: 0, failing: 0, building: 0, warning: 0 };
    for (const account of accounts) {
        if (account.status !== 'ok' && account.status !== 'pending') {
            summary.accountErrors++;
        }
        summary.apps += account.apps.length;
        for (const app of account.apps) {
            for (const branch of app.branches) {
                summary.branches++;
                if (branch.health === 'ok') { summary.ok++; }
                else if (branch.health === 'failing') { summary.failing++; }
                else if (branch.health === 'building') { summary.building++; }
                else if (branch.health === 'warning') { summary.warning++; }
            }
        }
    }
    return summary;
}

export function collectAttention(accounts: FleetAccount[]): AttentionItem[] {
    const items: AttentionItem[] = [];
    for (const account of accounts) {
        if (account.status !== 'ok' && account.status !== 'pending') {
            items.push({
                severity: 'error',
                message: `${account.label}: ${account.error ?? account.status}`,
                profile: account.profile,
                accountLabel: account.label,
                fixCommand: account.fixCommand,
            });
        }
        for (const app of account.apps) {
            if (app.error) {
                items.push({
                    severity: 'warning', message: `${account.label} / ${app.name}: ${app.error}`,
                    profile: account.profile, accountLabel: account.label, appId: app.appId, appName: app.name, region: app.region,
                });
            }
            for (const branch of app.branches) {
                const job = branch.latestJob;
                if (branch.health === 'failing' && job) {
                    items.push({
                        severity: 'error',
                        message: `${account.label} / ${app.name} / ${branch.branchName}: job #${job.jobId} FAILED`
                            + (job.commitId ? ` at ${shortSha(job.commitId)}` : '')
                            + (job.commitMessage ? ` "${firstLine(job.commitMessage)}"` : '')
                            + ageSuffix(job.endTime || job.startTime),
                        profile: account.profile, accountLabel: account.label, appId: app.appId, appName: app.name,
                        region: app.region, branch: branch.branchName, jobId: job.jobId, consoleUrl: job.consoleUrl,
                        logsDir: job.logsDir,
                    });
                } else if (branch.health === 'building' && job) {
                    items.push({
                        severity: 'info',
                        message: `${account.label} / ${app.name} / ${branch.branchName}: job #${job.jobId} ${job.status}`
                            + (job.commitId ? ` (${shortSha(job.commitId)})` : ''),
                        profile: account.profile, accountLabel: account.label, appId: app.appId, appName: app.name,
                        region: app.region, branch: branch.branchName, jobId: job.jobId, consoleUrl: job.consoleUrl,
                    });
                }
            }
        }
    }
    const order = { error: 0, warning: 1, info: 2 };
    const jobTime = (item: AttentionItem): number => {
        const account = accounts.find(a => a.profile === item.profile);
        const job = account?.apps.find(a => a.appId === item.appId)?.branches.find(b => b.branchName === item.branch)?.latestJob;
        return Date.parse(job?.endTime || job?.startTime || '') || 0;
    };
    // Most severe first; within a severity, account problems first, then the most recent builds.
    return items.sort((a, b) => order[a.severity] - order[b.severity]
        || Number(!!a.appId) - Number(!!b.appId)
        || jobTime(b) - jobTime(a));
}

function ageSuffix(iso: string | undefined): string {
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) {
        return '';
    }
    const minutes = Math.round((Date.now() - t) / 60000);
    if (minutes < 60) { return ` (${minutes}m ago)`; }
    if (minutes < 1440) { return ` (${Math.round(minutes / 60)}h ago)`; }
    return ` (${Math.round(minutes / 1440)}d ago)`;
}

/** Compare two polls and produce build/account transition events. */
export function diffAccounts(previous: FleetAccount[], next: FleetAccount[], at = new Date().toISOString()): FleetEvent[] {
    const events: FleetEvent[] = [];
    const prevByProfile = new Map(previous.map(a => [a.profile, a]));

    for (const account of next) {
        const prev = prevByProfile.get(account.profile);
        if (!prev) {
            continue; // first poll for this account is the baseline
        }
        const wasError = prev.status !== 'ok' && prev.status !== 'pending';
        const isError = account.status !== 'ok' && account.status !== 'pending';
        if (!wasError && isError) {
            events.push({ at, kind: 'account-error', profile: account.profile, accountLabel: account.label, message: `${account.label}: ${account.error}` });
        } else if (wasError && !isError) {
            events.push({ at, kind: 'account-recovered', profile: account.profile, accountLabel: account.label, message: `${account.label}: credentials OK again` });
        }
        if (isError) {
            continue;
        }

        const prevBranches = new Map<string, FleetBranch>();
        for (const app of prev.apps) {
            for (const branch of app.branches) {
                prevBranches.set(`${app.region}/${app.appId}/${branch.branchName}`, branch);
            }
        }
        const prevAppKeys = new Set(prev.apps.map(a => `${a.region}/${a.appId}`));

        for (const app of account.apps) {
            const appIsNew = !prevAppKeys.has(`${app.region}/${app.appId}`);
            for (const branch of app.branches) {
                const job = branch.latestJob;
                if (!job || appIsNew) {
                    continue;
                }
                const before = prevBranches.get(`${app.region}/${app.appId}/${branch.branchName}`)?.latestJob;
                if (before && before.jobId === job.jobId && before.status === job.status) {
                    continue;
                }
                if (!before && TERMINAL_JOB_STATUSES.has(job.status)) {
                    continue; // newly tracked branch, nothing changed from the developer's point of view
                }
                const kind = eventKind(job.status, before?.jobId === job.jobId ? before.status : undefined);
                const commit = job.commitId ? ` ${shortSha(job.commitId)}` : '';
                const subject = job.commitMessage ? ` "${firstLine(job.commitMessage)}"` : '';
                events.push({
                    at, kind,
                    profile: account.profile, accountLabel: account.label,
                    appId: app.appId, appName: app.name, region: app.region, branch: branch.branchName,
                    jobId: job.jobId, from: before?.jobId === job.jobId ? before.status : undefined, to: job.status,
                    commitId: job.commitId, commitMessage: job.commitMessage, consoleUrl: job.consoleUrl,
                    message: `${account.label} / ${app.name} / ${branch.branchName}: job #${job.jobId} ${job.status}${commit}${subject}`,
                });
            }
        }
    }
    return events;
}

function eventKind(status: string, previousStatus: string | undefined): FleetEvent['kind'] {
    if (status === 'SUCCEED') { return 'succeeded'; }
    if (status === 'FAILED') { return 'failed'; }
    if (status === 'CANCELLED') { return 'cancelled'; }
    if (!previousStatus) { return 'started'; }
    return 'status-changed';
}

export function firstLine(text: string): string {
    const line = text.split('\n')[0].trim();
    return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}
