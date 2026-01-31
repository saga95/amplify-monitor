import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface BuildRecord {
    timestamp: string;
    duration: number; // seconds
    status: 'success' | 'failed';
    branch: string;
    appId: string;
    jobId: string;
    phases?: {
        preBuild?: number;
        build?: number;
        postBuild?: number;
        deploy?: number;
    };
}

interface PerformanceStats {
    totalBuilds: number;
    successRate: number;
    avgDuration: number;
    minDuration: number;
    maxDuration: number;
    trend: 'improving' | 'degrading' | 'stable';
    recentBuilds: BuildRecord[];
    byBranch: Record<string, { count: number; avgDuration: number; successRate: number }>;
}

const MAX_RECORDS = 100;

export class BuildPerformanceTracker {
    private records: BuildRecord[] = [];
    private storagePath: string;

    constructor(context: vscode.ExtensionContext) {
        this.storagePath = path.join(context.globalStorageUri.fsPath, 'build-performance.json');
        this.load();
    }

    private load() {
        try {
            if (fs.existsSync(this.storagePath)) {
                const data = fs.readFileSync(this.storagePath, 'utf8');
                this.records = JSON.parse(data);
            }
        } catch {
            this.records = [];
        }
    }

    private save() {
        try {
            const dir = path.dirname(this.storagePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.storagePath, JSON.stringify(this.records, null, 2));
        } catch (error) {
            console.error('Failed to save build performance data:', error);
        }
    }

    public recordBuild(record: BuildRecord) {
        this.records.unshift(record);
        if (this.records.length > MAX_RECORDS) {
            this.records = this.records.slice(0, MAX_RECORDS);
        }
        this.save();
    }

    public getStats(appId?: string, branch?: string): PerformanceStats {
        let filtered = this.records;
        
        if (appId) {
            filtered = filtered.filter(r => r.appId === appId);
        }
        if (branch) {
            filtered = filtered.filter(r => r.branch === branch);
        }

        if (filtered.length === 0) {
            return {
                totalBuilds: 0,
                successRate: 0,
                avgDuration: 0,
                minDuration: 0,
                maxDuration: 0,
                trend: 'stable',
                recentBuilds: [],
                byBranch: {}
            };
        }

        const successCount = filtered.filter(r => r.status === 'success').length;
        const durations = filtered.map(r => r.duration);
        const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;

        // Calculate trend (compare last 5 vs previous 5)
        let trend: 'improving' | 'degrading' | 'stable' = 'stable';
        if (filtered.length >= 10) {
            const recent5 = filtered.slice(0, 5).map(r => r.duration);
            const prev5 = filtered.slice(5, 10).map(r => r.duration);
            const recentAvg = recent5.reduce((a, b) => a + b, 0) / 5;
            const prevAvg = prev5.reduce((a, b) => a + b, 0) / 5;
            const diff = ((recentAvg - prevAvg) / prevAvg) * 100;
            
            if (diff < -10) trend = 'improving';
            else if (diff > 10) trend = 'degrading';
        }

        // Stats by branch
        const byBranch: Record<string, { count: number; avgDuration: number; successRate: number }> = {};
        for (const record of filtered) {
            if (!byBranch[record.branch]) {
                byBranch[record.branch] = { count: 0, avgDuration: 0, successRate: 0 };
            }
            byBranch[record.branch].count++;
        }
        
        for (const branch of Object.keys(byBranch)) {
            const branchRecords = filtered.filter(r => r.branch === branch);
            const branchSuccess = branchRecords.filter(r => r.status === 'success').length;
            const branchDurations = branchRecords.map(r => r.duration);
            byBranch[branch].avgDuration = branchDurations.reduce((a, b) => a + b, 0) / branchDurations.length;
            byBranch[branch].successRate = (branchSuccess / branchRecords.length) * 100;
        }

        return {
            totalBuilds: filtered.length,
            successRate: (successCount / filtered.length) * 100,
            avgDuration,
            minDuration: Math.min(...durations),
            maxDuration: Math.max(...durations),
            trend,
            recentBuilds: filtered.slice(0, 20),
            byBranch
        };
    }

