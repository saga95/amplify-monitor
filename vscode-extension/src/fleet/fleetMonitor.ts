import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { AwsCliClient } from './awsCli';
import { JobLogTarget, JobLogs, LOG_REQUESTS_DIR, LogRequest, LogRequestResult, pruneLogs, readJobLogs } from './buildLogs';
import { fetchJobLogs } from './logFetcher';
import { FleetPoller, collectAttention, diffAccounts, summarize } from './fleetPoller';
import { LocalRepoInfo, matchWorkspace, readLocalRepo } from './gitWorkspace';
import { SNAPSHOT_JSON, readSnapshot, relativeTime, resolveFleetDir, writeSnapshot } from './snapshotStore';
import {
    FLEET_SCHEMA_VERSION,
    FleetAccount,
    FleetAccountConfig,
    FleetEvent,
    FleetSnapshot,
    shortSha,
} from './types';

const CONFIG_SECTION = 'amplifyMonitor';
const FULL_REFRESH_MS = 5 * 60 * 1000;
const BOOST_AFTER_PUSH_MS = 15 * 60 * 1000;
const MAX_EVENTS = 100;
const WORKSPACE_FILE_TTL_MS = 15 * 60 * 1000;
const LOG_RETENTION_DAYS = 14;
const AUTO_FETCH_MAX_AGE_MS = 7 * 86_400_000;
const AUTO_FETCH_PER_POLL = 3;
// Arguments go to execFile (no shell); just reject control characters and values that look like CLI flags.
// eslint-disable-next-line no-control-regex
const SAFE_ID = /^[^\s\x00-\x1f-][^\x00-\x1f]{0,254}$/;
const SAFE_REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

interface PollerLock {
    id: string;
    pid: number;
    heartbeat: number;
}

/** Context passed to fleet commands from tree items, notifications and the chat participant. */
export interface FleetTarget {
    profile: string;
    region?: string;
    appId?: string;
    appName?: string;
    branch?: string;
    jobId?: string;
    consoleUrl?: string;
    url?: string;
    fixCommand?: string;
}

/**
 * Keeps an always-fresh picture of every Amplify app across the AWS profiles the
 * developer configured, using the AWS CLI.
 *
 * - Polls on an interval (faster while builds run or right after `git push`).
 * - Writes the result to a snapshot (JSON + Markdown) that AI agents read via the
 *   bundled MCP server, so agents never need to call AWS themselves.
 * - Only one VS Code window polls at a time (lock file). The other windows follow
 *   the snapshot file, so N open windows do not multiply AWS calls.
 */
export class FleetMonitor implements vscode.Disposable {
    private readonly sessionId = crypto.randomBytes(8).toString('hex');
    private readonly client: AwsCliClient;
    private readonly poller: FleetPoller;
    private readonly logFetches = new Map<string, Promise<JobLogs>>();
    private requestTimer: NodeJS.Timeout | undefined;
    private accounts: FleetAccount[] = [];
    private events: FleetEvent[] = [];
    private localRepos: LocalRepoInfo[] = [];
    private snapshot: FleetSnapshot | undefined;
    private timer: NodeJS.Timeout | undefined;
    private gitDebounce: NodeJS.Timeout | undefined;
    private polling = false;
    private queued: { full: boolean } | undefined;
    private lastFullPoll = 0;
    /** The first poll after startup diffs against the on-disk snapshot; don't toast what happened while VS Code was closed. */
    private quietNextPoll = true;
    private boostUntil = 0;
    private nextPollAt: number | undefined;
    private isLeader = false;
    private lastLoadedGeneratedAt: string | undefined;
    private watchedFile: string | undefined;
    private readonly seenEvents = new Set<string>();
    private readonly disposables: vscode.Disposable[] = [];
    private gitWatchers: vscode.Disposable[] = [];
    private readonly statusBar: vscode.StatusBarItem;
    private readonly changeEmitter = new vscode.EventEmitter<FleetSnapshot | undefined>();
    readonly onDidChange = this.changeEmitter.event;
    readonly output = vscode.window.createOutputChannel('Amplify Monitor: Fleet');

