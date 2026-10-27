/**
 * Shared types for the multi-account "Fleet" monitor.
 *
 * This file must not import `vscode`: it is also compiled into the standalone
 * MCP server (fleet/mcpServer.ts) that AI agents run outside the editor.
 */

export const FLEET_SCHEMA_VERSION = 1;

/** Aggregated health, ordered from most to least severe (see HEALTH_SEVERITY). */
export type FleetHealth = 'error' | 'failing' | 'building' | 'warning' | 'ok' | 'unknown';

export const HEALTH_SEVERITY: Record<FleetHealth, number> = {
    error: 5,
    failing: 4,
    building: 3,
    warning: 2,
    ok: 1,
    unknown: 0,
};

export type AccountStatus = 'ok' | 'pending' | 'auth-expired' | 'no-credentials' | 'access-denied' | 'error';

export interface FleetAccountConfig {
    /** Named profile from ~/.aws/config or ~/.aws/credentials. */
    profile: string;
    /** Friendly name, e.g. the client name. Defaults to the profile name. */
    label?: string;
    /** Regions to poll. Empty or ["*"] = discover the regions that contain Amplify apps. */
    regions?: string[];
    /** Only include these apps (app ID or app name, case-insensitive). */
    apps?: string[];
    /** Only include these branches (exact name or simple `*` glob). The production branch is always included. */
    branches?: string[];
}

export interface FleetJob {
    jobId: string;
    status: string;
    jobType?: string;
    commitId?: string;
    commitMessage?: string;
    commitTime?: string;
    startTime?: string;
    endTime?: string;
    durationSeconds?: number;
    consoleUrl: string;
    /** Folder with the downloaded step logs (BUILD.txt, DEPLOY.txt, job.json), when cached. */
    logsDir?: string;
}

export interface FleetBranch {
    branchName: string;
    displayName?: string;
    stage?: string;
    isProduction: boolean;
    health: FleetHealth;
    activeJobId?: string;
    updateTime?: string;
    url?: string;
    consoleUrl: string;
    latestJob?: FleetJob;
    recentJobs: FleetJob[];
    error?: string;
}

export interface FleetApp {
    appId: string;
    name: string;
    region: string;
    repository?: string;
    /** Normalised "host/owner/repo" used to match local git remotes. */
    repoKey?: string;
    defaultDomain?: string;
    productionBranch?: string;
    health: FleetHealth;
    consoleUrl: string;
    branches: FleetBranch[];
    /** Number of branches not polled because of maxBranchesPerApp / branch filters. */
    hiddenBranches: number;
    error?: string;
}

export interface FleetAccount {
    profile: string;
    label: string;
    accountId?: string;
    regions: string[];
    status: AccountStatus;
    health: FleetHealth;
    error?: string;
    /** Shell command the developer can run to fix the account error (e.g. `aws sso login`). */
    fixCommand?: string;
    lastPolledAt?: string;
    apps: FleetApp[];
}

export type FleetEventKind = 'started' | 'succeeded' | 'failed' | 'cancelled' | 'status-changed' | 'account-error' | 'account-recovered';

export interface FleetEvent {
    at: string;
    kind: FleetEventKind;
    profile: string;
    accountLabel: string;
    appId?: string;
    appName?: string;
    region?: string;
    branch?: string;
    jobId?: string;
    from?: string;
    to?: string;
    commitId?: string;
    commitMessage?: string;
    consoleUrl?: string;
    message: string;
}

export interface AttentionItem {
    severity: 'error' | 'warning' | 'info';
    message: string;
    profile: string;
    accountLabel: string;
    appId?: string;
    appName?: string;
    region?: string;
    branch?: string;
    jobId?: string;
    consoleUrl?: string;
    fixCommand?: string;
    logsDir?: string;
}

export interface WorkspaceDeployment {
    profile: string;
    accountLabel: string;
    appId: string;
    appName: string;
    region: string;
    branch: string;
    latestJob?: FleetJob;
    /** The Amplify job built from the local HEAD commit, if one exists. */
    headJob?: FleetJob;
    /** 'deployed' | 'building' | 'failed' | 'not-built' (HEAD not pushed or not yet picked up) | 'unknown'. */
    headState: 'deployed' | 'building' | 'failed' | 'not-built' | 'unknown';
}

export interface WorkspaceRepo {
    folder: string;
    repoKey: string;
    localBranch?: string;
    headCommit?: string;
    headSubject?: string;
    /** Amplify branches (in any configured account) built from this repository. */
    deployments: WorkspaceDeployment[];
}

export interface FleetSummary {
    accounts: number;
    accountErrors: number;
    apps: number;
    branches: number;
    ok: number;
    failing: number;
    building: number;
    warning: number;
}

export interface FleetSnapshot {
    schemaVersion: number;
    generator: string;
    generatedAt: string;
    pollIntervalSeconds: number;
    nextPollAt?: string;
    polling: boolean;
    summary: FleetSummary;
    attention: AttentionItem[];
    workspace: WorkspaceRepo[];
    accounts: FleetAccount[];
    recentEvents: FleetEvent[];
}

export const ACTIVE_JOB_STATUSES = new Set(['PENDING', 'PROVISIONING', 'RUNNING', 'CANCELLING']);
export const TERMINAL_JOB_STATUSES = new Set(['SUCCEED', 'FAILED', 'CANCELLED']);

export function healthFromJobStatus(status: string | undefined): FleetHealth {
    if (!status) {
        return 'unknown';
    }
    if (status === 'FAILED') {
        return 'failing';
    }
    if (ACTIVE_JOB_STATUSES.has(status)) {
        return 'building';
    }
    if (status === 'SUCCEED') {
        return 'ok';
    }
    if (status === 'CANCELLED') {
        return 'warning';
    }
    return 'unknown';
}

export function worstHealth(values: FleetHealth[]): FleetHealth {
    let worst: FleetHealth = 'unknown';
    for (const value of values) {
        if (HEALTH_SEVERITY[value] > HEALTH_SEVERITY[worst]) {
            worst = value;
        }
    }
    return worst;
}

export function amplifyConsoleUrl(region: string, appId: string, branch?: string, jobId?: string): string {
    const base = `https://${region}.console.aws.amazon.com/amplify/home?region=${region}#/${appId}`;
    if (!branch) {
        return base;
    }
    const withBranch = `${base}/${encodeURIComponent(branch)}`;
    return jobId ? `${withBranch}/${jobId}` : withBranch;
}

/**
 * Normalise a git remote or Amplify repository URL to "host/owner/repo".
 * Handles https, ssh (git@host:owner/repo.git) and CodeCommit-style URLs.
 */
export function normalizeRepoUrl(url: string | undefined): string | undefined {
    if (!url) {
        return undefined;
    }
    let value = url.trim();
    if (!value) {
        return undefined;
    }
    // scp-like syntax: git@github.com:owner/repo.git
    const scpLike = value.match(/^[^@/\s]+@([^:/\s]+):(.+)$/);
    if (scpLike) {
        value = `${scpLike[1]}/${scpLike[2]}`;
    } else {
        value = value.replace(/^[a-z+]+:\/\//i, '');
        value = value.replace(/^[^@/]+@/, ''); // strip credentials
    }
    value = value.replace(/:\d+\//, '/'); // strip port
    value = value.replace(/\/+$/, '').replace(/\.git$/i, '');
    return value.toLowerCase();
}

/** Short, human friendly commit id. */
export function shortSha(commitId: string | undefined): string | undefined {
    if (!commitId) {
        return undefined;
    }
    return /^[0-9a-f]{7,40}$/i.test(commitId) ? commitId.slice(0, 7) : commitId;
}
