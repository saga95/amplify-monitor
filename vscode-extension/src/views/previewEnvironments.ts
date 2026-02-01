import * as vscode from 'vscode';
import { AmplifyMonitorCli, AmplifyApp, AmplifyBranch, AmplifyJob } from '../cli';

interface PreviewEnvironment {
    app: AmplifyApp;
    branch: AmplifyBranch;
    prNumber?: string;
    status: string;
    url: string;
    lastDeploy?: string;
    latestJob?: AmplifyJob;
}

export class PreviewEnvironmentsPanel {
    public static currentPanel: PreviewEnvironmentsPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _cli: AmplifyMonitorCli;
    private _refreshInterval: NodeJS.Timeout | undefined;

    public static createOrShow(extensionUri: vscode.Uri, cli: AmplifyMonitorCli) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (PreviewEnvironmentsPanel.currentPanel) {
            PreviewEnvironmentsPanel.currentPanel._panel.reveal(column);
            PreviewEnvironmentsPanel.currentPanel._update();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'amplifyPreviewEnvs',
            'PR Preview Environments',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            }
        );

        PreviewEnvironmentsPanel.currentPanel = new PreviewEnvironmentsPanel(panel, extensionUri, cli);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, cli: AmplifyMonitorCli) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._cli = cli;

        this._update();

        // Auto-refresh every 30 seconds
        this._refreshInterval = setInterval(() => this._update(), 30000);

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'refresh':
                        await this._update();
                        break;
                    case 'openUrl':
                        vscode.env.openExternal(vscode.Uri.parse(message.url));
                        break;
                    case 'openConsole':
                        vscode.env.openExternal(vscode.Uri.parse(message.url));
                        break;
                    case 'deleteBranch':
                        await this._deleteBranch(message.appId, message.branch, message.region);
                        break;
                    case 'diagnose':
                        vscode.commands.executeCommand('amplify-monitor.diagnoseJob', 
                            message.appId, message.branch, message.jobId);
                        break;
                    case 'triggerBuild':
                        await this._triggerBuild(message.appId, message.branch, message.region);
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    public dispose() {
        PreviewEnvironmentsPanel.currentPanel = undefined;
        
        if (this._refreshInterval) {
            clearInterval(this._refreshInterval);
        }

        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) {
                d.dispose();
            }
        }
    }

    private async _deleteBranch(appId: string, branch: string, region?: string): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to delete the preview environment for "${branch}"? This action cannot be undone.`,
            { modal: true },
            'Delete'
        );

        if (confirm !== 'Delete') {
            return;
        }

        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Deleting preview environment: ${branch}...`,
                cancellable: false
            }, async () => {
                // Note: This would require adding a deleteBranch command to the CLI
                // For now, we'll show instructions on how to delete via console
                vscode.window.showInformationMessage(
                    `To delete this preview environment, go to the AWS Console and delete the branch "${branch}" from your Amplify app.`
                );
            });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to delete: ${error}`);
        }
    }

    private async _triggerBuild(appId: string, branch: string, region?: string): Promise<void> {
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Triggering build for ${branch}...`,
                cancellable: false
            }, async () => {
                await this._cli.startBuild(appId, branch, region);
                vscode.window.showInformationMessage(`Build triggered for ${branch}`);
                await this._update();
            });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to trigger build: ${error}`);
        }
    }

    private async _update() {
        this._panel.webview.html = this._getLoadingHtml();

        try {
            const data = await this._fetchPreviewEnvironments();
            this._panel.webview.html = this._getHtmlForWebview(data);
        } catch (error) {
            this._panel.webview.html = this._getErrorHtml(error instanceof Error ? error.message : 'Unknown error');
        }
    }

    private async _fetchPreviewEnvironments(): Promise<{
        active: PreviewEnvironment[];
        stale: PreviewEnvironment[];
        failed: PreviewEnvironment[];
    }> {
        const active: PreviewEnvironment[] = [];
        const stale: PreviewEnvironment[] = [];
        const failed: PreviewEnvironment[] = [];

        try {
            const apps = await this._cli.listApps();
            if (!apps || apps.length === 0) {
                return { active, stale, failed };
            }

            const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);

            for (const app of apps.slice(0, 5)) {
                try {
                    const branches = await this._cli.listBranches(app.appId, app.region);
                    if (!branches) continue;

                    for (const branch of branches) {
                        // Check if this looks like a PR preview branch
                        const isPRBranch = this._isPRBranch(branch.branchName);
                        if (!isPRBranch) continue;

                        try {
                            const jobs = await this._cli.listJobs(app.appId, branch.branchName, app.region);
                            const latestJob = jobs && jobs.length > 0 ? jobs[0] : undefined;

                            const previewUrl = `https://${branch.branchName}.${app.defaultDomain}`;
                            const prNumber = this._extractPRNumber(branch.branchName);
                            
                            const env: PreviewEnvironment = {
                                app,
                                branch,
                                prNumber,
                                status: latestJob?.status || 'UNKNOWN',
                                url: previewUrl,
                                lastDeploy: latestJob?.startTime,
                                latestJob
                            };

                            // Categorize
                            if (latestJob?.status === 'FAILED') {
                                failed.push(env);
                            } else if (latestJob?.startTime && new Date(latestJob.startTime).getTime() < thirtyDaysAgo) {
                                stale.push(env);
                            } else {
                                active.push(env);
                            }
                        } catch {
                            // Skip branches that fail to fetch jobs
                        }
                    }
                } catch {
                    // Skip apps that fail
                }
            }
        } catch (error) {
            console.error('Failed to fetch preview environments:', error);
        }

        // Sort by last deploy date (newest first)
        const sortByDate = (a: PreviewEnvironment, b: PreviewEnvironment) => {
            if (!a.lastDeploy) return 1;
            if (!b.lastDeploy) return -1;
            return new Date(b.lastDeploy).getTime() - new Date(a.lastDeploy).getTime();
        };

        active.sort(sortByDate);
        stale.sort(sortByDate);
        failed.sort(sortByDate);

        return { active, stale, failed };
    }

    private _isPRBranch(branchName: string): boolean {
        // Common PR branch patterns
        const patterns = [
            /^pr-?\d+/i,                    // pr-123, pr123
            /^pull[-_]?\d+/i,               // pull-123, pull_123
            /^feature\//i,                  // feature/xxx
            /^preview\//i,                  // preview/xxx
            /^dependabot\//i,               // dependabot/npm_and_yarn/xxx
            /^renovate\//i,                 // renovate/xxx
            /^hotfix\//i,                   // hotfix/xxx
            /^bugfix\//i,                   // bugfix/xxx
        ];
        
        // Exclude common main branches
        const mainBranches = ['main', 'master', 'develop', 'staging', 'production', 'prod'];
        if (mainBranches.includes(branchName.toLowerCase())) {
            return false;
        }

        return patterns.some(p => p.test(branchName));
    }

    private _extractPRNumber(branchName: string): string | undefined {
        const match = branchName.match(/pr-?(\d+)|pull[-_]?(\d+)/i);
        if (match) {
            return match[1] || match[2];
        }
        return undefined;
    }

    private _getLoadingHtml(): string {
        return `<!DOCTYPE html>
        <html>
        <head>
            <style>
                body { 
                    font-family: var(--vscode-font-family); 
                    padding: 20px; 
                    display: flex; 
                    justify-content: center; 
                    align-items: center; 
                    height: 80vh;
                    flex-direction: column;
                }
                .spinner { 
                    width: 50px; 
                    height: 50px; 
                    border: 3px solid var(--vscode-foreground); 
                    border-top-color: transparent; 
                    border-radius: 50%; 
                    animation: spin 1s linear infinite; 
                }
                @keyframes spin { to { transform: rotate(360deg); } }
                p { margin-top: 15px; color: var(--vscode-descriptionForeground); }
            </style>
        </head>
        <body>
            <div class="spinner"></div>
            <p>Loading preview environments...</p>
        </body>
        </html>`;
    }

    private _getErrorHtml(error: string): string {
        return `<!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: var(--vscode-font-family); padding: 20px; }
                .error { 
                    color: var(--vscode-errorForeground); 
                    background: var(--vscode-inputValidation-errorBackground); 
                    padding: 15px; 
                    border-radius: 4px; 
                }
            </style>
        </head>
        <body>
            <div class="error">⚠️ ${error}</div>
        </body>
        </html>`;
    }

    private _getHtmlForWebview(data: { active: PreviewEnvironment[]; stale: PreviewEnvironment[]; failed: PreviewEnvironment[] }): string {
        const totalCount = data.active.length + data.stale.length + data.failed.length;

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
                h1 { 
                    font-size: 1.5em; 
                    margin-bottom: 5px; 
                    display: flex; 
                    align-items: center; 
                    gap: 10px; 
                }
                h2 { 
                    font-size: 1.1em; 
                    margin-top: 25px; 
                    color: var(--vscode-textLink-foreground);
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                
                .refresh-btn {
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    border: none;
                    padding: 6px 12px;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 0.9em;
                }
                .refresh-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }

                .summary {
                    display: flex;
                    gap: 15px;
                    margin: 20px 0;
                }
                .summary-card {
                    background: var(--vscode-editor-inactiveSelectionBackground);
                    padding: 12px 20px;
                    border-radius: 8px;
                    text-align: center;
                }
                .summary-card .number { 
                    font-size: 1.8em; 
                    font-weight: bold;
                }
                .summary-card .label { 
                    font-size: 0.8em; 
                    color: var(--vscode-descriptionForeground);
                    margin-top: 4px;
                }
                .summary-card.active .number { color: #2ea043; }
                .summary-card.failed .number { color: #cf222e; }
                .summary-card.stale .number { color: #bf8700; }

                .info-box {
                    background: var(--vscode-textBlockQuote-background);
                    border-left: 3px solid var(--vscode-textLink-foreground);
                    padding: 12px 15px;
                    margin: 15px 0;
                    font-size: 0.9em;
                }

                .env-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
                    gap: 15px;
                    margin-top: 15px;
                }

                .env-card {
                    background: var(--vscode-editor-inactiveSelectionBackground);
                    border-radius: 8px;
                    padding: 15px;
                    transition: transform 0.2s;
                }
                .env-card:hover {
                    transform: translateY(-2px);
                }
                .env-card.failed {
                    border-left: 4px solid #cf222e;
                }
                .env-card.stale {
                    border-left: 4px solid #bf8700;
                    opacity: 0.8;
                }

                .env-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: flex-start;
                    margin-bottom: 10px;
                }
                .env-title {
                    font-weight: 600;
                }
                .env-app {
                    font-size: 0.8em;
                    color: var(--vscode-descriptionForeground);
                }

                .status-badge {
                    padding: 3px 8px;
                    border-radius: 12px;
                    font-size: 0.7em;
                    font-weight: 600;
                }
                .status-SUCCEED { background: #2ea043; color: white; }
                .status-FAILED { background: #cf222e; color: white; }
                .status-RUNNING { background: #0969da; color: white; }
                .status-PENDING { background: #bf8700; color: white; }

                .env-meta {
                    font-size: 0.85em;
                    color: var(--vscode-descriptionForeground);
                    margin-bottom: 12px;
                }
                .env-meta div {
                    margin-bottom: 4px;
                }
                .env-url {
                    word-break: break-all;
                    color: var(--vscode-textLink-foreground);
                }

                .env-actions {
                    display: flex;
                    gap: 8px;
                    flex-wrap: wrap;
                }
                .action-btn {
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    border: none;
                    padding: 5px 10px;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 0.8em;
                }
                .action-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
                .action-btn.primary {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                }
                .action-btn.danger {
                    background: var(--vscode-inputValidation-errorBackground);
                    color: var(--vscode-errorForeground);
                }

                .empty-state {
                    text-align: center;
                    padding: 40px;
                    color: var(--vscode-descriptionForeground);
                }
                .empty-state .icon { font-size: 3em; margin-bottom: 15px; }

                .count-badge {
                    background: var(--vscode-badge-background);
                    color: var(--vscode-badge-foreground);
                    padding: 2px 8px;
                    border-radius: 10px;
                    font-size: 0.8em;
                }
            </style>
        </head>
        <body>
            <h1>
                🔀 PR Preview Environments
                <button class="refresh-btn" onclick="refresh()">🔄 Refresh</button>
            </h1>

            <div class="summary">
                <div class="summary-card">
                    <div class="number">${totalCount}</div>
                    <div class="label">Total Previews</div>
                </div>
                <div class="summary-card active">
                    <div class="number">${data.active.length}</div>
                    <div class="label">Active</div>
                </div>
                <div class="summary-card failed">
                    <div class="number">${data.failed.length}</div>
                    <div class="label">Failed</div>
                </div>
                <div class="summary-card stale">
                    <div class="number">${data.stale.length}</div>
                    <div class="label">Stale (30+ days)</div>
                </div>
            </div>

            <div class="info-box">
                💡 Preview environments are automatically detected from branches matching PR patterns 
                (e.g., <code>pr-123</code>, <code>feature/*</code>, <code>dependabot/*</code>).
            </div>

            ${data.failed.length > 0 ? `
                <h2>❌ Failed <span class="count-badge">${data.failed.length}</span></h2>
                <div class="env-grid">
                    ${data.failed.map(env => this._renderEnvCard(env, 'failed')).join('')}
                </div>
            ` : ''}

            ${data.active.length > 0 ? `
                <h2>✅ Active <span class="count-badge">${data.active.length}</span></h2>
                <div class="env-grid">
                    ${data.active.map(env => this._renderEnvCard(env, 'active')).join('')}
                </div>
            ` : ''}

            ${data.stale.length > 0 ? `
                <h2>⏰ Stale (30+ days old) <span class="count-badge">${data.stale.length}</span></h2>
                <div class="env-grid">
                    ${data.stale.map(env => this._renderEnvCard(env, 'stale')).join('')}
                </div>
            ` : ''}

            ${totalCount === 0 ? `
                <div class="empty-state">
                    <div class="icon">🔀</div>
                    <p>No preview environments found.</p>
                    <p>Preview branches are automatically created when you enable PR previews in Amplify Console.</p>
                </div>
            ` : ''}

            <script>
                const vscode = acquireVsCodeApi();
                
                function refresh() {
                    vscode.postMessage({ command: 'refresh' });
                }
                
                function openUrl(url) {
                    vscode.postMessage({ command: 'openUrl', url });
                }

                function openConsole(url) {
                    vscode.postMessage({ command: 'openConsole', url });
                }
                
                function deleteBranch(appId, branch, region) {
                    vscode.postMessage({ command: 'deleteBranch', appId, branch, region });
                }

                function diagnose(appId, branch, jobId) {
                    vscode.postMessage({ command: 'diagnose', appId, branch, jobId });
                }

                function triggerBuild(appId, branch, region) {
                    vscode.postMessage({ command: 'triggerBuild', appId, branch, region });
                }
            </script>
        </body>
        </html>`;
    }

    private _renderEnvCard(env: PreviewEnvironment, type: 'active' | 'failed' | 'stale'): string {
        const consoleUrl = `https://console.aws.amazon.com/amplify/home#/${env.app.appId}/${env.branch.branchName}`;
        const prLabel = env.prNumber ? `PR #${env.prNumber}` : env.branch.branchName;
        const lastDeploy = env.lastDeploy ? new Date(env.lastDeploy).toLocaleDateString() : 'N/A';

        return `
            <div class="env-card ${type}">
                <div class="env-header">
                    <div>
                        <div class="env-title">🌿 ${prLabel}</div>
                        <div class="env-app">📱 ${env.app.name}</div>
                    </div>
                    <span class="status-badge status-${env.status}">${env.status}</span>
                </div>
                
                <div class="env-meta">
                    <div class="env-url">🔗 <a href="#" onclick="openUrl('${env.url}')">${env.url}</a></div>
                    <div>📅 Last deploy: ${lastDeploy}</div>
                    ${env.latestJob ? `<div>🆔 Job #${env.latestJob.jobId}</div>` : ''}
                </div>

                <div class="env-actions">
                    <button class="action-btn primary" onclick="openUrl('${env.url}')">🌐 Open</button>
                    <button class="action-btn" onclick="openConsole('${consoleUrl}')">📊 Console</button>
                    <button class="action-btn" onclick="triggerBuild('${env.app.appId}', '${env.branch.branchName}', '${env.app.region || ''}')">🔄 Rebuild</button>
                    ${type === 'failed' && env.latestJob ? `
                        <button class="action-btn" onclick="diagnose('${env.app.appId}', '${env.branch.branchName}', '${env.latestJob.jobId}')">🔍 Diagnose</button>
                    ` : ''}
                    ${type === 'stale' ? `
                        <button class="action-btn danger" onclick="deleteBranch('${env.app.appId}', '${env.branch.branchName}', '${env.app.region || ''}')">🗑️ Delete</button>
                    ` : ''}
                </div>
            </div>
        `;
    }
}
