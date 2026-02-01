import * as vscode from 'vscode';
import { AmplifyMonitorCli, AmplifyJob, DiagnosisResult } from './cli';

interface WatchedBuild {
    appId: string;
    branch: string;
    jobId: string;
    startTime: Date;
    lastStatus: string;
    pollCount: number;
}

interface BuildNotification {
    appId: string;
    branch: string;
    jobId: string;
    status: string;
    duration?: number;
    diagnosis?: DiagnosisResult;
}

export class PostPushWatcher {
    private _cli: AmplifyMonitorCli;
    private _watchedBuilds: Map<string, WatchedBuild> = new Map();
    private _pollInterval: NodeJS.Timeout | undefined;
    private _gitExtension: vscode.Extension<any> | undefined;
    private _disposables: vscode.Disposable[] = [];
    private _statusBarItem: vscode.StatusBarItem;
    private _outputChannel: vscode.OutputChannel;
    private _onBuildStatusChanged: vscode.EventEmitter<BuildNotification>;
    public readonly onBuildStatusChanged: vscode.Event<BuildNotification>;

    // Configuration
    private _pollIntervalMs = 10000; // 10 seconds
    private _maxPollCount = 180; // 30 minutes max
    private _autoWatchEnabled = true;

    constructor(cli: AmplifyMonitorCli) {
        this._cli = cli;
        this._outputChannel = vscode.window.createOutputChannel('Amplify Build Watcher');
        this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this._statusBarItem.command = 'amplify-monitor.showWatchedBuilds';
        
        this._onBuildStatusChanged = new vscode.EventEmitter<BuildNotification>();
        this.onBuildStatusChanged = this._onBuildStatusChanged.event;

        this._loadConfiguration();
        this._setupGitWatcher();
        this._setupConfigWatcher();
    }

    private _loadConfiguration() {
        const config = vscode.workspace.getConfiguration('amplifyMonitor');
        this._autoWatchEnabled = config.get('autoWatchBuilds', true);
        this._pollIntervalMs = config.get('buildPollInterval', 10) * 1000;
    }