    constructor() {
        this.client = new AwsCliClient(() => ({
            awsPath: this.config().get<string>('fleet.awsCliPath') || 'aws',
            timeoutMs: 30_000,
        }));
        this.poller = new FleetPoller(this.client);
        this.statusBar = vscode.window.createStatusBarItem('amplifyMonitor.fleet', vscode.StatusBarAlignment.Left, 50);
        this.statusBar.name = 'Amplify Fleet';

        this.disposables.push(
            this.statusBar,
            this.output,
            this.changeEmitter,
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration(`${CONFIG_SECTION}.fleet`) || e.affectsConfiguration(`${CONFIG_SECTION}.multiAccount.profiles`)) {
                    this.onConfigChanged();
                }
            }),
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.setupGitWatchers()),
        );
    }

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    start(): void {
        this.updateContext();
        this.loadFromDisk(true);
        this.watchSnapshotFile();
        this.setupGitWatchers();
        void this.refreshLocalRepos();
        this.schedule(1500);
        // Agents ask for build logs by dropping request files; any open window may answer.
        this.requestTimer = setInterval(() => void this.processLogRequests(), 2000);
        setTimeout(() => {
            try {
                const removed = pruneLogs(this.getFleetDir(), LOG_RETENTION_DAYS);
                if (removed) { this.log(`Pruned ${removed} cached job logs older than ${LOG_RETENTION_DAYS} days.`); }
            } catch { /* ignore */ }
        }, 10_000);
    }

    /**
     * Download (or reuse cached) build/deploy logs for one job with the AWS CLI.
     * Only profiles configured for the fleet are allowed.
     */
    async getJobLogs(target: JobLogTarget, force = false): Promise<JobLogs> {
        if (!this.getAccountConfigs().some(c => c.profile === target.profile)) {
            throw new Error(`Profile "${target.profile}" is not one of the monitored fleet accounts.`);
        }
        if (![target.appId, target.branch, target.jobId].every(v => SAFE_ID.test(v)) || !SAFE_REGION.test(target.region)) {
            throw new Error('Invalid app, branch, job or region.');
        }
        const key = `${target.profile}|${target.region}|${target.appId}|${target.branch}|${target.jobId}|${force}`;
        let pending = this.logFetches.get(key);
        if (!pending) {
            pending = fetchJobLogs(this.client, this.getFleetDir(), target, force)
                .finally(() => this.logFetches.delete(key));
            this.logFetches.set(key, pending);
        }
        const logs = await pending;
        this.log(`Fetched logs for ${target.appName ?? target.appId}/${target.branch} job #${target.jobId}: `
            + `${logs.steps.filter(s => s.file).map(s => s.stepName).join(', ') || 'no step logs'}`);
        this.markLogsCached(target, logs.dir);
        return logs;
    }

    private markLogsCached(target: JobLogTarget, dir: string): void {
        let changed = false;
        for (const account of this.accounts) {
            if (account.profile !== target.profile) { continue; }
            for (const app of account.apps) {
                if (app.appId !== target.appId) { continue; }
                for (const branch of app.branches) {
                    if (branch.branchName !== target.branch) { continue; }
                    for (const job of branch.recentJobs) {
                        if (job.jobId === target.jobId && job.logsDir !== dir) {
                            job.logsDir = dir;
                            changed = true;
                        }
                    }
                }
            }
        }
        if (changed && this.snapshot && this.isLeader) {
            this.snapshot = this.buildSnapshot();
            try { writeSnapshot(this.getFleetDir(), this.snapshot); } catch { /* ignore */ }
            this.lastLoadedGeneratedAt = this.snapshot.generatedAt;
            this.changeEmitter.fire(this.snapshot);
        }
    }

    private async processLogRequests(): Promise<void> {
        if (!this.isConfigured()) {
            return;
        }
        const dir = path.join(this.getFleetDir(), LOG_REQUESTS_DIR);
        let names: string[];
        try {
            names = fs.readdirSync(dir);
        } catch {
            return;
        }
        for (const name of names) {
            const file = path.join(dir, name);
            if (name.endsWith('.done.json') || name.includes('.claimed-')) {
                // Clean up results nobody collected and claims from crashed windows.
                try {
                    if (Date.now() - fs.statSync(file).mtimeMs > 10 * 60_000) { fs.unlinkSync(file); }
                } catch { /* ignore */ }
                continue;
            }
            if (!name.endsWith('.json')) {
                continue;
            }
            const claimed = `${file}.claimed-${this.sessionId}`;
            try {
                fs.renameSync(file, claimed); // atomic: only one window wins
            } catch {
                continue;
            }
            let request: LogRequest | undefined;
            const result: LogRequestResult = { id: name.replace(/\.json$/, ''), ok: false, finishedAt: '' };
            try {
                request = JSON.parse(fs.readFileSync(claimed, 'utf-8')) as LogRequest;
                result.id = request.id;
                const logs = await this.getJobLogs({
                    profile: String(request.profile), region: String(request.region), appId: String(request.appId),
                    appName: request.appName, branch: String(request.branch), jobId: String(request.jobId),
                }, request.force === true);
                result.ok = true;
                result.dir = logs.dir;
            } catch (error) {
                result.error = error instanceof Error ? error.message : String(error);
                this.log(`Log request failed: ${result.error}`);
            }
            result.finishedAt = new Date().toISOString();
            try {
                fs.writeFileSync(path.join(dir, `${result.id}.done.json`), JSON.stringify(result), { mode: 0o600 });
                fs.unlinkSync(claimed);
            } catch { /* ignore */ }
        }
    }

    /** Pre-fetch logs of recent failures so agents and developers get them instantly. */
    private async autoFetchFailedLogs(): Promise<void> {
        if (!this.config().get<boolean>('fleet.autoFetchFailedLogs', true)) {
            return;
        }
        const targets: JobLogTarget[] = [];
        for (const account of this.accounts) {
            if (account.status !== 'ok') { continue; }
            for (const app of account.apps) {
                for (const branch of app.branches) {
                    const job = branch.latestJob;
                    const ended = Date.parse(job?.endTime || job?.startTime || '');
                    if (job?.status !== 'FAILED' || !(Date.now() - ended < AUTO_FETCH_MAX_AGE_MS)) { continue; }
                    const target = { profile: account.profile, region: app.region, appId: app.appId, appName: app.name, branch: branch.branchName, jobId: job.jobId };
                    if (!readJobLogs(this.getFleetDir(), target)?.complete) {
                        targets.push(target);
                    }
                }
            }
        }
        for (const target of targets.slice(0, AUTO_FETCH_PER_POLL)) {
            try {
                await this.getJobLogs(target);
            } catch (error) {
                this.log(`Auto-fetch of logs failed for ${target.appName}/${target.branch} #${target.jobId}: ${error instanceof Error ? error.message : error}`);
            }
        }
    }

    getSnapshot(): FleetSnapshot | undefined {
        return this.snapshot;
    }

    getFleetDir(): string {
        return resolveFleetDir(this.config().get<string>('fleet.snapshotDirectory'));
    }

    isConfigured(): boolean {
        return this.isEnabled() && this.getAccountConfigs().length > 0;
    }

    isPolling(): boolean {
        return this.polling;
    }

    /** Manual refresh. A full refresh also re-scans regions and re-lists every branch. */
    async refresh(full = true): Promise<void> {
        if (!this.isConfigured()) {
            return;
        }
        this.takeLock();
        await this.poll(full);
        this.schedule(this.nextDelayMs());
    }

    getAccountConfigs(): FleetAccountConfig[] {
        const raw = this.config().get<unknown[]>('fleet.accounts', []);
        const configs: FleetAccountConfig[] = [];
        for (const entry of raw ?? []) {
            if (typeof entry === 'string' && entry.trim()) {
                configs.push({ profile: entry.trim() });
            } else if (entry && typeof entry === 'object' && typeof (entry as FleetAccountConfig).profile === 'string') {
                configs.push(entry as FleetAccountConfig);
            }
        }
        if (configs.length === 0) {
            // Re-use the profiles chosen for the older multi-account panel.
            for (const profile of this.config().get<string[]>('multiAccount.profiles', [])) {
                configs.push({ profile });
            }
        }
        const seen = new Set<string>();
        return configs.filter(c => !seen.has(c.profile) && seen.add(c.profile));
    }

    async setAccountProfiles(profiles: string[]): Promise<void> {
        const existing = new Map(this.getAccountConfigs().map(c => [c.profile, c]));
        const next = profiles.map(p => {
            const prev = existing.get(p);
            return prev && (prev.label || prev.regions || prev.apps || prev.branches) ? prev : p;
        });
        await this.config().update('fleet.accounts', next, vscode.ConfigurationTarget.Global);
    }

    dispose(): void {
        if (this.timer) { clearTimeout(this.timer); }
        if (this.requestTimer) { clearInterval(this.requestTimer); }
        if (this.gitDebounce) { clearTimeout(this.gitDebounce); }
        if (this.watchedFile) { fs.unwatchFile(this.watchedFile); }
        this.releaseLock();
        this.gitWatchers.forEach(d => d.dispose());
        this.disposables.forEach(d => d.dispose());
    }

    // ------------------------------------------------------------------
    // Scheduling and leader election
    // ------------------------------------------------------------------

    private config(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration(CONFIG_SECTION);
    }

    private isEnabled(): boolean {
        return this.config().get<boolean>('fleet.enabled', true);
    }

    private onConfigChanged(): void {
        this.updateContext();
        this.watchSnapshotFile();
        if (!this.isConfigured()) {
            this.accounts = [];
            this.snapshot = undefined;
            this.changeEmitter.fire(undefined);
            this.updateStatusBar();
            return;
        }
        // Drop accounts that were removed, then poll right away.
        const profiles = new Set(this.getAccountConfigs().map(c => c.profile));
        this.accounts = this.accounts.filter(a => profiles.has(a.profile));
        // Settings are global, so every window gets this event; only the focused one polls now.
        if (vscode.window.state.focused) {
            void this.refresh(false);
        } else {
            this.schedule(5000);
        }
    }

    private updateContext(): void {
        void vscode.commands.executeCommand('setContext', 'amplifyMonitor.fleetConfigured', this.isConfigured());
        this.updateStatusBar();
    }

    private schedule(delayMs: number): void {
        if (this.timer) {
            clearTimeout(this.timer);
        }
        if (!this.isConfigured()) {
            this.nextPollAt = undefined;
            return;
        }
        this.nextPollAt = Date.now() + delayMs;
        this.timer = setTimeout(() => void this.tick(), delayMs);
    }

    private async tick(): Promise<void> {
        try {
            if (this.tryAcquireLock()) {
                await this.poll(false);
            } else {
                this.loadFromDisk(false);
                await this.publishLocalRepos();
            }
        } catch (error) {
            this.log(`Tick failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.schedule(this.nextDelayMs());
        }
    }

    private nextDelayMs(): number {
        const interval = Math.max(30, this.config().get<number>('fleet.pollIntervalSeconds', 60));
        const active = Math.max(10, this.config().get<number>('fleet.activePollIntervalSeconds', 20));
        const busy = (this.snapshot?.summary.building ?? 0) > 0 || Date.now() < this.boostUntil;
        return (busy ? Math.min(active, interval) : interval) * 1000;
    }

    private lockPath(): string {
        return path.join(this.getFleetDir(), 'poller.lock');
    }

    private readLock(): PollerLock | undefined {
        try {
            return JSON.parse(fs.readFileSync(this.lockPath(), 'utf-8')) as PollerLock;
        } catch {
            return undefined;
        }
    }

    private takeLock(): void {
        try {
            fs.mkdirSync(this.getFleetDir(), { recursive: true, mode: 0o700 });
            const lock: PollerLock = { id: this.sessionId, pid: process.pid, heartbeat: Date.now() };
            fs.writeFileSync(this.lockPath(), JSON.stringify(lock), { mode: 0o600 });
            this.isLeader = true;
        } catch (error) {
            // If the lock cannot be written, poll anyway rather than show nothing.
            this.isLeader = true;
            this.log(`Could not write poller lock: ${error}`);
        }
    }

    private tryAcquireLock(): boolean {
        const lock = this.readLock();
        const interval = Math.max(30, this.config().get<number>('fleet.pollIntervalSeconds', 60));
        const staleMs = Math.max(interval * 3, 180) * 1000;
        const free = !lock
            || lock.id === this.sessionId
            || Date.now() - lock.heartbeat > staleMs
            || !isProcessAlive(lock.pid);
        if (free) {
            this.takeLock();
        } else if (this.isLeader) {
            this.log('Another VS Code window took over polling; following its snapshot.');
            this.isLeader = false;
        }
        return free;
    }

    private releaseLock(): void {
        const lock = this.readLock();
        if (lock?.id === this.sessionId) {
            try { fs.unlinkSync(this.lockPath()); } catch { /* ignore */ }
        }
    }

    // ------------------------------------------------------------------
    // Polling
    // ------------------------------------------------------------------

    private async poll(full: boolean): Promise<void> {
        if (this.polling) {
            this.queued = { full: full || (this.queued?.full ?? false) };
            return;
        }
        const configs = this.getAccountConfigs();
        if (!this.isEnabled() || configs.length === 0) {
            return;
        }

        this.polling = true;
        this.updateStatusBar();
        const started = Date.now();
        const force = full || started - this.lastFullPoll > FULL_REFRESH_MS;
        try {
            const previous = this.accounts;
            const next = await this.poller.pollAll(configs, previous, {
                maxBranchesPerApp: Math.max(1, this.config().get<number>('fleet.maxBranchesPerApp', 5)),
                jobsPerBranch: Math.min(25, Math.max(1, this.config().get<number>('fleet.jobsPerBranch', 5))),
                concurrency: Math.max(1, this.config().get<number>('fleet.concurrency', 6)),
                force,
                rediscoverRegions: full,
            });
            if (force) {
                this.lastFullPoll = started;
            }

            const newEvents = diffAccounts(previous, next);
            this.accounts = next;
            this.events = [...newEvents.reverse(), ...this.events].slice(0, MAX_EVENTS);
            this.localRepos = await this.collectLocalRepos();

            const quiet = this.quietNextPoll;
            this.quietNextPoll = false;
            this.snapshot = this.buildSnapshot();
            const { jsonPath } = writeSnapshot(this.getFleetDir(), this.snapshot);
            this.lastLoadedGeneratedAt = this.snapshot.generatedAt;
            this.takeLock(); // heartbeat

            const s = this.snapshot.summary;
            this.log(`Polled ${s.accounts} accounts, ${s.apps} apps, ${s.branches} branches in ${Date.now() - started}ms`
                + `${force ? ' (full)' : ''}; ${newEvents.length} new events → ${jsonPath}`);
            this.changeEmitter.fire(this.snapshot);
            this.handleEvents(newEvents, quiet);
            void this.autoFetchFailedLogs();
        } catch (error) {
            this.log(`Poll failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.polling = false;
            this.updateStatusBar();
            if (this.queued) {
                const q = this.queued;
                this.queued = undefined;
                void this.poll(q.full);
            }
        }
    }

    private buildSnapshot(): FleetSnapshot {
        const interval = Math.max(30, this.config().get<number>('fleet.pollIntervalSeconds', 60));
        const accountsInOrder = this.orderAccounts(this.accounts);
        // Point jobs at their cached logs so agents reading the snapshot can open them directly.
        const fleetDir = this.getFleetDir();
        for (const account of accountsInOrder) {
            for (const app of account.apps) {
                for (const branch of app.branches) {
                    for (const job of branch.recentJobs) {
                        const cached = readJobLogs(fleetDir, { profile: account.profile, appId: app.appId, branch: branch.branchName, jobId: job.jobId });
                        job.logsDir = cached?.dir;
                    }
                }
            }
        }
        return {
            schemaVersion: FLEET_SCHEMA_VERSION,
            generator: 'amplify-monitor-vscode',
            generatedAt: new Date().toISOString(),
            pollIntervalSeconds: interval,
            nextPollAt: new Date(Date.now() + this.nextDelayMs()).toISOString(),
            polling: true,
            summary: summarize(accountsInOrder),
            attention: collectAttention(accountsInOrder),
            workspace: matchWorkspace(this.localRepos, accountsInOrder),
            accounts: accountsInOrder,
            recentEvents: this.events,
        };
    }

    private orderAccounts(accounts: FleetAccount[]): FleetAccount[] {
        const order = this.getAccountConfigs().map(c => c.profile);
        return [...accounts].sort((a, b) => order.indexOf(a.profile) - order.indexOf(b.profile));
    }

    /** Follower windows (and startup) read the snapshot written by the polling window. */
    private loadFromDisk(initial: boolean): void {
        if (!this.isConfigured()) {
            return;
        }
        const snapshot = readSnapshot(this.getFleetDir());
        if (!snapshot || snapshot.generatedAt === this.lastLoadedGeneratedAt) {
            return;
        }
        const profiles = new Set(this.getAccountConfigs().map(c => c.profile));
        this.lastLoadedGeneratedAt = snapshot.generatedAt;
        this.accounts = snapshot.accounts.filter(a => profiles.has(a.profile));
        this.events = snapshot.recentEvents ?? [];

        const freshEvents = this.events.filter(e => !this.seenEvents.has(eventKey(e)));
        if (initial) {
            freshEvents.forEach(e => this.seenEvents.add(eventKey(e)));
        }
        // Re-match using this window's repositories (the poller may not know them yet).
        this.snapshot = {
            ...snapshot,
            accounts: this.orderAccounts(this.accounts),
            workspace: this.localRepos.length ? matchWorkspace(this.localRepos, this.accounts) : snapshot.workspace,
        };
        this.changeEmitter.fire(this.snapshot);
        this.updateStatusBar();
        if (!initial) {
            // This window's in-memory state is now current, so its own next poll's diff is genuine.
            this.quietNextPoll = false;
            this.handleEvents(freshEvents, !vscode.window.state.focused);
        }
    }

    private watchSnapshotFile(): void {
        const file = path.join(this.getFleetDir(), SNAPSHOT_JSON);
        if (this.watchedFile === file) {
            return;
        }
        if (this.watchedFile) {
            fs.unwatchFile(this.watchedFile);
        }
        this.watchedFile = file;
        fs.watchFile(file, { interval: 3000, persistent: false }, () => this.loadFromDisk(false));
    }

    // ------------------------------------------------------------------
    // Workspace / git integration
    // ------------------------------------------------------------------

    private async readOwnRepos(): Promise<LocalRepoInfo[]> {
        const folders = vscode.workspace.workspaceFolders ?? [];
        const repos = await Promise.all(folders.map(f => readLocalRepo(f.uri.fsPath)));
        return repos.filter((r): r is LocalRepoInfo => !!r);
    }

    private workspaceFile(): string {
        const key = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath).join('|') || 'empty';
        return path.join(this.getFleetDir(), 'workspaces', `${crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)}.json`);
    }

    /** Share this window's repos so the polling window can include them in the snapshot. */
    private async publishLocalRepos(own?: LocalRepoInfo[]): Promise<void> {
        const repos = own ?? await this.readOwnRepos();
        const file = this.workspaceFile();
        try {
            if (repos.length === 0) {
                if (fs.existsSync(file)) { fs.unlinkSync(file); }
                return;
            }
            fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
            fs.writeFileSync(file, JSON.stringify(repos), { mode: 0o600 });
        } catch {
            // best effort
        }
    }

    private async collectLocalRepos(): Promise<LocalRepoInfo[]> {
        const own = await this.readOwnRepos();
        await this.publishLocalRepos(own);
        const byFolder = new Map(own.map(r => [r.folder, r]));
        const dir = path.join(this.getFleetDir(), 'workspaces');
        try {
            for (const name of fs.readdirSync(dir)) {
                const file = path.join(dir, name);
                const stat = fs.statSync(file);
                if (Date.now() - stat.mtimeMs > WORKSPACE_FILE_TTL_MS) {
                    fs.unlinkSync(file);
                    continue;
                }
                for (const repo of JSON.parse(fs.readFileSync(file, 'utf-8')) as LocalRepoInfo[]) {
                    if (!byFolder.has(repo.folder)) {
                        byFolder.set(repo.folder, repo);
                    }
                }
            }
        } catch {
            // no other windows
        }
        return Array.from(byFolder.values());
    }

    private async refreshLocalRepos(): Promise<void> {
        const own = await this.readOwnRepos();
        this.localRepos = this.isLeader ? await this.collectLocalRepos() : own;
        if (!this.isLeader) {
            await this.publishLocalRepos(own);
        }
        if (this.snapshot) {
            this.snapshot = { ...this.snapshot, workspace: matchWorkspace(this.localRepos, this.accounts) };
            if (this.isLeader) {
                try { writeSnapshot(this.getFleetDir(), this.snapshot); } catch { /* ignore */ }
            }
            this.changeEmitter.fire(this.snapshot);
        }
    }

    private setupGitWatchers(): void {
        this.gitWatchers.forEach(d => d.dispose());
        this.gitWatchers = [];
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '.git/{HEAD,refs/**,packed-refs}'));
            const onChange = (uri: vscode.Uri) => this.onGitChange(uri.fsPath.replace(/\\/g, '/').includes('/refs/remotes/'));
            this.gitWatchers.push(watcher, watcher.onDidChange(onChange), watcher.onDidCreate(onChange));
        }
    }

    /** A new local commit updates the workspace view; a push also speeds up polling for a while. */
    private onGitChange(pushed: boolean): void {
        if (this.gitDebounce) {
            clearTimeout(this.gitDebounce);
        }
        this.gitDebounce = setTimeout(() => {
            void this.refreshLocalRepos();
            if (pushed && this.isConfigured()) {
                this.boostUntil = Date.now() + BOOST_AFTER_PUSH_MS;
                this.log('Detected git push; polling faster for 15 minutes.');
                // The window you push from becomes the poller so it reacts quickly.
                this.takeLock();
                this.schedule(10_000);
            }
        }, 1000);
    }

    private isWorkspaceHead(commitId: string | undefined): boolean {
        if (!commitId) {
            return false;
        }
        const c = commitId.toLowerCase();
        return this.localRepos.some(r => r.headCommit?.toLowerCase() === c);
    }

    // ------------------------------------------------------------------
    // Notifications and status bar
    // ------------------------------------------------------------------

    private handleEvents(events: FleetEvent[], quiet: boolean): void {
        const fresh = events.filter(e => !this.seenEvents.has(eventKey(e)));
        fresh.forEach(e => this.seenEvents.add(eventKey(e)));
        if (quiet) {
            return;
        }
        const cfg = this.config();
        const notifyFailed = cfg.get<boolean>('notifications.buildFailed', true);
        const notifySucceeded = cfg.get<boolean>('notifications.buildSucceeded', false);
        const notifyMine = cfg.get<boolean>('fleet.notifyOnWorkspaceDeploy', true);

        for (const event of fresh.slice(0, 5)) {
            const target: FleetTarget = {
                profile: event.profile, region: event.region, appId: event.appId, appName: event.appName,
                branch: event.branch, jobId: event.jobId, consoleUrl: event.consoleUrl,
            };
            const mine = this.isWorkspaceHead(event.commitId);
            switch (event.kind) {
                case 'failed':
                    if (notifyFailed || (mine && notifyMine)) {
                        void vscode.window.showErrorMessage(`Amplify: ${event.message}`, 'View Logs', 'Diagnose', 'Open Console').then(choice => {
                            if (choice === 'View Logs') {
                                void vscode.commands.executeCommand('amplify-monitor.fleet.viewLogs', target);
                            } else if (choice === 'Diagnose') {
                                void vscode.commands.executeCommand('amplify-monitor.fleet.diagnose', target);
                            } else if (choice === 'Open Console') {
                                void vscode.commands.executeCommand('amplify-monitor.fleet.openConsole', target);
                            }
                        });
                    }
                    break;
                case 'succeeded':
                    if (mine && notifyMine) {
                        void vscode.window.showInformationMessage(
                            `Amplify: your commit ${shortSha(event.commitId)} is live on ${event.accountLabel} / ${event.appName} / ${event.branch}`,
                            'Open Console');
                    } else if (notifySucceeded) {
                        void vscode.window.showInformationMessage(`Amplify: ${event.message}`);
                    }
                    break;
                case 'started':
                    if (mine && notifyMine) {
                        vscode.window.setStatusBarMessage(`$(sync~spin) Amplify is building your commit ${shortSha(event.commitId)} on ${event.appName}/${event.branch}`, 15_000);
                    }
                    break;
                case 'account-error': {
                    const account = this.accounts.find(a => a.profile === event.profile);
                    const actions = account?.fixCommand ? ['Run Fix'] : [];
                    void vscode.window.showWarningMessage(`Amplify: ${event.message}`, ...actions).then(choice => {
                        if (choice === 'Run Fix') {
                            void vscode.commands.executeCommand('amplify-monitor.fleet.runFix', { profile: event.profile, fixCommand: account?.fixCommand });
                        }
                    });
                    break;
                }
                default:
                    break;
            }
        }
    }

    private updateStatusBar(): void {
        if (!this.isEnabled()) {
            this.statusBar.hide();
            return;
        }
        if (!this.isConfigured()) {
            this.statusBar.text = '$(cloud) Amplify';
            this.statusBar.tooltip = 'Amplify Monitor: monitor apps across several AWS accounts. Click to choose profiles.';
            this.statusBar.command = 'amplify-monitor.fleet.configure';
            this.statusBar.backgroundColor = undefined;
            this.statusBar.show();
            return;
        }

        const s = this.snapshot?.summary;
        const parts: string[] = [this.polling ? '$(sync~spin)' : '$(cloud)'];
        if (!s) {
            parts.push('Amplify');
        } else {
            if (s.failing) { parts.push(`$(error) ${s.failing}`); }
            if (s.building) { parts.push(`$(loading~spin) ${s.building}`); }
            if (s.accountErrors) { parts.push(`$(warning) ${s.accountErrors}`); }
            parts.push(`$(pass) ${s.ok}`);
        }
        this.statusBar.text = parts.join(' ');
        this.statusBar.backgroundColor = s && (s.failing || s.accountErrors)
            ? new vscode.ThemeColor('statusBarItem.errorBackground')
            : undefined;

        const md = new vscode.MarkdownString(undefined, true);
        md.appendMarkdown('**Amplify fleet**\n\n');
        if (s) {
            md.appendMarkdown(`${s.accounts} accounts · ${s.apps} apps · ${s.branches} branches\n\n`);
            for (const item of (this.snapshot?.attention ?? []).slice(0, 8)) {
                const icon = item.severity === 'error' ? '$(error)' : item.severity === 'warning' ? '$(warning)' : '$(sync)';
                md.appendMarkdown(`${icon} ${escapeMd(item.message)}\n\n`);
            }
            if ((this.snapshot?.attention ?? []).length === 0) {
                md.appendMarkdown('$(pass) All tracked branches healthy\n\n');
            }
            md.appendMarkdown(`Updated ${relativeTime(this.snapshot?.generatedAt)}`
                + (this.isLeader ? '' : ' (polled by another window)'));
        } else {
            md.appendMarkdown('Loading…');
        }
        this.statusBar.tooltip = md;
        this.statusBar.command = 'amplifyFleet.focus';
        this.statusBar.show();
    }

    private log(message: string): void {
        this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
    }
}

function eventKey(e: FleetEvent): string {
    return `${e.profile}|${e.appId ?? ''}|${e.branch ?? ''}|${e.jobId ?? ''}|${e.kind}|${e.to ?? ''}|${e.kind.startsWith('account') ? e.at : ''}`;
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

function escapeMd(text: string): string {
    return text.replace(/[\\`*_{}[\]()#+!|<>]/g, '\\$&');
}
