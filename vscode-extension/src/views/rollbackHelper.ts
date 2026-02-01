import * as vscode from 'vscode';
import { AmplifyMonitorCli, AmplifyApp, AmplifyBranch, AmplifyJob } from '../cli';

interface DeploymentInfo {
    app: AmplifyApp;
    branch: AmplifyBranch;
    jobs: AmplifyJob[];
    currentJob?: AmplifyJob;
    lastSuccessfulJob?: AmplifyJob;
}

export class RollbackHelperPanel {
    public static currentPanel: RollbackHelperPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _cli: AmplifyMonitorCli;

    public static createOrShow(extensionUri: vscode.Uri, cli: AmplifyMonitorCli) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (RollbackHelperPanel.currentPanel) {
            RollbackHelperPanel.currentPanel._panel.reveal(column);
            RollbackHelperPanel.currentPanel._update();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'amplifyRollback',
            'Rollback Helper',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            }
        );

        RollbackHelperPanel.currentPanel = new RollbackHelperPanel(panel, extensionUri, cli);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, cli: AmplifyMonitorCli) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._cli = cli;

        this._update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'refresh':
                        await this._update();
                        break;
                    case 'selectBranch':
                        await this._loadBranchDetails(message.appId, message.branch, message.region);
                        break;
                    case 'rollback':
                        await this._performRollback(message.appId, message.branch, message.jobId, message.region);
                        break;
                    case 'openConsole':
                        vscode.env.openExternal(vscode.Uri.parse(message.url));
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    public dispose() {
        RollbackHelperPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) {
                d.dispose();
            }
        }
    }

    private async _performRollback(appId: string, branch: string, jobId: string, region?: string): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to redeploy Job #${jobId} to ${branch}? This will trigger a new deployment.`,
            { modal: true },
            'Redeploy'
        );

        if (confirm !== 'Redeploy') {
            return;
        }

        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Rolling back ${branch}...`,
                cancellable: false
            }, async () => {
                // Start a new job for the branch (redeploy)
                await this._cli.startBuild(appId, branch, region);
                vscode.window.showInformationMessage(`Started rollback deployment for ${branch}`);
                await this._update();
            });
        } catch (error) {
            vscode.window.showErrorMessage(`Rollback failed: ${error}`);
        }
    }

    private async _loadBranchDetails(appId: string, branch: string, region?: string): Promise<void> {
        this._panel.webview.html = this._getLoadingHtml();

        try {
            const jobs = await this._cli.listJobs(appId, branch, region);
            const successfulJobs = jobs?.filter(j => j.status === 'SUCCEED') || [];
            
            this._panel.webview.html = this._getBranchDetailsHtml(appId, branch, jobs || [], successfulJobs, region);
        } catch (error) {
            this._panel.webview.html = this._getErrorHtml(error instanceof Error ? error.message : 'Unknown error');
        }
    }

    private async _update() {
        this._panel.webview.html = this._getLoadingHtml();

        try {
            const data = await this._fetchDeploymentData();
            this._panel.webview.html = this._getHtmlForWebview(data);
        } catch (error) {
            this._panel.webview.html = this._getErrorHtml(error instanceof Error ? error.message : 'Unknown error');
        }
    }

    private async _fetchDeploymentData(): Promise<DeploymentInfo[]> {
        const deployments: DeploymentInfo[] = [];

        try {
            const apps = await this._cli.listApps();
            if (!apps || apps.length === 0) {
                return deployments;
            }

            // Fetch data for first 5 apps
            for (const app of apps.slice(0, 5)) {
                try {
                    const branches = await this._cli.listBranches(app.appId, app.region);
                    if (!branches) continue;

                    for (const branch of branches.slice(0, 5)) {
                        try {
                            const jobs = await this._cli.listJobs(app.appId, branch.branchName, app.region);
                            if (!jobs || jobs.length === 0) continue;

                            const currentJob = jobs[0];
                            const lastSuccessful = jobs.find(j => j.status === 'SUCCEED');

                            deployments.push({
                                app,
                                branch,
                                jobs,
                                currentJob,
                                lastSuccessfulJob: lastSuccessful
                            });
                        } catch {
                            // Skip branches that fail
                        }
                    }
                } catch {
                    // Skip apps that fail
                }
            }
        } catch (error) {
            console.error('Failed to fetch deployment data:', error);
        }

        return deployments;
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
            <p>Loading deployment data...</p>
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

    private _getBranchDetailsHtml(appId: string, branch: string, allJobs: AmplifyJob[], successfulJobs: AmplifyJob[], region?: string): string {
        return `<!DOCTYPE html>
        <html>
        <head>
            <style>
                ${this._getStyles()}
            </style>
        </head>
        <body>
            <h1>
                <button class="back-btn" onclick="goBack()">← Back</button>
                🔄 Rollback: ${branch}
            </h1>

            <div class="warning-box">
                ⚠️ <strong>Warning:</strong> Rolling back will trigger a new deployment using the selected job's configuration. 
                Make sure to verify the changes before proceeding.
            </div>

            ${successfulJobs.length === 0 ? `
                <div class="empty-state">
                    <div class="icon">📭</div>
                    <p>No successful deployments found for this branch.</p>
                </div>
            ` : `
                <h2>📜 Successful Deployments</h2>
                <p class="subtitle">Select a deployment to roll back to:</p>
                
                <div class="job-grid">
                    ${successfulJobs.map((job, index) => `
                        <div class="job-card ${index === 0 ? 'current' : ''}">
                            <div class="job-header">
                                <span class="job-id">Job #${job.jobId}</span>
                                ${index === 0 ? '<span class="badge current-badge">Current</span>' : ''}
                            </div>
                            <div class="job-meta">
                                <div>📅 ${job.startTime ? new Date(job.startTime).toLocaleString() : 'N/A'}</div>
                                <div>⏱️ ${this._calculateDuration(job.startTime, job.endTime)}</div>
                            </div>
                            ${index > 0 ? `
                                <button class="rollback-btn" onclick="rollback('${appId}', '${branch}', '${job.jobId}', '${region || ''}')">
                                    ↩️ Redeploy This Version
                                </button>
                            ` : `
                                <div class="current-label">This is the current deployment</div>
                            `}
                        </div>
                    `).join('')}
                </div>
            `}

            <h2>📋 All Jobs</h2>
            <table class="jobs-table">
                <thead>
                    <tr>
                        <th>Job ID</th>
                        <th>Status</th>
                        <th>Started</th>
                        <th>Duration</th>
                    </tr>
                </thead>
                <tbody>
                    ${allJobs.map(job => `
                        <tr class="status-${job.status}">
                            <td>#${job.jobId}</td>
                            <td>
                                <span class="status-badge status-${job.status}">${job.status}</span>
                            </td>
                            <td>${job.startTime ? new Date(job.startTime).toLocaleString() : 'N/A'}</td>
                            <td>${this._calculateDuration(job.startTime, job.endTime)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>

            <script>
                const vscode = acquireVsCodeApi();
                
                function goBack() {
                    vscode.postMessage({ command: 'refresh' });
                }
                
                function rollback(appId, branch, jobId, region) {
                    vscode.postMessage({ command: 'rollback', appId, branch, jobId, region });
                }
            </script>
        </body>
        </html>`;
    }

    private _getHtmlForWebview(data: DeploymentInfo[]): string {
        // Group by app
        const appGroups = new Map<string, DeploymentInfo[]>();
        data.forEach(d => {
            const key = d.app.appId;
            if (!appGroups.has(key)) {
                appGroups.set(key, []);
            }
            appGroups.get(key)!.push(d);
        });

        return `<!DOCTYPE html>
        <html>
        <head>
            <style>
                ${this._getStyles()}
            </style>
        </head>
        <body>
            <h1>
                ↩️ Rollback Helper
                <button class="refresh-btn" onclick="refresh()">🔄 Refresh</button>
            </h1>

            <p class="intro">
                View your deployments and quickly rollback to a previous successful version. 
                Select a branch to see available rollback options.
            </p>

            ${data.length === 0 ? `
                <div class="empty-state">
                    <div class="icon">📭</div>
                    <p>No deployments found. Make sure you have Amplify apps with active branches.</p>
                </div>
            ` : `
                ${Array.from(appGroups.entries()).map(([appId, deployments]) => `
                    <div class="app-section">
                        <h2>📱 ${deployments[0].app.name}</h2>
                        <div class="branch-grid">
                            ${deployments.map(d => this._renderBranchCard(d)).join('')}
                        </div>
                    </div>
                `).join('')}
            `}

            <script>
                const vscode = acquireVsCodeApi();
                
                function refresh() {
                    vscode.postMessage({ command: 'refresh' });
                }
                
                function selectBranch(appId, branch, region) {
                    vscode.postMessage({ command: 'selectBranch', appId, branch, region });
                }
                
                function openConsole(url) {
                    vscode.postMessage({ command: 'openConsole', url });
                }
            </script>
        </body>
        </html>`;
    }

    private _renderBranchCard(deployment: DeploymentInfo): string {
        const { app, branch, currentJob, lastSuccessfulJob } = deployment;
        const canRollback = lastSuccessfulJob && currentJob?.status === 'FAILED';
        const consoleUrl = `https://console.aws.amazon.com/amplify/home#/${app.appId}/${branch.branchName}`;

        return `
            <div class="branch-card ${canRollback ? 'can-rollback' : ''}">
                <div class="branch-header">
                    <span class="branch-name">🌿 ${branch.branchName}</span>
                    ${currentJob ? `
                        <span class="status-badge status-${currentJob.status}">${currentJob.status}</span>
                    ` : ''}
                </div>
                
                <div class="branch-info">
                    ${currentJob ? `
                        <div class="info-row">
                            <span class="label">Latest:</span>
                            <span>Job #${currentJob.jobId}</span>
                        </div>
                        <div class="info-row">
                            <span class="label">Time:</span>
                            <span>${currentJob.startTime ? new Date(currentJob.startTime).toLocaleDateString() : 'N/A'}</span>
                        </div>
                    ` : '<p>No jobs found</p>'}
                    
                    ${lastSuccessfulJob && lastSuccessfulJob.jobId !== currentJob?.jobId ? `
                        <div class="info-row last-success">
                            <span class="label">Last Success:</span>
                            <span>Job #${lastSuccessfulJob.jobId}</span>
                        </div>
                    ` : ''}
                </div>

                <div class="branch-actions">
                    <button class="action-btn" onclick="selectBranch('${app.appId}', '${branch.branchName}', '${app.region || ''}')">
                        ${canRollback ? '↩️ View Rollback Options' : '📋 View Jobs'}
                    </button>
                    <button class="action-btn secondary" onclick="openConsole('${consoleUrl}')">
                        🔗 Console
                    </button>
                </div>
            </div>
        `;
    }

    private _calculateDuration(startTime?: string, endTime?: string): string {
        if (!startTime) return 'N/A';
        
        const start = new Date(startTime);
        const end = endTime ? new Date(endTime) : new Date();
        const durationMs = end.getTime() - start.getTime();
        
        const minutes = Math.floor(durationMs / 60000);
        const seconds = Math.floor((durationMs % 60000) / 1000);
        
        if (minutes === 0) {
            return `${seconds}s`;
        }
        return `${minutes}m ${seconds}s`;
    }

    private _getStyles(): string {
        return `
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
                font-size: 1.2em; 
                margin-top: 25px; 
                color: var(--vscode-textLink-foreground); 
            }
            
            .intro, .subtitle {
                color: var(--vscode-descriptionForeground);
                margin-bottom: 20px;
            }

            .refresh-btn, .back-btn {
                background: var(--vscode-button-secondaryBackground);
                color: var(--vscode-button-secondaryForeground);
                border: none;
                padding: 6px 12px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 0.9em;
            }
            .refresh-btn:hover, .back-btn:hover { 
                background: var(--vscode-button-secondaryHoverBackground); 
            }

            .warning-box {
                background: var(--vscode-inputValidation-warningBackground);
                border: 1px solid var(--vscode-inputValidation-warningBorder);
                color: var(--vscode-inputValidation-warningForeground);
                padding: 12px 15px;
                border-radius: 6px;
                margin: 15px 0;
            }

            .app-section {
                margin-bottom: 30px;
            }

            .branch-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
                gap: 15px;
            }

            .branch-card {
                background: var(--vscode-editor-inactiveSelectionBackground);
                border-radius: 8px;
                padding: 15px;
                transition: transform 0.2s, box-shadow 0.2s;
            }
            .branch-card:hover {
                transform: translateY(-2px);
                box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            }
            .branch-card.can-rollback {
                border-left: 4px solid #bf8700;
            }

            .branch-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 12px;
            }
            .branch-name {
                font-weight: 600;
            }

            .status-badge {
                padding: 3px 8px;
                border-radius: 12px;
                font-size: 0.75em;
                font-weight: 600;
                text-transform: uppercase;
            }
            .status-SUCCEED { background: #2ea043; color: white; }
            .status-FAILED { background: #cf222e; color: white; }
            .status-RUNNING { background: #0969da; color: white; }
            .status-PENDING { background: #bf8700; color: white; }

            .branch-info {
                margin-bottom: 12px;
            }
            .info-row {
                display: flex;
                justify-content: space-between;
                font-size: 0.9em;
                margin-bottom: 4px;
            }
            .info-row .label {
                color: var(--vscode-descriptionForeground);
            }
            .info-row.last-success {
                color: #2ea043;
                font-weight: 500;
            }

            .branch-actions {
                display: flex;
                gap: 8px;
                margin-top: 12px;
            }

            .action-btn {
                flex: 1;
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                padding: 8px 12px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 0.85em;
            }
            .action-btn:hover { 
                background: var(--vscode-button-hoverBackground); 
            }
            .action-btn.secondary {
                background: var(--vscode-button-secondaryBackground);
                color: var(--vscode-button-secondaryForeground);
            }
            .action-btn.secondary:hover {
                background: var(--vscode-button-secondaryHoverBackground);
            }

            .empty-state {
                text-align: center;
                padding: 40px;
                color: var(--vscode-descriptionForeground);
            }
            .empty-state .icon { 
                font-size: 3em; 
                margin-bottom: 15px; 
            }

            /* Job details page */
            .job-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
                gap: 15px;
                margin-bottom: 30px;
            }

            .job-card {
                background: var(--vscode-editor-inactiveSelectionBackground);
                border-radius: 8px;
                padding: 15px;
            }
            .job-card.current {
                border: 2px solid #2ea043;
            }

            .job-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 10px;
            }
            .job-id {
                font-weight: 600;
                font-size: 1.1em;
            }
            .badge {
                padding: 2px 8px;
                border-radius: 10px;
                font-size: 0.75em;
            }
            .current-badge {
                background: #2ea043;
                color: white;
            }

            .job-meta {
                font-size: 0.85em;
                color: var(--vscode-descriptionForeground);
                margin-bottom: 12px;
            }
            .job-meta div {
                margin-bottom: 4px;
            }

            .rollback-btn {
                width: 100%;
                background: #bf8700;
                color: white;
                border: none;
                padding: 10px;
                border-radius: 4px;
                cursor: pointer;
                font-weight: 600;
            }
            .rollback-btn:hover {
                background: #d59800;
            }

            .current-label {
                text-align: center;
                color: var(--vscode-descriptionForeground);
                font-style: italic;
                padding: 8px;
            }

            .jobs-table {
                width: 100%;
                border-collapse: collapse;
            }
            .jobs-table th, .jobs-table td {
                padding: 10px;
                text-align: left;
                border-bottom: 1px solid var(--vscode-panel-border);
            }
            .jobs-table th {
                font-weight: 600;
                color: var(--vscode-descriptionForeground);
            }
            .jobs-table tr:hover {
                background: var(--vscode-list-hoverBackground);
            }
        `;
    }
}
