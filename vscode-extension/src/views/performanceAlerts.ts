import * as vscode from 'vscode';
import { AmplifyMonitorCli, AmplifyApp, AmplifyBranch, AmplifyJob } from '../cli';

interface BuildMetrics {
    app: AmplifyApp;
    branch: AmplifyBranch;
    jobs: AmplifyJob[];
    averageDuration: number;
    latestDuration: number;
    trend: 'improving' | 'stable' | 'degrading';
    percentChange: number;
    alerts: PerformanceAlert[];
}

interface PerformanceAlert {
    type: 'duration_spike' | 'consecutive_failures' | 'slow_build' | 'flaky_builds';
    severity: 'warning' | 'critical';
    message: string;
    details?: string;
}

export class PerformanceAlertsPanel {
    public static currentPanel: PerformanceAlertsPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _cli: AmplifyMonitorCli;

    // Thresholds for alerts
    private static readonly DURATION_SPIKE_THRESHOLD = 50; // 50% increase
    private static readonly SLOW_BUILD_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
    private static readonly CONSECUTIVE_FAILURES = 3;
    private static readonly FLAKY_BUILD_THRESHOLD = 0.3; // 30% failure rate

    public static createOrShow(extensionUri: vscode.Uri, cli: AmplifyMonitorCli) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (PerformanceAlertsPanel.currentPanel) {
            PerformanceAlertsPanel.currentPanel._panel.reveal(column);
            PerformanceAlertsPanel.currentPanel._update();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'amplifyPerformanceAlerts',
            'Performance Alerts',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            }
        );

        PerformanceAlertsPanel.currentPanel = new PerformanceAlertsPanel(panel, extensionUri, cli);
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
                    case 'openConsole':
                        vscode.env.openExternal(vscode.Uri.parse(message.url));
                        break;
                    case 'diagnose':
                        vscode.commands.executeCommand('amplify-monitor.diagnoseJob', 
                            message.appId, message.branch, message.jobId);
                        break;
                    case 'showHistory':
                        // selectBranch expects: branch, appId, region, profile
                        vscode.commands.executeCommand('amplify-monitor.selectBranch', 
                            message.branch, message.appId, message.region);
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    public dispose() {
        PerformanceAlertsPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) {
                d.dispose();
            }
        }
    }

    private async _update() {
        this._panel.webview.html = this._getLoadingHtml();

        try {
            const data = await this._fetchPerformanceData();
            this._panel.webview.html = this._getHtmlForWebview(data);
        } catch (error) {
            this._panel.webview.html = this._getErrorHtml(error instanceof Error ? error.message : 'Unknown error');
        }
    }

    private async _fetchPerformanceData(): Promise<{
        metrics: BuildMetrics[];
        totalAlerts: number;
        criticalAlerts: number;
    }> {
        const metrics: BuildMetrics[] = [];
        let totalAlerts = 0;
        let criticalAlerts = 0;

        try {
            const apps = await this._cli.listApps();
            if (!apps || apps.length === 0) {
                return { metrics, totalAlerts, criticalAlerts };
            }

            for (const app of apps.slice(0, 5)) {
                try {
                    const branches = await this._cli.listBranches(app.appId, app.region);
                    if (!branches) continue;

                    for (const branch of branches.slice(0, 5)) {
                        try {
                            const jobs = await this._cli.listJobs(app.appId, branch.branchName, app.region);
                            if (!jobs || jobs.length < 2) continue;

                            const buildMetrics = this._analyzeBuildMetrics(app, branch, jobs);
                            if (buildMetrics.alerts.length > 0) {
                                metrics.push(buildMetrics);
                                totalAlerts += buildMetrics.alerts.length;
                                criticalAlerts += buildMetrics.alerts.filter(a => a.severity === 'critical').length;
                            }
                        } catch {
                            // Skip branches that fail
                        }
                    }
                } catch {
                    // Skip apps that fail
                }
            }
        } catch (error) {
            console.error('Failed to fetch performance data:', error);
        }

        // Sort by severity and alert count
        metrics.sort((a, b) => {
            const aCritical = a.alerts.filter(x => x.severity === 'critical').length;
            const bCritical = b.alerts.filter(x => x.severity === 'critical').length;
            if (aCritical !== bCritical) return bCritical - aCritical;
            return b.alerts.length - a.alerts.length;
        });

        return { metrics, totalAlerts, criticalAlerts };
    }

    private _analyzeBuildMetrics(app: AmplifyApp, branch: AmplifyBranch, jobs: AmplifyJob[]): BuildMetrics {
        const alerts: PerformanceAlert[] = [];
        
        // Calculate durations for completed jobs
        const completedJobs = jobs.filter(j => j.startTime && j.endTime);
        const durations = completedJobs.map(j => this._getDurationMs(j.startTime!, j.endTime!));
        
        const averageDuration = durations.length > 0 
            ? durations.reduce((a, b) => a + b, 0) / durations.length 
            : 0;
        
        const latestDuration = durations.length > 0 ? durations[0] : 0;

        // Calculate trend
        let trend: 'improving' | 'stable' | 'degrading' = 'stable';
        let percentChange = 0;
        
        if (durations.length >= 3) {
            const recentAvg = (durations[0] + durations[1] + durations[2]) / 3;
            const olderDurations = durations.slice(3, 8);
            if (olderDurations.length > 0) {
                const olderAvg = olderDurations.reduce((a, b) => a + b, 0) / olderDurations.length;
                percentChange = ((recentAvg - olderAvg) / olderAvg) * 100;
                
                if (percentChange > 20) {
                    trend = 'degrading';
                } else if (percentChange < -20) {
                    trend = 'improving';
                }
            }
        }

        // Check for duration spike
        if (latestDuration > averageDuration * (1 + PerformanceAlertsPanel.DURATION_SPIKE_THRESHOLD / 100)) {
            const spikePercent = Math.round(((latestDuration - averageDuration) / averageDuration) * 100);
            alerts.push({
                type: 'duration_spike',
                severity: spikePercent > 100 ? 'critical' : 'warning',
                message: `Build duration spiked by ${spikePercent}%`,
                details: `Latest: ${this._formatDuration(latestDuration)}, Average: ${this._formatDuration(averageDuration)}`
            });
        }

        // Check for slow builds
        if (latestDuration > PerformanceAlertsPanel.SLOW_BUILD_THRESHOLD_MS) {
            alerts.push({
                type: 'slow_build',
                severity: latestDuration > PerformanceAlertsPanel.SLOW_BUILD_THRESHOLD_MS * 2 ? 'critical' : 'warning',
                message: `Slow build detected (${this._formatDuration(latestDuration)})`,
                details: 'Builds taking over 10 minutes may indicate optimization opportunities'
            });
        }

        // Check for consecutive failures
        let consecutiveFailures = 0;
        for (const job of jobs) {
            if (job.status === 'FAILED') {
                consecutiveFailures++;
            } else if (job.status === 'SUCCEED') {
                break;
            }
        }
        
        if (consecutiveFailures >= PerformanceAlertsPanel.CONSECUTIVE_FAILURES) {
            alerts.push({
                type: 'consecutive_failures',
                severity: 'critical',
                message: `${consecutiveFailures} consecutive build failures`,
                details: 'This branch may have an underlying issue that needs investigation'
            });
        }

        // Check for flaky builds
        const recentJobs = jobs.slice(0, 10);
        const failureCount = recentJobs.filter(j => j.status === 'FAILED').length;
        const failureRate = failureCount / recentJobs.length;
        
        if (failureRate >= PerformanceAlertsPanel.FLAKY_BUILD_THRESHOLD && failureRate < 1) {
            alerts.push({
                type: 'flaky_builds',
                severity: failureRate > 0.5 ? 'critical' : 'warning',
                message: `High failure rate (${Math.round(failureRate * 100)}%)`,
                details: `${failureCount} out of ${recentJobs.length} recent builds failed`
            });
        }

        return {
            app,
            branch,
            jobs,
            averageDuration,
            latestDuration,
            trend,
            percentChange: Math.round(percentChange),
            alerts
        };
    }

    private _getDurationMs(startTime: string, endTime: string): number {
        return new Date(endTime).getTime() - new Date(startTime).getTime();
    }

    private _formatDuration(ms: number): string {
        const minutes = Math.floor(ms / 60000);
        const seconds = Math.floor((ms % 60000) / 1000);
        if (minutes === 0) {
            return `${seconds}s`;
        }
        return `${minutes}m ${seconds}s`;
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
            <p>Analyzing build performance...</p>
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

    private _getHtmlForWebview(data: { metrics: BuildMetrics[]; totalAlerts: number; criticalAlerts: number }): string {
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
                .summary-card.critical .number { color: #cf222e; }
                .summary-card.warning .number { color: #bf8700; }
                .summary-card.healthy .number { color: #2ea043; }

                .alert-section {
                    background: var(--vscode-editor-inactiveSelectionBackground);
                    border-radius: 8px;
                    padding: 15px;
                    margin-bottom: 15px;
                }
                .alert-section.critical {
                    border-left: 4px solid #cf222e;
                }
                .alert-section.warning {
                    border-left: 4px solid #bf8700;
                }

                .alert-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 12px;
                }
                .alert-title {
                    font-weight: 600;
                    font-size: 1.1em;
                }
                .alert-app {
                    font-size: 0.85em;
                    color: var(--vscode-descriptionForeground);
                }

                .trend-badge {
                    padding: 3px 10px;
                    border-radius: 12px;
                    font-size: 0.75em;
                    font-weight: 600;
                }
                .trend-improving { background: #2ea043; color: white; }
                .trend-stable { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
                .trend-degrading { background: #cf222e; color: white; }

                .alert-list {
                    list-style: none;
                    padding: 0;
                    margin: 0 0 15px 0;
                }
                .alert-item {
                    display: flex;
                    align-items: flex-start;
                    gap: 10px;
                    padding: 10px;
                    border-radius: 6px;
                    margin-bottom: 8px;
                    background: var(--vscode-editor-background);
                }
                .alert-item.critical {
                    border: 1px solid #cf222e;
                }
                .alert-item.warning {
                    border: 1px solid #bf8700;
                }
                .alert-icon {
                    font-size: 1.2em;
                }
                .alert-content {
                    flex: 1;
                }
                .alert-message {
                    font-weight: 500;
                }
                .alert-details {
                    font-size: 0.85em;
                    color: var(--vscode-descriptionForeground);
                    margin-top: 4px;
                }

                .metrics-grid {
                    display: grid;
                    grid-template-columns: repeat(3, 1fr);
                    gap: 10px;
                    margin-bottom: 15px;
                }
                .metric-box {
                    background: var(--vscode-editor-background);
                    padding: 10px;
                    border-radius: 6px;
                    text-align: center;
                }
                .metric-value {
                    font-size: 1.2em;
                    font-weight: 600;
                }
                .metric-label {
                    font-size: 0.8em;
                    color: var(--vscode-descriptionForeground);
                }

                .action-bar {
                    display: flex;
                    gap: 8px;
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

                .empty-state {
                    text-align: center;
                    padding: 50px;
                    color: var(--vscode-descriptionForeground);
                }
                .empty-state .icon { font-size: 3em; margin-bottom: 15px; }
                .empty-state h3 { color: #2ea043; }

                .chart-placeholder {
                    background: var(--vscode-editor-background);
                    border-radius: 8px;
                    padding: 20px;
                    text-align: center;
                    margin-top: 15px;
                }
                .sparkline {
                    display: flex;
                    align-items: flex-end;
                    height: 40px;
                    gap: 2px;
                    justify-content: center;
                }
                .sparkline-bar {
                    width: 8px;
                    background: var(--vscode-button-background);
                    border-radius: 2px;
                    transition: height 0.3s;
                }
                .sparkline-bar.failed {
                    background: #cf222e;
                }
            </style>
        </head>
        <body>
            <h1>
                📊 Performance Alerts
                <button class="refresh-btn" onclick="refresh()">🔄 Refresh</button>
            </h1>

            <div class="summary">
                <div class="summary-card ${data.criticalAlerts > 0 ? 'critical' : 'healthy'}">
                    <div class="number">${data.criticalAlerts}</div>
                    <div class="label">Critical</div>
                </div>
                <div class="summary-card ${data.totalAlerts - data.criticalAlerts > 0 ? 'warning' : 'healthy'}">
                    <div class="number">${data.totalAlerts - data.criticalAlerts}</div>
                    <div class="label">Warnings</div>
                </div>
                <div class="summary-card healthy">
                    <div class="number">${data.metrics.filter(m => m.trend === 'improving').length}</div>
                    <div class="label">Improving</div>
                </div>
            </div>

            ${data.metrics.length === 0 ? `
                <div class="empty-state">
                    <div class="icon">✅</div>
                    <h3>All Clear!</h3>
                    <p>No performance issues detected in your Amplify builds.</p>
                    <p>Keep up the good work! 🎉</p>
                </div>
            ` : `
                <h2>⚠️ Issues Detected</h2>
                ${data.metrics.map(m => this._renderMetricCard(m)).join('')}
            `}

            <script>
                const vscode = acquireVsCodeApi();
                
                function refresh() {
                    vscode.postMessage({ command: 'refresh' });
                }
                
                function openConsole(url) {
                    vscode.postMessage({ command: 'openConsole', url });
                }

                function diagnose(appId, branch, jobId) {
                    vscode.postMessage({ command: 'diagnose', appId, branch, jobId });
                }

                function showHistory(appId, branch) {
                    vscode.postMessage({ command: 'showHistory', appId, branch });
                }
            </script>
        </body>
        </html>`;
    }

    private _renderMetricCard(metrics: BuildMetrics): string {
        const hasCritical = metrics.alerts.some(a => a.severity === 'critical');
        const consoleUrl = `https://console.aws.amazon.com/amplify/home#/${metrics.app.appId}/${metrics.branch.branchName}`;
        const latestJob = metrics.jobs[0];
        
        // Generate sparkline data
        const sparklineData = metrics.jobs.slice(0, 10).reverse().map(j => {
            if (j.startTime && j.endTime) {
                const duration = this._getDurationMs(j.startTime, j.endTime);
                const maxDuration = Math.max(...metrics.jobs.slice(0, 10)
                    .filter(x => x.startTime && x.endTime)
                    .map(x => this._getDurationMs(x.startTime!, x.endTime!)));
                return { height: Math.max(5, (duration / maxDuration) * 40), failed: j.status === 'FAILED' };
            }
            return { height: 5, failed: j.status === 'FAILED' };
        });

        return `
            <div class="alert-section ${hasCritical ? 'critical' : 'warning'}">
                <div class="alert-header">
                    <div>
                        <div class="alert-title">🌿 ${metrics.branch.branchName}</div>
                        <div class="alert-app">📱 ${metrics.app.name}</div>
                    </div>
                    <span class="trend-badge trend-${metrics.trend}">
                        ${metrics.trend === 'improving' ? '📈' : metrics.trend === 'degrading' ? '📉' : '➡️'}
                        ${metrics.trend} (${metrics.percentChange > 0 ? '+' : ''}${metrics.percentChange}%)
                    </span>
                </div>

                <div class="metrics-grid">
                    <div class="metric-box">
                        <div class="metric-value">${this._formatDuration(metrics.latestDuration)}</div>
                        <div class="metric-label">Latest Build</div>
                    </div>
                    <div class="metric-box">
                        <div class="metric-value">${this._formatDuration(metrics.averageDuration)}</div>
                        <div class="metric-label">Average</div>
                    </div>
                    <div class="metric-box">
                        <div class="sparkline">
                            ${sparklineData.map(d => `<div class="sparkline-bar ${d.failed ? 'failed' : ''}" style="height: ${d.height}px"></div>`).join('')}
                        </div>
                        <div class="metric-label">Last 10 builds</div>
                    </div>
                </div>

                <ul class="alert-list">
                    ${metrics.alerts.map(alert => `
                        <li class="alert-item ${alert.severity}">
                            <span class="alert-icon">${this._getAlertIcon(alert.type)}</span>
                            <div class="alert-content">
                                <div class="alert-message">${alert.message}</div>
                                ${alert.details ? `<div class="alert-details">${alert.details}</div>` : ''}
                            </div>
                        </li>
                    `).join('')}
                </ul>

                <div class="action-bar">
                    <button class="action-btn" onclick="openConsole('${consoleUrl}')">📊 Console</button>
                    ${latestJob && latestJob.status === 'FAILED' ? `
                        <button class="action-btn" onclick="diagnose('${metrics.app.appId}', '${metrics.branch.branchName}', '${latestJob.jobId}')">🔍 Diagnose</button>
                    ` : ''}
                    <button class="action-btn" onclick="showHistory('${metrics.app.appId}', '${metrics.branch.branchName}')">📜 History</button>
                </div>
            </div>
        `;
    }

    private _getAlertIcon(type: PerformanceAlert['type']): string {
        switch (type) {
            case 'duration_spike': return '⏱️';
            case 'consecutive_failures': return '❌';
            case 'slow_build': return '🐢';
            case 'flaky_builds': return '🎲';
            default: return '⚠️';
        }
    }
}
