import * as vscode from 'vscode';
import { AmplifyMonitorCli, AmplifyApp, AmplifyBranch, AmplifyJob } from '../cli';

interface AppWithDetails {
    app: AmplifyApp;
    branches: BranchWithJobs[];
    profile?: string;  // Track which profile this app belongs to
}

interface BranchWithJobs {
    branch: AmplifyBranch;
    latestJob?: AmplifyJob;
}

export class DashboardPanel {
    public static currentPanel: DashboardPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _cli: AmplifyMonitorCli;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(cli: AmplifyMonitorCli) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel, show it
        if (DashboardPanel.currentPanel) {
            DashboardPanel.currentPanel._panel.reveal(column);
            DashboardPanel.currentPanel.refresh();
            return;
        }

        // Create a new panel
        const panel = vscode.window.createWebviewPanel(
            'amplifyDashboard',
            'Amplify Dashboard',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        DashboardPanel.currentPanel = new DashboardPanel(panel, cli);
    }

    private constructor(panel: vscode.WebviewPanel, cli: AmplifyMonitorCli) {
        this._panel = panel;
        this._cli = cli;

        // Set initial content
        this._panel.webview.html = this._getLoadingHtml();

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'refresh':
                        await this.refresh();
                        break;
                    case 'startBuild':
                        await this._startBuild(message.appId, message.branchName, message.region);
                        break;
                    case 'stopBuild':
                        await this._stopBuild(message.appId, message.branchName, message.jobId, message.region);
                        break;
                    case 'viewLogs':
                        await this._viewLogs(message.appId, message.branchName, message.jobId, message.region);
                        break;
                    case 'openConsole':
                        await this._openConsole(message.appId, message.region);
                        break;
                }
            },
            null,
            this._disposables
        );

        // Handle panel disposal
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Load data
        this.refresh();
    }

    public async refresh() {
        this._panel.webview.html = this._getLoadingHtml();
        
        try {
            const config = vscode.workspace.getConfiguration('amplifyMonitor');
            const isMultiAccountMode = config.get<boolean>('multiAccount.enabled', false);
            const configuredProfiles = config.get<string[]>('multiAccount.profiles', []);
            
            let allApps: { app: AmplifyApp; profile?: string }[] = [];

            if (isMultiAccountMode && configuredProfiles.length > 0) {
                // Multi-account mode: fetch apps from all configured profiles
                const profilePromises = configuredProfiles.map(async (profile) => {
                    try {
                        const apps = await this._cli.listAppsForProfile(profile, true);
                        return apps.map(app => ({ app, profile }));
                    } catch (error) {
                        console.warn(`Failed to fetch apps for profile ${profile}:`, error);
                        return [];
                    }
                });
                
                const results = await Promise.all(profilePromises);
                allApps = results.flat();
            } else {
                // Single account mode: use default/configured profile
                const apps = await this._cli.listApps(true);
                const currentProfile = this._cli.getAwsProfile() || 'default';
                allApps = apps.map(app => ({ app, profile: currentProfile }));
            }

            const appsWithDetails: AppWithDetails[] = [];

            // Fetch branches and latest jobs for each app (in parallel)
            await Promise.all(allApps.map(async ({ app, profile }) => {
                try {
                    const branches = await this._cli.listBranches(app.appId, app.region, profile);
                    const branchesWithJobs: BranchWithJobs[] = [];

                    // Get latest job for each branch
                    await Promise.all(branches.map(async (branch) => {
                        try {
                            const jobs = await this._cli.listJobs(app.appId, branch.branchName, app.region, profile);
                            branchesWithJobs.push({
                                branch,
                                latestJob: jobs[0] // Jobs are ordered by most recent
                            });
                        } catch {
                            branchesWithJobs.push({ branch });
                        }
                    }));

                    appsWithDetails.push({
                        app,
                        profile,
                        branches: branchesWithJobs.sort((a, b) => 
                            a.branch.branchName.localeCompare(b.branch.branchName)
                        )
                    });
                } catch {
                    appsWithDetails.push({ app, profile, branches: [] });
                }
            }));

            // Sort apps by name (and group by profile in multi-account mode)
            appsWithDetails.sort((a, b) => {
                if (isMultiAccountMode && a.profile !== b.profile) {
                    return (a.profile || '').localeCompare(b.profile || '');
                }
                return a.app.name.localeCompare(b.app.name);
            });

            this._panel.webview.html = this._getDashboardHtml(appsWithDetails, isMultiAccountMode);
        } catch (error) {
            this._panel.webview.html = this._getErrorHtml(String(error));
        }
    }

    private async _startBuild(appId: string, branchName: string, region: string) {
        try {
            await this._cli.startBuild(appId, branchName, region);
            vscode.window.showInformationMessage(`Build started for ${branchName}`);
            setTimeout(() => this.refresh(), 2000);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to start build: ${error}`);
        }
    }

    private async _stopBuild(appId: string, branchName: string, jobId: string, region: string) {
        try {
            await this._cli.stopBuild(appId, branchName, jobId, region);
            vscode.window.showInformationMessage(`Build stopped for ${branchName}`);
            setTimeout(() => this.refresh(), 2000);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to stop build: ${error}`);
        }
    }

    private async _viewLogs(appId: string, branchName: string, jobId: string, region: string) {
        // Set context for the diagnosis view
        this._cli.setSelectedApp(appId, region);
        this._cli.setSelectedBranch(branchName);
        
        // Execute diagnosis directly with all required parameters
        vscode.commands.executeCommand('amplify-monitor.diagnoseJob', appId, branchName, jobId);
    }

    private async _openConsole(appId: string, region: string) {
        const url = `https://${region}.console.aws.amazon.com/amplify/apps/${appId}`;
        vscode.env.openExternal(vscode.Uri.parse(url));
    }

    private _getLoadingHtml(): string {
        return `<!DOCTYPE html>
        <html>
        <head>
            <style>
                body { 
                    font-family: var(--vscode-font-family);
                    padding: 20px;
                    color: var(--vscode-foreground);
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100vh;
                }
                .loader {
                    border: 4px solid var(--vscode-editor-background);
                    border-top: 4px solid var(--vscode-button-background);
                    border-radius: 50%;
                    width: 40px;
                    height: 40px;
                    animation: spin 1s linear infinite;
                }
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
                .loading-text {
                    margin-left: 15px;
                    font-size: 16px;
                }
            </style>
        </head>
        <body>
            <div class="loader"></div>
            <span class="loading-text">Loading Amplify Dashboard...</span>
        </body>
        </html>`;
    }

    private _getErrorHtml(error: string): string {
        return `<!DOCTYPE html>
        <html>
        <head>
            <style>
                body { 
                    font-family: var(--vscode-font-family);
                    padding: 20px;
                    color: var(--vscode-foreground);
                }
                .error { color: var(--vscode-errorForeground); }
                button {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 8px 16px;
                    cursor: pointer;
                    margin-top: 10px;
                }
            </style>
        </head>
        <body>
            <h2>⚠️ Error Loading Dashboard</h2>
            <p class="error">${this._escapeHtml(error)}</p>
            <button onclick="refresh()">Retry</button>
            <script>
                const vscode = acquireVsCodeApi();
                function refresh() {
                    vscode.postMessage({ command: 'refresh' });
                }
            </script>
        </body>
        </html>`;
    }

    private _getDashboardHtml(apps: AppWithDetails[], isMultiAccountMode: boolean = false): string {
        // Group apps by profile if in multi-account mode
        const uniqueProfiles = isMultiAccountMode 
            ? [...new Set(apps.map(a => a.profile || 'default'))] 
            : [];

        const appCards = apps.map(({ app, branches, profile }) => {
            const branchRows = branches.map(({ branch, latestJob }) => {
                const status = latestJob?.status || 'UNKNOWN';
                const statusClass = this._getStatusClass(status);
                const statusIcon = this._getStatusIcon(status);
                const isRunning = status === 'PENDING' || status === 'RUNNING';
                
                return `
                    <tr class="branch-row">
                        <td class="branch-name">
                            <span class="icon">🌿</span> ${this._escapeHtml(branch.branchName)}
                        </td>
                        <td class="status ${statusClass}">
                            ${statusIcon} ${status}
                        </td>
                        <td class="job-time">
                            ${latestJob ? this._formatTime(latestJob.startTime) : '-'}
                        </td>
                        <td class="actions">
                            ${isRunning ? `
                                <button class="btn btn-stop" onclick="stopBuild('${app.appId}', '${branch.branchName}', '${latestJob?.jobId}', '${app.region}')">
                                    ⏹ Stop
                                </button>
                            ` : `
                                <button class="btn btn-start" onclick="startBuild('${app.appId}', '${branch.branchName}', '${app.region}')">
                                    ▶ Start
                                </button>
                            `}
                            ${latestJob ? `
                                <button class="btn btn-logs" onclick="viewLogs('${app.appId}', '${branch.branchName}', '${latestJob.jobId}', '${app.region}')">
                                    📋 Logs
                                </button>
                            ` : ''}
                        </td>
                    </tr>
                `;
            }).join('');

            const successCount = branches.filter(b => b.latestJob?.status === 'SUCCEED').length;
            const failCount = branches.filter(b => b.latestJob?.status === 'FAILED').length;
            const runningCount = branches.filter(b => 
                b.latestJob?.status === 'PENDING' || b.latestJob?.status === 'RUNNING'
            ).length;

            return `
                <div class="app-card">
                    <div class="app-header">
                        <div class="app-title">
                            <span class="app-icon">☁️</span>
                            <h3>${this._escapeHtml(app.name)}</h3>
                            <span class="region-badge">${app.region}</span>
                            ${isMultiAccountMode && profile ? `<span class="profile-badge">👤 ${this._escapeHtml(profile)}</span>` : ''}
                        </div>
                        <div class="app-actions">
                            <button class="btn btn-console" onclick="openConsole('${app.appId}', '${app.region}')">
                                🔗 Console
                            </button>
                        </div>
                    </div>
                    <div class="app-summary">
                        <span class="stat stat-success">✅ ${successCount}</span>
                        <span class="stat stat-fail">❌ ${failCount}</span>
                        <span class="stat stat-running">🔄 ${runningCount}</span>
                        <span class="stat stat-total">📊 ${branches.length} branches</span>
                    </div>
                    <table class="branches-table">
                        <thead>
                            <tr>
                                <th>Branch</th>
                                <th>Status</th>
                                <th>Last Build</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${branchRows || '<tr><td colspan="4" class="no-branches">No branches found</td></tr>'}
                        </tbody>
                    </table>
                </div>
            `;
        }).join('');

        // Calculate totals
        const totalApps = apps.length;
        const totalBranches = apps.reduce((sum, a) => sum + a.branches.length, 0);
        const totalSuccess = apps.reduce((sum, a) => 
            sum + a.branches.filter(b => b.latestJob?.status === 'SUCCEED').length, 0);
        const totalFailed = apps.reduce((sum, a) => 
            sum + a.branches.filter(b => b.latestJob?.status === 'FAILED').length, 0);
        const totalRunning = apps.reduce((sum, a) => 
            sum + a.branches.filter(b => 
                b.latestJob?.status === 'PENDING' || b.latestJob?.status === 'RUNNING'
            ).length, 0);

        return `<!DOCTYPE html>
        <html>
        <head>
            <style>
                * {
                    box-sizing: border-box;
                }
                body { 
                    font-family: var(--vscode-font-family);
                    padding: 20px;
                    color: var(--vscode-foreground);
                    background: var(--vscode-editor-background);
                    max-width: 1400px;
                    margin: 0 auto;
                }
                
                .header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 24px;
                    padding-bottom: 16px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                
                .header h1 {
                    margin: 0;
                    font-size: 24px;
                    display: flex;
                    align-items: center;
                    gap: 10px;
                }
                
                .multi-account-badge {
                    font-size: 12px;
                    padding: 4px 8px;
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border-radius: 4px;
                    font-weight: normal;
                }
                
                .summary-bar {
                    display: flex;
                    gap: 24px;
                    padding: 16px;
                    background: var(--vscode-sideBar-background);
                    border-radius: 8px;
                    margin-bottom: 24px;
                }
                
                .summary-item {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                }
                
                .summary-item .number {
                    font-size: 28px;
                    font-weight: bold;
                }
                
                .summary-item .label {
                    font-size: 12px;
                    opacity: 0.8;
                }
                
                .apps-grid {
                    display: grid;
                    gap: 20px;
                    grid-template-columns: repeat(auto-fill, minmax(500px, 1fr));
                }
                
                .app-card {
                    background: var(--vscode-sideBar-background);
                    border-radius: 8px;
                    padding: 16px;
                    border: 1px solid var(--vscode-panel-border);
                }
                
                .app-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 12px;
                }
                
                .app-title {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                
                .app-title h3 {
                    margin: 0;
                    font-size: 16px;
                }
                
                .app-icon {
                    font-size: 20px;
                }
                
                .region-badge {
                    font-size: 11px;
                    padding: 2px 6px;
                    background: var(--vscode-badge-background);
                    color: var(--vscode-badge-foreground);
                    border-radius: 4px;
                }
                
                .profile-badge {
                    font-size: 11px;
                    padding: 2px 6px;
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    border-radius: 4px;
                    margin-left: 4px;
                }
                
                .app-summary {
                    display: flex;
                    gap: 16px;
                    margin-bottom: 12px;
                    font-size: 13px;
                }
                
                .stat-success { color: #4caf50; }
                .stat-fail { color: #f44336; }
                .stat-running { color: #ff9800; }
                
                .branches-table {
                    width: 100%;
                    border-collapse: collapse;
                    font-size: 13px;
                }
                
                .branches-table th {
                    text-align: left;
                    padding: 8px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    opacity: 0.8;
                    font-weight: normal;
                }
                
                .branches-table td {
                    padding: 8px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                
                .branch-row:hover {
                    background: var(--vscode-list-hoverBackground);
                }
                
                .branch-name {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                }
                
                .status { font-weight: 500; }
                .status-succeed { color: #4caf50; }
                .status-failed { color: #f44336; }
                .status-running, .status-pending { color: #ff9800; }
                .status-cancelled { color: #9e9e9e; }
                
                .btn {
                    padding: 4px 8px;
                    border: none;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 12px;
                    margin-right: 4px;
                }
                
                .btn-start {
                    background: #4caf50;
                    color: white;
                }
                
                .btn-stop {
                    background: #f44336;
                    color: white;
                }
                
                .btn-logs {
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                }
                
                .btn-console {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                }
                
                .btn:hover {
                    opacity: 0.9;
                }
                
                .btn-refresh {
                    padding: 8px 16px;
                    font-size: 14px;
                }
                
                .no-branches {
                    text-align: center;
                    opacity: 0.6;
                    padding: 20px !important;
                }
                
                .no-apps {
                    text-align: center;
                    padding: 60px;
                    opacity: 0.6;
                }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>🚀 Amplify Dashboard ${isMultiAccountMode ? '<span class="multi-account-badge">Multi-Account</span>' : ''}</h1>
                <button class="btn btn-refresh" onclick="refresh()">🔄 Refresh</button>
            </div>
            
            <div class="summary-bar">
                ${isMultiAccountMode && uniqueProfiles.length > 0 ? `
                <div class="summary-item">
                    <span class="number">${uniqueProfiles.length}</span>
                    <span class="label">Profiles</span>
                </div>
                ` : ''}
                <div class="summary-item">
                    <span class="number">${totalApps}</span>
                    <span class="label">Apps</span>
                </div>
                <div class="summary-item">
                    <span class="number">${totalBranches}</span>
                    <span class="label">Branches</span>
                </div>
                <div class="summary-item">
                    <span class="number stat-success">${totalSuccess}</span>
                    <span class="label">Succeeded</span>
                </div>
                <div class="summary-item">
                    <span class="number stat-fail">${totalFailed}</span>
                    <span class="label">Failed</span>
                </div>
                <div class="summary-item">
                    <span class="number stat-running">${totalRunning}</span>
                    <span class="label">Running</span>
                </div>
            </div>
            
            ${apps.length > 0 ? `
                <div class="apps-grid">
                    ${appCards}
                </div>
            ` : `
                <div class="no-apps">
                    <h2>No Amplify Apps Found</h2>
                    <p>${isMultiAccountMode 
                        ? 'No apps found in the configured profiles. Check Settings → Amplify Monitor → Multi Account to configure profiles.' 
                        : 'Make sure your AWS credentials are configured correctly.'}</p>
                </div>
            `}
            
            <script>
                const vscode = acquireVsCodeApi();
                
                function refresh() {
                    vscode.postMessage({ command: 'refresh' });
                }
                
                function startBuild(appId, branchName, region) {
                    vscode.postMessage({ command: 'startBuild', appId, branchName, region });
                }
                
                function stopBuild(appId, branchName, jobId, region) {
                    vscode.postMessage({ command: 'stopBuild', appId, branchName, jobId, region });
                }
                
                function viewLogs(appId, branchName, jobId, region) {
                    vscode.postMessage({ command: 'viewLogs', appId, branchName, jobId, region });
                }
                
                function openConsole(appId, region) {
                    vscode.postMessage({ command: 'openConsole', appId, region });
                }
            </script>
        </body>
        </html>`;
    }

    private _getStatusClass(status: string): string {
        const statusMap: Record<string, string> = {
            'SUCCEED': 'status-succeed',
            'FAILED': 'status-failed',
            'RUNNING': 'status-running',
            'PENDING': 'status-pending',
            'CANCELLED': 'status-cancelled'
        };
        return statusMap[status] || '';
    }

    private _getStatusIcon(status: string): string {
        const iconMap: Record<string, string> = {
            'SUCCEED': '✅',
            'FAILED': '❌',
            'RUNNING': '🔄',
            'PENDING': '⏳',
            'CANCELLED': '⏸'
        };
        return iconMap[status] || '❓';
    }

    private _formatTime(timestamp: string | undefined): string {
        if (!timestamp) return '-';
        const date = new Date(timestamp);
        const now = new Date();
        const diff = now.getTime() - date.getTime();
        
        if (diff < 60000) return 'Just now';
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
        return date.toLocaleDateString();
    }

    private _escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    public dispose() {
        DashboardPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }
}
