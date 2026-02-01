import * as vscode from 'vscode';
import { AmplifyMonitorCli, AmplifyApp, AmplifyJob } from '../cli';

interface QueuedBuild {
    app: {
        appId: string;
        name: string;
        region?: string;
    };
    branch: string;
    job: AmplifyJob;
    position?: number;
}

export class BuildQueuePanel {
    public static currentPanel: BuildQueuePanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _cli: AmplifyMonitorCli;
    private _refreshInterval: NodeJS.Timeout | undefined;

    public static createOrShow(extensionUri: vscode.Uri, cli: AmplifyMonitorCli) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (BuildQueuePanel.currentPanel) {
            BuildQueuePanel.currentPanel._panel.reveal(column);
            BuildQueuePanel.currentPanel._update();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'amplifyBuildQueue',
            'Build Queue',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            }
        );

        BuildQueuePanel.currentPanel = new BuildQueuePanel(panel, extensionUri, cli);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, cli: AmplifyMonitorCli) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._cli = cli;

        this._update();

        // Auto-refresh every 15 seconds
        this._refreshInterval = setInterval(() => this._update(), 15000);

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'refresh':
                        await this._update();
                        break;
                    case 'stopBuild':
                        await this._stopBuild(message.appId, message.branch, message.jobId, message.region);
                        break;
                    case 'openConsole':
                        vscode.env.openExternal(vscode.Uri.parse(message.url));
                        break;
                    case 'diagnose':
                        vscode.commands.executeCommand('amplify-monitor.diagnoseJob', 
                            message.appId, message.branch, message.jobId);
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    public dispose() {
        BuildQueuePanel.currentPanel = undefined;
        
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

    private async _stopBuild(appId: string, branch: string, jobId: string, region?: string): Promise<void> {
        try {
            await this._cli.stopBuild(appId, branch, jobId, region);
            vscode.window.showInformationMessage(`Stopped build #${jobId}`);
            await this._update();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to stop build: ${error}`);
        }
    }

    private async _update() {
        this._panel.webview.html = this._getLoadingHtml();

        try {
            const queueData = await this._fetchQueueData();
            this._panel.webview.html = this._getHtmlForWebview(queueData);
        } catch (error) {
            this._panel.webview.html = this._getErrorHtml(error instanceof Error ? error.message : 'Unknown error');
        }
    }

    private async _fetchQueueData(): Promise<{
        running: QueuedBuild[];
        pending: QueuedBuild[];
        recent: QueuedBuild[];
    }> {
        const running: QueuedBuild[] = [];
        const pending: QueuedBuild[] = [];
        const recent: QueuedBuild[] = [];

        try {
            const apps = await this._cli.listApps();
            if (!apps || apps.length === 0) {
                return { running, pending, recent };
            }

            // Fetch jobs for all apps (limit to first 5 apps to avoid timeout)
            for (const app of apps.slice(0, 5)) {
                try {
                    const branches = await this._cli.listBranches(app.appId, app.region);
                    if (!branches) continue;

                    for (const branch of branches.slice(0, 3)) { // Limit branches too
                        try {
                            const jobs = await this._cli.listJobs(app.appId, branch.branchName, app.region);
                            if (!jobs || jobs.length === 0) continue;

                            for (const job of jobs.slice(0, 5)) { // Get recent 5 jobs
                                const queuedBuild: QueuedBuild = {
                                    app: {
                                        appId: app.appId,
                                        name: app.name,
                                        region: app.region
                                    },
                                    branch: branch.branchName,
                                    job
                                };

                                if (job.status === 'RUNNING') {
                                    running.push(queuedBuild);
                                } else if (job.status === 'PENDING' || job.status === 'PROVISIONING') {
                                    pending.push(queuedBuild);
                                } else if (recent.length < 10) {
                                    recent.push(queuedBuild);
                                }
                            }
                        } catch {
                            // Skip branches that fail
                        }
                    }
                } catch {
                    // Skip apps that fail
                }
            }

            // Sort pending by position (newer jobs come later)
            pending.forEach((build, index) => {
                build.position = index + 1;
            });

        } catch (error) {
            console.error('Failed to fetch queue data:', error);
        }

        return { running, pending, recent };
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
            <p>Loading build queue...</p>
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

    private _getHtmlForWebview(data: { running: QueuedBuild[]; pending: QueuedBuild[]; recent: QueuedBuild[] }): string {
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
                h1 { font-size: 1.5em; margin-bottom: 5px; display: flex; align-items: center; gap: 10px; }
                h2 { font-size: 1.1em; margin-top: 25px; color: var(--vscode-textLink-foreground); }
                
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
                    gap: 20px;
                    margin: 20px 0;
                }
                .summary-card {
                    background: var(--vscode-editor-inactiveSelectionBackground);
                    padding: 15px 25px;
                    border-radius: 8px;
                    text-align: center;
                }
                .summary-card .number { 
                    font-size: 2em; 
                    font-weight: bold;
                }
                .summary-card .label { 
                    font-size: 0.85em; 
                    color: var(--vscode-descriptionForeground);
                    margin-top: 5px;
                }
                .summary-card.running .number { color: #0969da; }
                .summary-card.pending .number { color: #bf8700; }

                .build-list {
                    list-style: none;
                    padding: 0;
                    margin: 0;
                }
                .build-item {
                    background: var(--vscode-editor-inactiveSelectionBackground);
                    padding: 15px;
                    margin-bottom: 10px;
                    border-radius: 8px;
                    display: flex;
                    align-items: center;
                    gap: 15px;
                }
                .build-item:hover {
                    background: var(--vscode-list-hoverBackground);
                }

                .status-indicator {
                    width: 12px;
                    height: 12px;
                    border-radius: 50%;
                    flex-shrink: 0;
                }
                .status-RUNNING { 
                    background: #0969da; 
                    animation: pulse 1.5s infinite;
                }
                .status-PENDING, .status-PROVISIONING { background: #bf8700; }
                .status-SUCCEED { background: #2ea043; }
                .status-FAILED { background: #cf222e; }

                @keyframes pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.5; }
                }

                .build-info {
                    flex: 1;
                }
                .build-title {
                    font-weight: 600;
                    margin-bottom: 4px;
                }
                .build-meta {
                    font-size: 0.85em;
                    color: var(--vscode-descriptionForeground);
                }

                .build-actions {
                    display: flex;
                    gap: 8px;
                }
                .action-btn {
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    border: none;
                    padding: 4px 10px;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 0.8em;
                }
                .action-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
                .action-btn.stop { 
                    background: var(--vscode-inputValidation-errorBackground);
                    color: var(--vscode-errorForeground);
                }

                .queue-position {
                    background: var(--vscode-badge-background);
                    color: var(--vscode-badge-foreground);
                    padding: 2px 8px;
                    border-radius: 10px;
                    font-size: 0.8em;
                    font-weight: 600;
                }

                .empty-state {
                    text-align: center;
                    padding: 30px;
                    color: var(--vscode-descriptionForeground);
                }
                .empty-state .icon { font-size: 2em; margin-bottom: 10px; }

                .progress-bar {
                    height: 4px;
                    background: var(--vscode-progressBar-background);
                    border-radius: 2px;
                    overflow: hidden;
                    margin-top: 8px;
                }
                .progress-bar .fill {
                    height: 100%;
                    background: #0969da;
                    animation: progress 2s ease-in-out infinite;
                }
                @keyframes progress {
                    0% { width: 0%; }
                    50% { width: 70%; }
                    100% { width: 100%; }
                }
            </style>
        </head>
        <body>
            <h1>
                📋 Build Queue
                <button class="refresh-btn" onclick="refresh()">🔄 Refresh</button>
            </h1>

            <div class="summary">
                <div class="summary-card running">
                    <div class="number">${data.running.length}</div>
                    <div class="label">Running</div>
                </div>
                <div class="summary-card pending">
                    <div class="number">${data.pending.length}</div>
                    <div class="label">Pending</div>
                </div>
            </div>

            ${data.running.length > 0 ? `
                <h2>🔄 Running Builds</h2>
                <ul class="build-list">
                    ${data.running.map(build => this._renderBuildItem(build, true)).join('')}
                </ul>
            ` : ''}

            ${data.pending.length > 0 ? `
                <h2>⏳ Pending Builds</h2>
                <ul class="build-list">
                    ${data.pending.map(build => this._renderBuildItem(build, false)).join('')}
                </ul>
            ` : ''}

            ${data.running.length === 0 && data.pending.length === 0 ? `
                <div class="empty-state">
                    <div class="icon">✅</div>
                    <p>No builds in queue</p>
                </div>
            ` : ''}

            ${data.recent.length > 0 ? `
                <h2>📜 Recent Builds</h2>
                <ul class="build-list">
                    ${data.recent.map(build => this._renderBuildItem(build, false, true)).join('')}
                </ul>
            ` : ''}

            <script>
                const vscode = acquireVsCodeApi();
                
                function refresh() {
                    vscode.postMessage({ command: 'refresh' });
                }
                
                function stopBuild(appId, branch, jobId, region) {
                    if (confirm('Stop this build?')) {
                        vscode.postMessage({ command: 'stopBuild', appId, branch, jobId, region });
                    }
                }
                
                function openConsole(url) {
                    vscode.postMessage({ command: 'openConsole', url });
                }

                function diagnose(appId, branch, jobId) {
                    vscode.postMessage({ command: 'diagnose', appId, branch, jobId });
                }
            </script>
        </body>
        </html>`;
    }

    private _renderBuildItem(build: QueuedBuild, showStop: boolean, showDiagnose = false): string {
        const consoleUrl = `https://console.aws.amazon.com/amplify/home#/${build.app.appId}/${build.branch}/${build.job.jobId}`;
        const startTime = build.job.startTime ? new Date(build.job.startTime).toLocaleString() : 'N/A';
        
        return `
            <li class="build-item">
                <div class="status-indicator status-${build.job.status}"></div>
                <div class="build-info">
                    <div class="build-title">
                        ${build.app.name} / ${build.branch}
                        ${build.position ? `<span class="queue-position">#${build.position} in queue</span>` : ''}
                    </div>
                    <div class="build-meta">
                        Job #${build.job.jobId} • ${build.job.status} • ${startTime}
                        ${build.app.region ? `• ${build.app.region}` : ''}
                    </div>
                    ${build.job.status === 'RUNNING' ? '<div class="progress-bar"><div class="fill"></div></div>' : ''}
                </div>
                <div class="build-actions">
                    <button class="action-btn" onclick="openConsole('${consoleUrl}')">🔗 Console</button>
                    ${showStop ? `<button class="action-btn stop" onclick="stopBuild('${build.app.appId}', '${build.branch}', '${build.job.jobId}', '${build.app.region || ''}')">⏹️ Stop</button>` : ''}
                    ${showDiagnose && build.job.status === 'FAILED' ? `<button class="action-btn" onclick="diagnose('${build.app.appId}', '${build.branch}', '${build.job.jobId}')">🔍 Diagnose</button>` : ''}
                </div>
            </li>
        `;
    }
}
