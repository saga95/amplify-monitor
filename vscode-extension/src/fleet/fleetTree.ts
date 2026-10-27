import * as vscode from 'vscode';
import { FleetMonitor, FleetTarget } from './fleetMonitor';
import { relativeTime } from './snapshotStore';
import { FleetAccount, FleetApp, FleetBranch, FleetHealth, FleetJob, WorkspaceDeployment, WorkspaceRepo, shortSha } from './types';

type Node =
    | { kind: 'workspace'; repos: WorkspaceRepo[] }
    | { kind: 'deployment'; repo: WorkspaceRepo; deployment: WorkspaceDeployment }
    | { kind: 'account'; account: FleetAccount }
    | { kind: 'app'; account: FleetAccount; app: FleetApp }
    | { kind: 'branch'; account: FleetAccount; app: FleetApp; branch: FleetBranch }
    | { kind: 'job'; account: FleetAccount; app: FleetApp; branch: FleetBranch; job: FleetJob }
    | { kind: 'message'; text: string; icon: string };

const HEALTH_ICON: Record<FleetHealth, [string, string | undefined]> = {
    ok: ['pass', 'testing.iconPassed'],
    failing: ['error', 'testing.iconFailed'],
    building: ['sync~spin', 'charts.blue'],
    warning: ['circle-slash', 'editorWarning.foreground'],
    error: ['warning', 'editorWarning.foreground'],
    unknown: ['circle-outline', undefined],
};

function healthIcon(health: FleetHealth): vscode.ThemeIcon {
    const [id, color] = HEALTH_ICON[health];
    return new vscode.ThemeIcon(id, color ? new vscode.ThemeColor(color) : undefined);
}

function jobHealth(status: string | undefined): FleetHealth {
    switch (status) {
        case 'SUCCEED': return 'ok';
        case 'FAILED': return 'failing';
        case 'CANCELLED': return 'warning';
        case undefined: return 'unknown';
        default: return 'building';
    }
}

function firstLine(text: string | undefined): string {
    return (text ?? '').split('\n')[0].trim();
}

export function targetFromNode(node: Node | undefined): FleetTarget | undefined {
    if (!node) {
        return undefined;
    }
    switch (node.kind) {
        case 'account':
            return { profile: node.account.profile, fixCommand: node.account.fixCommand };
        case 'app':
            return { profile: node.account.profile, region: node.app.region, appId: node.app.appId, appName: node.app.name, consoleUrl: node.app.consoleUrl };
        case 'branch':
            return {
                profile: node.account.profile, region: node.app.region, appId: node.app.appId, appName: node.app.name,
                branch: node.branch.branchName, jobId: node.branch.latestJob?.jobId, consoleUrl: node.branch.latestJob?.consoleUrl ?? node.branch.consoleUrl,
                url: node.branch.url,
            };
        case 'job':
            return {
                profile: node.account.profile, region: node.app.region, appId: node.app.appId, appName: node.app.name,
                branch: node.branch.branchName, jobId: node.job.jobId, consoleUrl: node.job.consoleUrl, url: node.branch.url,
            };
        case 'deployment': {
            const d = node.deployment;
            const job = d.headJob ?? d.latestJob;
            return { profile: d.profile, region: d.region, appId: d.appId, appName: d.appName, branch: d.branch, jobId: job?.jobId, consoleUrl: job?.consoleUrl };
        }
        default:
            return undefined;
    }
}

export class FleetTreeProvider implements vscode.TreeDataProvider<Node> {
    private readonly emitter = new vscode.EventEmitter<Node | undefined | void>();
    readonly onDidChangeTreeData = this.emitter.event;

    constructor(private readonly monitor: FleetMonitor) {
        monitor.onDidChange(() => this.emitter.fire());
    }