    public clearHistory() {
        this.records = [];
        this.save();
    }
}

export class BuildPerformancePanel {
    public static currentPanel: BuildPerformancePanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _tracker: BuildPerformanceTracker;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(tracker: BuildPerformanceTracker) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (BuildPerformancePanel.currentPanel) {
            BuildPerformancePanel.currentPanel._panel.reveal(column);
            BuildPerformancePanel.currentPanel.refresh();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'buildPerformance',
            '📈 Build Performance',
            column || vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        BuildPerformancePanel.currentPanel = new BuildPerformancePanel(panel, tracker);
    }

    private constructor(panel: vscode.WebviewPanel, tracker: BuildPerformanceTracker) {
        this._panel = panel;
        this._tracker = tracker;

        this._panel.webview.onDidReceiveMessage(
            async message => {
                if (message.command === 'refresh') {
                    this.refresh();
                } else if (message.command === 'clear') {
                    const confirm = await vscode.window.showWarningMessage(
                        'Clear all build history?', 'Yes', 'No'
                    );
                    if (confirm === 'Yes') {
                        this._tracker.clearHistory();
                        this.refresh();
                    }
                }
            },
            null,
            this._disposables
        );

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this.refresh();
    }

    public refresh() {
        const stats = this._tracker.getStats();
        this._panel.webview.html = this._getHtml(stats);
    }

    private _formatDuration(seconds: number): string {
        if (seconds < 60) return `${Math.round(seconds)}s`;
        const mins = Math.floor(seconds / 60);
        const secs = Math.round(seconds % 60);
        return `${mins}m ${secs}s`;
    }