    private _setupConfigWatcher() {
        this._disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('amplifyMonitor')) {
                    this._loadConfiguration();
                }
            })
        );
    }

    private _setupGitWatcher() {
        // Get the Git extension
        this._gitExtension = vscode.extensions.getExtension('vscode.git');
        
        if (!this._gitExtension) {
            this._log('Git extension not found. Post-push watching disabled.');
            return;
        }

        this._gitExtension.activate().then(git => {
            const api = git.getAPI(1);
            
            if (!api) {
                this._log('Git API not available');
                return;
            }

            // Watch for repository changes
            for (const repo of api.repositories) {
                this._watchRepository(repo);
            }

            // Watch for new repositories
            api.onDidOpenRepository((repo: any) => {
                this._watchRepository(repo);
            });

            this._log('Git watcher initialized');
        }, (err: Error) => {
            this._log(`Failed to activate Git extension: ${err.message}`);
        });
    }

    private _watchRepository(repo: any) {
        // Listen for push events
        if (repo.state && repo.state.onDidChange) {
            this._disposables.push(
                repo.state.onDidChange(() => {
                    // Check if a push just happened by comparing refs
                    this._checkForPush(repo);
                })
            );
        }

        // Also watch for terminal commands (git push)
        this._disposables.push(
            vscode.window.onDidCloseTerminal(terminal => {
                // When terminal closes, check if it was a git push
                this._checkForRecentPush();
            })
        );
    }

    private async _checkForPush(repo: any) {
        if (!this._autoWatchEnabled) return;

        try {
            const head = repo.state?.HEAD;
            if (head?.name) {
                // Detected potential push, start watching builds
                await this._startWatchingAfterPush(head.name);
            }
        } catch (err) {
            this._log(`Error checking for push: ${err}`);
        }
    }

    private async _checkForRecentPush() {
        if (!this._autoWatchEnabled) return;

        // Check active workspace for Amplify apps
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;

        for (const folder of workspaceFolders) {
            try {
                // Look for amplify.yml or check if this is an Amplify project
                const amplifyYml = await vscode.workspace.findFiles(
                    new vscode.RelativePattern(folder, '**/amplify.yml'),
                    '**/node_modules/**',
                    1
                );

                if (amplifyYml.length > 0) {
                    // This might be an Amplify project, try to find matching app
                    await this._autoDetectAndWatch();
                    break;
                }
            } catch (err) {
                // Ignore errors
            }
        }
    }

    /**
     * Manually start watching a specific app/branch for builds after push
     */
    public async startWatching(appId: string, branch: string): Promise<void> {
        this._log(`Starting to watch builds for ${appId}/${branch}`);
        
        try {
            // Get the latest job to see if a new build started
            const jobs = await this._cli.listJobs(appId, branch);
            
            if (jobs.length === 0) {
                vscode.window.showInformationMessage(`No builds found for ${branch}. Waiting for new build...`);
                // Still add to watch list to catch new builds
            }

            const latestJob = jobs[0];
            const watchKey = `${appId}:${branch}`;

            if (latestJob) {
                this._watchedBuilds.set(watchKey, {
                    appId,
                    branch,
                    jobId: latestJob.jobId,
                    startTime: new Date(),
                    lastStatus: latestJob.status,
                    pollCount: 0
                });

                if (latestJob.status === 'PENDING' || latestJob.status === 'RUNNING') {
                    this._showBuildStartedNotification(appId, branch, latestJob.jobId);
                }
            } else {
                // Watch for any new build
                this._watchedBuilds.set(watchKey, {
                    appId,
                    branch,
                    jobId: '',
                    startTime: new Date(),
                    lastStatus: 'WAITING',
                    pollCount: 0
                });
            }

            this._updateStatusBar();
            this._startPolling();

        } catch (err: any) {
            this._log(`Error starting watch: ${err.message}`);
            vscode.window.showErrorMessage(`Failed to start watching builds: ${err.message}`);
        }
    }

    /**
     * Stop watching a specific app/branch
     */
    public stopWatching(appId: string, branch: string): void {
        const watchKey = `${appId}:${branch}`;
        this._watchedBuilds.delete(watchKey);
        this._updateStatusBar();
        this._log(`Stopped watching ${appId}/${branch}`);

        if (this._watchedBuilds.size === 0) {
            this._stopPolling();
        }
    }

    /**
     * Stop watching all builds
     */
    public stopAll(): void {
        this._watchedBuilds.clear();
        this._stopPolling();
        this._updateStatusBar();
        this._log('Stopped watching all builds');
    }

    /**
     * Get list of currently watched builds
     */
    public getWatchedBuilds(): WatchedBuild[] {
        return Array.from(this._watchedBuilds.values());
    }

    private async _startWatchingAfterPush(branchName: string) {
        // Try to find the Amplify app for this branch
        try {
            const apps = await this._cli.listApps();
            
            for (const app of apps) {
                const branches = await this._cli.listBranches(app.appId);
                const matchingBranch = branches.find(b => b.branchName === branchName);
                
                if (matchingBranch) {
                    this._log(`Found matching Amplify app: ${app.name} (${app.appId}) for branch ${branchName}`);
                    await this.startWatching(app.appId, branchName);
                    return;
                }
            }
        } catch (err) {
            this._log(`Error auto-detecting Amplify app: ${err}`);
        }
    }

    private async _autoDetectAndWatch() {
        try {
            const apps = await this._cli.listApps();
            
            if (apps.length === 1) {
                // Only one app, try to watch main/master
                const app = apps[0];
                const branches = await this._cli.listBranches(app.appId);
                const mainBranch = branches.find(b => 
                    b.branchName === 'main' || b.branchName === 'master'
                );

                if (mainBranch) {
                    await this.startWatching(app.appId, mainBranch.branchName);
                }
            }
        } catch (err) {
            // Silently fail - auto-detection is best-effort
        }
    }

    private _startPolling() {
        if (this._pollInterval) return; // Already polling

        this._pollInterval = setInterval(() => {
            this._pollBuilds();
        }, this._pollIntervalMs);

        this._log(`Started polling every ${this._pollIntervalMs / 1000}s`);
    }

    private _stopPolling() {
        if (this._pollInterval) {
            clearInterval(this._pollInterval);
            this._pollInterval = undefined;
            this._log('Stopped polling');
        }
    }

    private async _pollBuilds() {
        for (const [key, watched] of this._watchedBuilds.entries()) {
            watched.pollCount++;

            // Stop watching if exceeded max polls
            if (watched.pollCount > this._maxPollCount) {
                this._log(`Max poll count reached for ${key}, stopping watch`);
                this._watchedBuilds.delete(key);
                continue;
            }

            try {
                const jobs = await this._cli.listJobs(watched.appId, watched.branch);
                const latestJob = jobs[0];

                if (!latestJob) continue;

                // Check if this is a new job we haven't seen
                if (watched.jobId === '' || watched.jobId !== latestJob.jobId) {
                    watched.jobId = latestJob.jobId;
                    watched.lastStatus = latestJob.status;

                    if (latestJob.status === 'PENDING' || latestJob.status === 'RUNNING') {
                        this._showBuildStartedNotification(watched.appId, watched.branch, latestJob.jobId);
                    }
                }

                // Check if status changed
                if (latestJob.status !== watched.lastStatus) {
                    const oldStatus = watched.lastStatus;
                    watched.lastStatus = latestJob.status;

                    this._log(`Build status changed: ${oldStatus} -> ${latestJob.status}`);

                    // Handle completed builds
                    if (latestJob.status === 'SUCCEED') {
                        await this._handleBuildSuccess(watched, latestJob);
                        this._watchedBuilds.delete(key);
                    } else if (latestJob.status === 'FAILED') {
                        await this._handleBuildFailure(watched, latestJob);
                        this._watchedBuilds.delete(key);
                    } else if (latestJob.status === 'CANCELLED') {
                        this._showBuildCancelledNotification(watched, latestJob);
                        this._watchedBuilds.delete(key);
                    }
                }

            } catch (err: any) {
                this._log(`Error polling ${key}: ${err.message}`);
            }
        }

        this._updateStatusBar();

        if (this._watchedBuilds.size === 0) {
            this._stopPolling();
        }
    }

    private async _handleBuildSuccess(watched: WatchedBuild, job: AmplifyJob) {
        const duration = this._calculateDuration(job);
        
        const notification: BuildNotification = {
            appId: watched.appId,
            branch: watched.branch,
            jobId: job.jobId,
            status: 'SUCCEED',
            duration
        };

        this._onBuildStatusChanged.fire(notification);

        const durationStr = duration ? ` in ${this._formatDuration(duration)}` : '';
        
        const action = await vscode.window.showInformationMessage(
            `✅ Build #${job.jobId} succeeded${durationStr}`,
            'View in Console',
            'Dismiss'
        );

        if (action === 'View in Console') {
            this._openInConsole(watched.appId, watched.branch, job.jobId);
        }
    }

    private async _handleBuildFailure(watched: WatchedBuild, job: AmplifyJob) {
        const duration = this._calculateDuration(job);
        
        // Auto-diagnose the failure
        let diagnosis: DiagnosisResult | undefined;
        try {
            this._log(`Auto-diagnosing failed build ${job.jobId}...`);
            diagnosis = await this._cli.diagnose(watched.appId, watched.branch, job.jobId);
        } catch (err: any) {
            this._log(`Diagnosis failed: ${err.message}`);
        }

        const notification: BuildNotification = {
            appId: watched.appId,
            branch: watched.branch,
            jobId: job.jobId,
            status: 'FAILED',
            duration,
            diagnosis
        };

        this._onBuildStatusChanged.fire(notification);

        // Show detailed failure notification
        const issueCount = diagnosis?.issues?.length ?? 0;
        const issueText = issueCount > 0 
            ? ` | ${issueCount} issue${issueCount > 1 ? 's' : ''} found`
            : '';

        const durationStr = duration ? ` after ${this._formatDuration(duration)}` : '';

        const action = await vscode.window.showErrorMessage(
            `❌ Build #${job.jobId} failed${durationStr}${issueText}`,
            'View Diagnosis',
            'View Logs',
            'Open Console'
        );

        if (action === 'View Diagnosis') {
            // Show diagnosis in a new panel
            this._showDiagnosisPanel(watched, job, diagnosis);
        } else if (action === 'View Logs') {
            vscode.commands.executeCommand('amplify-monitor.diagnoseJob', watched.appId, watched.branch, job.jobId);
        } else if (action === 'Open Console') {
            this._openInConsole(watched.appId, watched.branch, job.jobId);
        }
    }

    private _showBuildStartedNotification(appId: string, branch: string, jobId: string) {
        vscode.window.showInformationMessage(
            `🚀 Build #${jobId} started on ${branch}`,
            'Watch Progress'
        ).then(action => {
            if (action === 'Watch Progress') {
                this._openInConsole(appId, branch, jobId);
            }
        });
    }

    private _showBuildCancelledNotification(watched: WatchedBuild, job: AmplifyJob) {
        vscode.window.showWarningMessage(
            `⚠️ Build #${job.jobId} was cancelled on ${watched.branch}`
        );
    }

    private _showDiagnosisPanel(watched: WatchedBuild, job: AmplifyJob, diagnosis?: DiagnosisResult) {
        const panel = vscode.window.createWebviewPanel(
            'buildDiagnosis',
            `Build #${job.jobId} Diagnosis`,
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        panel.webview.html = this._getDiagnosisHtml(watched, job, diagnosis);
    }

    private _getDiagnosisHtml(watched: WatchedBuild, job: AmplifyJob, diagnosis?: DiagnosisResult): string {
        const issues = diagnosis?.issues ?? [];
        
        const issuesHtml = issues.length > 0 
            ? issues.map(issue => `
                <div class="issue">
                    <div class="issue-header">
                        <span class="issue-icon">⚠️</span>
                        <strong>${this._escapeHtml(issue.pattern)}</strong>
                    </div>
                    <div class="issue-body">
                        <p class="root-cause"><strong>Root Cause:</strong> ${this._escapeHtml(issue.rootCause)}</p>
                        <div class="fixes">
                            <strong>Suggested Fixes:</strong>
                            <ul>
                                ${issue.suggestedFixes.map(fix => `<li>${this._escapeHtml(fix)}</li>`).join('')}
                            </ul>
                        </div>
                    </div>
                </div>
            `).join('')
            : '<p class="no-issues">No specific issues detected. Check the build logs for more details.</p>';

        return `<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
        }
        .header {
            margin-bottom: 24px;
            padding-bottom: 16px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .header h1 {
            margin: 0 0 8px 0;
            color: var(--vscode-errorForeground);
        }
        .meta {
            color: var(--vscode-descriptionForeground);
            font-size: 13px;
        }
        .issue {
            background: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 6px;
            padding: 16px;
            margin-bottom: 16px;
            border-left: 4px solid var(--vscode-errorForeground);
        }
        .issue-header {
            font-size: 14px;
            margin-bottom: 12px;
        }
        .issue-icon {
            margin-right: 8px;
        }
        .root-cause {
            margin: 0 0 12px 0;
            color: var(--vscode-descriptionForeground);
        }
        .fixes ul {
            margin: 8px 0 0 0;
            padding-left: 20px;
        }
        .fixes li {
            margin-bottom: 4px;
        }
        .no-issues {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }
        .actions {
            margin-top: 24px;
            display: flex;
            gap: 12px;
        }
        .btn {
            padding: 8px 16px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
        }
        .btn-primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .btn-secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>❌ Build Failed</h1>
        <div class="meta">
            <strong>App:</strong> ${watched.appId} |
            <strong>Branch:</strong> ${watched.branch} |
            <strong>Job:</strong> #${job.jobId}
        </div>
    </div>
    
    <h2>Issues Detected (${issues.length})</h2>
    ${issuesHtml}
    
    <div class="actions">
        <button class="btn btn-primary" onclick="viewLogs()">View Full Logs</button>
        <button class="btn btn-secondary" onclick="openConsole()">Open in AWS Console</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        function viewLogs() {
            vscode.postMessage({ command: 'viewLogs' });
        }
        function openConsole() {
            vscode.postMessage({ command: 'openConsole' });
        }
    </script>
</body>
</html>`;
    }

    private _updateStatusBar() {
        const watchCount = this._watchedBuilds.size;

        if (watchCount === 0) {
            this._statusBarItem.hide();
        } else {
            const runningBuilds = Array.from(this._watchedBuilds.values())
                .filter(w => w.lastStatus === 'RUNNING' || w.lastStatus === 'PENDING').length;

            this._statusBarItem.text = `$(sync~spin) ${runningBuilds}/${watchCount} builds`;
            this._statusBarItem.tooltip = `Watching ${watchCount} Amplify build(s)`;
            this._statusBarItem.show();
        }
    }

    private _calculateDuration(job: AmplifyJob): number | undefined {
        if (job.startTime && job.endTime) {
            return Math.round(
                (new Date(job.endTime).getTime() - new Date(job.startTime).getTime()) / 1000
            );
        }
        return undefined;
    }

    private _formatDuration(seconds: number): string {
        if (seconds < 60) return `${seconds}s`;
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}m ${secs}s`;
    }

    private _openInConsole(appId: string, branch: string, jobId: string) {
        const region = vscode.workspace.getConfiguration('amplifyMonitor').get<string>('defaultRegion') || 'us-east-1';
        const url = `https://${region}.console.aws.amazon.com/amplify/home?region=${region}#/${appId}/${branch}/${jobId}`;
        vscode.env.openExternal(vscode.Uri.parse(url));
    }

    private _escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    private _log(message: string) {
        const timestamp = new Date().toISOString();
        this._outputChannel.appendLine(`[${timestamp}] ${message}`);
    }

    public showOutput() {
        this._outputChannel.show();
    }

    public dispose() {
        this._stopPolling();
        this._statusBarItem.dispose();
        this._outputChannel.dispose();
        this._onBuildStatusChanged.dispose();
        this._disposables.forEach(d => d.dispose());
    }
}