    getTreeItem(node: Node): vscode.TreeItem {
        switch (node.kind) {
            case 'message': {
                const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon(node.icon);
                return item;
            }

            case 'workspace': {
                const item = new vscode.TreeItem('This workspace', vscode.TreeItemCollapsibleState.Expanded);
                item.iconPath = new vscode.ThemeIcon('repo');
                const heads = node.repos.map(r => `${r.localBranch ?? '?'}@${shortSha(r.headCommit) ?? '?'}`).join(', ');
                item.description = heads;
                item.tooltip = 'Amplify branches built from the git repositories open in this window, and whether your HEAD commit is deployed.';
                return item;
            }

            case 'deployment': {
                const d = node.deployment;
                const item = new vscode.TreeItem(`${d.appName} / ${d.branch}`, vscode.TreeItemCollapsibleState.None);
                const stateText: Record<WorkspaceDeployment['headState'], string> = {
                    deployed: 'HEAD deployed', building: 'HEAD building', failed: 'HEAD failed', 'not-built': 'HEAD not built yet', unknown: '',
                };
                const latest = d.latestJob ? `latest ${d.latestJob.status} ${shortSha(d.latestJob.commitId) ?? ''}` : 'no jobs';
                item.description = [d.accountLabel, stateText[d.headState] || latest].filter(Boolean).join(' · ');
                const health: FleetHealth = d.headState === 'deployed' ? 'ok' : d.headState === 'failed' ? 'failing'
                    : d.headState === 'building' ? 'building' : jobHealth(d.latestJob?.status);
                item.iconPath = healthIcon(health);
                item.tooltip = new vscode.MarkdownString(
                    `**${d.accountLabel} / ${d.appName} / ${d.branch}**\n\n`
                    + `Local HEAD \`${shortSha(node.repo.headCommit) ?? '?'}\` ${firstLine(node.repo.headSubject)}\n\n`
                    + `State: **${d.headState}**\n\n`
                    + (d.latestJob ? `Latest job #${d.latestJob.jobId} ${d.latestJob.status} at \`${shortSha(d.latestJob.commitId) ?? '?'}\` — ${firstLine(d.latestJob.commitMessage)}` : ''));
                item.contextValue = d.latestJob?.status === 'FAILED' || d.headState === 'failed' ? 'fleetBranchFailed' : 'fleetBranch';
                return item;
            }

            case 'account': {
                const a = node.account;
                const item = new vscode.TreeItem(a.label, vscode.TreeItemCollapsibleState.Expanded);
                item.id = `acct:${a.profile}`;
                item.iconPath = a.status === 'pending' ? new vscode.ThemeIcon('loading~spin') : healthIcon(a.health);
                const branches = a.apps.flatMap(app => app.branches);
                const failing = branches.filter(b => b.health === 'failing').length;
                const building = branches.filter(b => b.health === 'building').length;
                const bits = [a.accountId, `${a.apps.length} app${a.apps.length === 1 ? '' : 's'}`];
                if (failing) { bits.push(`${failing} failing`); }
                if (building) { bits.push(`${building} building`); }
                if (a.status !== 'ok' && a.status !== 'pending') { bits.unshift(a.status === 'auth-expired' ? 'login expired' : a.status); }
                item.description = bits.filter(Boolean).join(' · ');
                item.tooltip = new vscode.MarkdownString(
                    `**${a.label}**\n\nProfile: \`${a.profile}\`\n\nAccount: ${a.accountId ?? 'unknown'}\n\nRegions: ${a.regions.join(', ') || '—'}\n\n`
                    + (a.error ? `⚠️ ${a.error}\n\n` : '')
                    + (a.fixCommand ? `Fix: \`${a.fixCommand}\`\n\n` : '')
                    + `Polled ${relativeTime(a.lastPolledAt)}`);
                item.contextValue = a.fixCommand ? 'fleetAccountFixable' : 'fleetAccount';
                return item;
            }

            case 'app': {
                const { account, app } = node;
                const item = new vscode.TreeItem(app.name, app.health === 'ok' || app.health === 'unknown'
                    ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
                item.id = `app:${account.profile}:${app.region}:${app.appId}`;
                item.iconPath = healthIcon(app.health);
                item.description = [app.region, app.repoKey?.split('/').slice(-2).join('/')].filter(Boolean).join(' · ');
                item.tooltip = new vscode.MarkdownString(
                    `**${app.name}**\n\nApp ID: \`${app.appId}\`\n\nRegion: ${app.region}\n\n`
                    + (app.repository ? `Repo: ${app.repository}\n\n` : '')
                    + (app.productionBranch ? `Production branch: \`${app.productionBranch}\`\n\n` : '')
                    + (app.hiddenBranches ? `${app.hiddenBranches} more branches not tracked (see amplifyMonitor.fleet.maxBranchesPerApp)\n\n` : '')
                    + (app.error ? `⚠️ ${app.error}` : ''));
                item.contextValue = 'fleetApp';
                return item;
            }

            case 'branch': {
                const { account, app, branch } = node;
                const job = branch.latestJob;
                const item = new vscode.TreeItem(branch.branchName, branch.recentJobs.length
                    ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
                item.id = `br:${account.profile}:${app.region}:${app.appId}:${branch.branchName}`;
                item.iconPath = healthIcon(branch.health);
                const parts = [
                    branch.isProduction ? 'prod' : undefined,
                    job ? job.status : 'no jobs',
                    shortSha(job?.commitId),
                    firstLine(job?.commitMessage).slice(0, 50) || undefined,
                    relativeTime(job?.endTime || job?.startTime) || undefined,
                ];
                item.description = parts.filter(Boolean).join(' · ');
                item.tooltip = new vscode.MarkdownString(
                    `**${app.name} / ${branch.branchName}**${branch.isProduction ? ' (production)' : ''}\n\n`
                    + (job ? `Job #${job.jobId}: **${job.status}**\n\nCommit \`${shortSha(job.commitId) ?? '?'}\`: ${firstLine(job.commitMessage)}\n\n`
                        + `Started ${relativeTime(job.startTime)}${job.durationSeconds !== undefined ? `, took ${Math.round(job.durationSeconds / 60)}m` : ''}\n\n` : 'No jobs yet\n\n')
                    + (branch.url ? `${branch.url}\n\n` : '')
                    + (branch.error ? `⚠️ ${branch.error}` : ''));
                item.contextValue = job?.status === 'FAILED' ? 'fleetBranchFailed' : 'fleetBranch';
                return item;
            }

            case 'job': {
                const { job } = node;
                const item = new vscode.TreeItem(`#${job.jobId} ${job.status}`, vscode.TreeItemCollapsibleState.None);
                item.iconPath = healthIcon(jobHealth(job.status));
                item.description = [shortSha(job.commitId), firstLine(job.commitMessage).slice(0, 60), relativeTime(job.endTime || job.startTime)]
                    .filter(Boolean).join(' · ');
                item.tooltip = new vscode.MarkdownString(
                    `**Job #${job.jobId}** ${job.status}${job.jobType ? ` (${job.jobType})` : ''}\n\n`
                    + `Commit \`${job.commitId ?? '?'}\`\n\n${(job.commitMessage ?? '').replace(/\n/g, '\n\n')}\n\n`
                    + `Started ${job.startTime ?? '?'}${job.endTime ? `, ended ${job.endTime}` : ''}`);
                item.contextValue = job.status === 'FAILED' ? 'fleetJobFailed' : 'fleetJob';
                item.command = { command: 'amplify-monitor.fleet.viewLogs', title: 'View Build Logs', arguments: [node] };
                if (job.logsDir) {
                    (item.tooltip as vscode.MarkdownString).appendMarkdown('\n\n$(file-text) Logs cached locally. Click to open.');
                }
                return item;
            }
        }
    }

    getChildren(node?: Node): Node[] {
        const snapshot = this.monitor.getSnapshot();
        if (!node) {
            if (!this.monitor.isConfigured()) {
                return []; // viewsWelcome shows the setup button
            }
            if (!snapshot) {
                return [{ kind: 'message', text: 'Polling AWS accounts…', icon: 'loading~spin' }];
            }
            const roots: Node[] = [];
            const repos = snapshot.workspace.filter(r => r.deployments.length > 0);
            if (repos.length > 0) {
                roots.push({ kind: 'workspace', repos });
            }
            roots.push(...snapshot.accounts.map(account => ({ kind: 'account' as const, account })));
            return roots;
        }

        switch (node.kind) {
            case 'workspace':
                return node.repos.flatMap(repo => repo.deployments.map(deployment => ({ kind: 'deployment' as const, repo, deployment })));
            case 'account': {
                const { account } = node;
                const children: Node[] = [];
                if (account.error) {
                    children.push({ kind: 'message', text: account.error, icon: 'warning' });
                }
                if (account.apps.length === 0 && !account.error) {
                    children.push({ kind: 'message', text: 'No Amplify apps found', icon: 'info' });
                }
                children.push(...account.apps.map(app => ({ kind: 'app' as const, account, app })));
                return children;
            }
            case 'app': {
                const children: Node[] = [];
                if (node.app.error) {
                    children.push({ kind: 'message', text: node.app.error, icon: 'warning' });
                }
                children.push(...node.app.branches.map(branch => ({ kind: 'branch' as const, account: node.account, app: node.app, branch })));
                return children;
            }
            case 'branch':
                return node.branch.recentJobs.map(job => ({ kind: 'job' as const, account: node.account, app: node.app, branch: node.branch, job }));
            default:
                return [];
        }
    }
}