    private _getHtml(stats: PerformanceStats): string {
        const trendIcon = stats.trend === 'improving' ? '📈' : stats.trend === 'degrading' ? '📉' : '➡️';
        const trendColor = stats.trend === 'improving' ? '#4caf50' : stats.trend === 'degrading' ? '#f44336' : '#ff9800';

        const buildRows = stats.recentBuilds.map(b => {
            const date = new Date(b.timestamp);
            const statusIcon = b.status === 'success' ? '✅' : '❌';
            return `<tr>
                <td>${statusIcon}</td>
                <td>${b.branch}</td>
                <td>${this._formatDuration(b.duration)}</td>
                <td>${date.toLocaleDateString()} ${date.toLocaleTimeString()}</td>
            </tr>`;
        }).join('');

        const branchRows = Object.entries(stats.byBranch)
            .sort((a, b) => b[1].count - a[1].count)
            .map(([branch, data]) => `<tr>
                <td>${branch}</td>
                <td>${data.count}</td>
                <td>${this._formatDuration(data.avgDuration)}</td>
                <td>${data.successRate.toFixed(0)}%</td>
            </tr>`).join('');

        // Generate simple chart data
        const chartData = stats.recentBuilds.slice(0, 10).reverse().map(b => ({
            duration: b.duration,
            label: new Date(b.timestamp).toLocaleDateString()
        }));

        const maxDuration = Math.max(...chartData.map(d => d.duration), 1);
        const chartBars = chartData.map(d => {
            const height = (d.duration / maxDuration) * 100;
            return `<div class="chart-bar" style="height:${height}%" title="${this._formatDuration(d.duration)}"></div>`;
        }).join('');

        return `<!DOCTYPE html>
        <html><head><style>
            * { box-sizing: border-box; }
            body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); max-width: 1200px; margin: 0 auto; }
            .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
            h1 { margin: 0; font-size: 24px; }
            .btn { padding: 8px 16px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; border-radius: 4px; margin-left: 8px; }
            .btn-danger { background: #f44336; }
            .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
            .card { background: var(--vscode-sideBar-background); border-radius: 8px; padding: 16px; border: 1px solid var(--vscode-panel-border); }
            .card h3 { margin: 0 0 8px 0; font-size: 14px; opacity: 0.8; }
            .card .value { font-size: 24px; font-weight: bold; }
            .card .sub { font-size: 12px; opacity: 0.7; margin-top: 4px; }
            table { width: 100%; border-collapse: collapse; font-size: 13px; }
            th { text-align: left; padding: 10px; border-bottom: 2px solid var(--vscode-panel-border); }
            td { padding: 8px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
            tr:hover { background: var(--vscode-list-hoverBackground); }
            .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 24px; }
            @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
            .chart { background: var(--vscode-sideBar-background); border-radius: 8px; padding: 16px; border: 1px solid var(--vscode-panel-border); margin-bottom: 24px; }
            .chart h3 { margin: 0 0 16px 0; }
            .chart-container { display: flex; align-items: flex-end; height: 100px; gap: 8px; }
            .chart-bar { flex: 1; background: var(--vscode-button-background); border-radius: 4px 4px 0 0; min-width: 20px; transition: height 0.3s; }
            .chart-bar:hover { background: var(--vscode-button-hoverBackground); }
            .empty { text-align: center; padding: 40px; opacity: 0.6; }
        </style></head>
        <body>
            <div class="header">
                <h1>📈 Build Performance</h1>
                <div>
                    <button class="btn" onclick="refresh()">🔄 Refresh</button>
                    <button class="btn btn-danger" onclick="clearHistory()">🗑️ Clear</button>
                </div>
            </div>

            ${stats.totalBuilds === 0 ? `
                <div class="empty">
                    <h2>No build data yet</h2>
                    <p>Build performance will be tracked as you diagnose builds.</p>
                </div>
            ` : `
                <div class="summary">
                    <div class="card">
                        <h3>Total Builds</h3>
                        <div class="value">${stats.totalBuilds}</div>
                    </div>
                    <div class="card">
                        <h3>Success Rate</h3>
                        <div class="value" style="color:${stats.successRate >= 80 ? '#4caf50' : stats.successRate >= 50 ? '#ff9800' : '#f44336'}">${stats.successRate.toFixed(0)}%</div>
                    </div>
                    <div class="card">
                        <h3>Avg Duration</h3>
                        <div class="value">${this._formatDuration(stats.avgDuration)}</div>
                        <div class="sub">Min: ${this._formatDuration(stats.minDuration)} / Max: ${this._formatDuration(stats.maxDuration)}</div>
                    </div>
                    <div class="card">
                        <h3>Trend</h3>
                        <div class="value" style="color:${trendColor}">${trendIcon} ${stats.trend}</div>
                    </div>
                </div>

                <div class="chart">
                    <h3>📊 Recent Build Durations</h3>
                    <div class="chart-container">${chartBars}</div>
                </div>

                <div class="grid">
                    <div>
                        <h2>🕐 Recent Builds</h2>
                        <table>
                            <thead><tr><th></th><th>Branch</th><th>Duration</th><th>Time</th></tr></thead>
                            <tbody>${buildRows || '<tr><td colspan="4">No builds recorded</td></tr>'}</tbody>
                        </table>
                    </div>
                    <div>
                        <h2>🌿 By Branch</h2>
                        <table>
                            <thead><tr><th>Branch</th><th>Builds</th><th>Avg Duration</th><th>Success</th></tr></thead>
                            <tbody>${branchRows || '<tr><td colspan="4">No data</td></tr>'}</tbody>
                        </table>
                    </div>
                </div>
            `}

            <script>
                const vscode = acquireVsCodeApi();
                function refresh() { vscode.postMessage({ command: 'refresh' }); }
                function clearHistory() { vscode.postMessage({ command: 'clear' }); }
            </script>
        </body></html>`;
    }

    public dispose() {
        BuildPerformancePanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }
}
