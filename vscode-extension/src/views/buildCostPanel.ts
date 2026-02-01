import * as vscode from 'vscode';
import { AmplifyMonitorCli, AmplifyJob } from '../cli';

interface CostEstimate {
    buildMinutes: number;
    buildCost: number;
    dataTransferGB: number;
    dataTransferCost: number;
    storageCost: number;
    totalCost: number;
    currency: string;
}

interface BuildCostData {
    appId: string;
    appName: string;
    branch: string;
    period: string;
    jobs: JobCostEntry[];
    summary: CostEstimate;
    monthlyProjection: CostEstimate;
}

interface JobCostEntry {
    jobId: string;
    status: string;
    startTime: string;
    endTime?: string;
    durationMinutes: number;
    estimatedCost: number;
}

// AWS Amplify Hosting Pricing (as of 2024)
// https://aws.amazon.com/amplify/pricing/
const AMPLIFY_PRICING = {
    // Build & Deploy
    buildMinutePrice: 0.01, // $0.01 per build minute
    
    // Hosting
    gbServedPrice: 0.15,    // $0.15 per GB served
    requestPrice: 0.0000003, // $0.30 per million requests
    
    // Storage (SSR)
    storageGBPrice: 0.023,  // $0.023 per GB-month
    
    // Free tier
    freeBuildMinutes: 1000,  // 1000 build minutes/month free
    freeGBServed: 15,        // 15 GB served/month free
    freeStorageGB: 5,        // 5 GB storage free
};

export class BuildCostPanel {
    public static currentPanel: BuildCostPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _cli: AmplifyMonitorCli;

    public static createOrShow(extensionUri: vscode.Uri, cli: AmplifyMonitorCli) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (BuildCostPanel.currentPanel) {
            BuildCostPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'amplifyBuildCost',
            'Build Cost Estimator',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            }
        );

        BuildCostPanel.currentPanel = new BuildCostPanel(panel, extensionUri, cli);
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
                    case 'selectPeriod':
                        await this._updateWithPeriod(message.period);
                        break;
                    case 'exportCsv':
                        await this._exportToCsv(message.data);
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    public dispose() {
        BuildCostPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) {
                d.dispose();
            }
        }
    }

    private async _update() {
        await this._updateWithPeriod('30days');
    }

    private async _updateWithPeriod(period: string) {
        this._panel.webview.html = this._getLoadingHtml();

        try {
            const costData = await this._calculateCosts(period);
            this._panel.webview.html = this._getHtmlForWebview(costData);
        } catch (error) {
            this._panel.webview.html = this._getErrorHtml(error instanceof Error ? error.message : 'Unknown error');
        }
    }

    private async _calculateCosts(period: string): Promise<BuildCostData[]> {
        const appId = this._cli.getSelectedApp();
        const branch = this._cli.getSelectedBranch();

        if (!appId || !branch) {
            throw new Error('Please select an app and branch first');
        }

        // Get apps for name lookup
        const apps = await this._cli.listApps();
        const appInfo = apps?.find(a => a.appId === appId);

        // Get jobs for the period
        const jobs = await this._cli.listJobs(appId, branch);
        if (!jobs || jobs.length === 0) {
            return [{
                appId,
                appName: appInfo?.name || appId,
                branch,
                period,
                jobs: [],
                summary: this._emptyCostEstimate(),
                monthlyProjection: this._emptyCostEstimate()
            }];
        }

        // Filter jobs by period
        const now = new Date();
        const periodDays = period === '7days' ? 7 : period === '30days' ? 30 : 90;
        const cutoffDate = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000);

        const filteredJobs = jobs.filter(job => {
            if (!job.startTime) return false;
            const jobDate = new Date(job.startTime);
            return jobDate >= cutoffDate;
        });

        // Calculate costs for each job
        const jobCosts: JobCostEntry[] = filteredJobs.map(job => {
            const duration = this._calculateDuration(job);
            return {
                jobId: job.jobId,
                status: job.status,
                startTime: job.startTime || '',
                endTime: job.endTime,
                durationMinutes: duration,
                estimatedCost: duration * AMPLIFY_PRICING.buildMinutePrice
            };
        });

        // Calculate summary
        const totalMinutes = jobCosts.reduce((sum, j) => sum + j.durationMinutes, 0);
        const summary = this._calculateCostEstimate(totalMinutes);

        // Project monthly costs
        const daysInPeriod = periodDays;
        const dailyAvgMinutes = totalMinutes / daysInPeriod;
        const monthlyMinutes = dailyAvgMinutes * 30;
        const monthlyProjection = this._calculateCostEstimate(monthlyMinutes);

        return [{
            appId,
            appName: appInfo?.name || appId,
            branch,
            period,
            jobs: jobCosts,
            summary,
            monthlyProjection
        }];
    }

    private _calculateDuration(job: AmplifyJob): number {
        if (!job.startTime) return 0;
        
        const start = new Date(job.startTime);
        const end = job.endTime ? new Date(job.endTime) : new Date();
        
        const diffMs = end.getTime() - start.getTime();
        return Math.max(0, Math.ceil(diffMs / 60000)); // Convert to minutes, round up
    }

    private _calculateCostEstimate(buildMinutes: number): CostEstimate {
        // Apply free tier
        const billableMinutes = Math.max(0, buildMinutes - AMPLIFY_PRICING.freeBuildMinutes);
        const buildCost = billableMinutes * AMPLIFY_PRICING.buildMinutePrice;

        // Estimate data transfer (rough estimate based on builds)
        const estimatedGB = buildMinutes * 0.01; // ~10MB per minute
        const billableGB = Math.max(0, estimatedGB - AMPLIFY_PRICING.freeGBServed);
        const dataTransferCost = billableGB * AMPLIFY_PRICING.gbServedPrice;

        // Storage cost (estimate)
        const storageCost = 0; // Would need actual storage data

        return {
            buildMinutes,
            buildCost,
            dataTransferGB: estimatedGB,
            dataTransferCost,
            storageCost,
            totalCost: buildCost + dataTransferCost + storageCost,
            currency: 'USD'
        };
    }

    private _emptyCostEstimate(): CostEstimate {
        return {
            buildMinutes: 0,
            buildCost: 0,
            dataTransferGB: 0,
            dataTransferCost: 0,
            storageCost: 0,
            totalCost: 0,
            currency: 'USD'
        };
    }

    private async _exportToCsv(data: BuildCostData[]) {
        const lines = ['Job ID,Status,Start Time,Duration (min),Estimated Cost ($)'];
        
        for (const app of data) {
            for (const job of app.jobs) {
                lines.push(`${job.jobId},${job.status},${job.startTime},${job.durationMinutes},${job.estimatedCost.toFixed(4)}`);
            }
        }

        const content = lines.join('\n');
        
        const uri = await vscode.window.showSaveDialog({
            filters: { 'CSV': ['csv'] },
            defaultUri: vscode.Uri.file(`amplify-costs-${new Date().toISOString().split('T')[0]}.csv`)
        });

        if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(content));
            vscode.window.showInformationMessage(`Exported costs to ${uri.fsPath}`);
        }
    }

    private _getLoadingHtml(): string {
        return `<!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: var(--vscode-font-family); padding: 20px; display: flex; justify-content: center; align-items: center; height: 80vh; }
                .spinner { width: 50px; height: 50px; border: 3px solid var(--vscode-foreground); border-top-color: transparent; border-radius: 50%; animation: spin 1s linear infinite; }
                @keyframes spin { to { transform: rotate(360deg); } }
            </style>
        </head>
        <body>
            <div class="spinner"></div>
        </body>
        </html>`;
    }

    private _getErrorHtml(error: string): string {
        return `<!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: var(--vscode-font-family); padding: 20px; }
                .error { color: var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground); padding: 15px; border-radius: 4px; }
            </style>
        </head>
        <body>
            <div class="error">⚠️ ${error}</div>
        </body>
        </html>`;
    }

    private _getHtmlForWebview(data: BuildCostData[]): string {
        const appData = data[0];
        
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
                h1 { font-size: 1.5em; margin-bottom: 5px; }
                h2 { font-size: 1.2em; margin-top: 25px; color: var(--vscode-textLink-foreground); }
                .subtitle { color: var(--vscode-descriptionForeground); margin-bottom: 20px; }
                
                .period-selector {
                    margin: 20px 0;
                }
                .period-btn {
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    border: none;
                    padding: 8px 16px;
                    margin-right: 8px;
                    border-radius: 4px;
                    cursor: pointer;
                }
                .period-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
                .period-btn.active { 
                    background: var(--vscode-button-background); 
                    color: var(--vscode-button-foreground); 
                }

                .cost-cards {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                    gap: 15px;
                    margin: 20px 0;
                }
                .cost-card {
                    background: var(--vscode-editor-inactiveSelectionBackground);
                    padding: 20px;
                    border-radius: 8px;
                    text-align: center;
                }
                .cost-card .label { 
                    font-size: 0.9em; 
                    color: var(--vscode-descriptionForeground); 
                    margin-bottom: 8px;
                }
                .cost-card .value { 
                    font-size: 1.8em; 
                    font-weight: bold; 
                    color: var(--vscode-textLink-foreground);
                }
                .cost-card .subvalue { 
                    font-size: 0.85em; 
                    color: var(--vscode-descriptionForeground);
                    margin-top: 5px;
                }
                .cost-card.total { 
                    background: var(--vscode-button-background);
                }
                .cost-card.total .value { color: var(--vscode-button-foreground); }
                .cost-card.total .label { color: var(--vscode-button-foreground); opacity: 0.8; }

                .free-tier-note {
                    background: var(--vscode-editorInfo-background);
                    border-left: 3px solid var(--vscode-editorInfo-foreground);
                    padding: 12px;
                    margin: 20px 0;
                    font-size: 0.9em;
                }

                table { 
                    width: 100%; 
                    border-collapse: collapse; 
                    margin-top: 15px;
                    font-size: 0.9em;
                }
                th, td { 
                    padding: 10px; 
                    text-align: left; 
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                th { 
                    background: var(--vscode-editor-inactiveSelectionBackground);
                    font-weight: 600;
                }
                tr:hover { background: var(--vscode-list-hoverBackground); }
                
                .status-badge {
                    padding: 3px 8px;
                    border-radius: 4px;
                    font-size: 0.8em;
                    font-weight: 500;
                }
                .status-SUCCEED { background: #2ea043; color: white; }
                .status-FAILED { background: #cf222e; color: white; }
                .status-RUNNING { background: #0969da; color: white; }
                .status-PENDING { background: #6e7681; color: white; }

                .export-btn {
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    border: none;
                    padding: 8px 16px;
                    border-radius: 4px;
                    cursor: pointer;
                    float: right;
                }
                .export-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }

                .projection {
                    margin-top: 30px;
                    padding: 20px;
                    background: var(--vscode-editorWidget-background);
                    border-radius: 8px;
                }
                .projection h3 { margin-top: 0; }
            </style>
        </head>
        <body>
            <h1>💰 Build Cost Estimator</h1>
            <div class="subtitle">${appData.appName} / ${appData.branch}</div>

            <div class="period-selector">
                <button class="period-btn ${appData.period === '7days' ? 'active' : ''}" onclick="selectPeriod('7days')">Last 7 Days</button>
                <button class="period-btn ${appData.period === '30days' ? 'active' : ''}" onclick="selectPeriod('30days')">Last 30 Days</button>
                <button class="period-btn ${appData.period === '90days' ? 'active' : ''}" onclick="selectPeriod('90days')">Last 90 Days</button>
                <button class="export-btn" onclick="exportCsv()">📥 Export CSV</button>
            </div>

            <div class="free-tier-note">
                ℹ️ <strong>AWS Free Tier:</strong> 1,000 build minutes/month, 15 GB served/month, 5 GB storage.
                Costs shown are estimates after free tier.
            </div>

            <h2>📊 Period Summary</h2>
            <div class="cost-cards">
                <div class="cost-card">
                    <div class="label">Build Minutes</div>
                    <div class="value">${appData.summary.buildMinutes.toFixed(0)}</div>
                    <div class="subvalue">${appData.jobs.length} builds</div>
                </div>
                <div class="cost-card">
                    <div class="label">Build Cost</div>
                    <div class="value">$${appData.summary.buildCost.toFixed(2)}</div>
                    <div class="subvalue">@ $0.01/min</div>
                </div>
                <div class="cost-card">
                    <div class="label">Data Transfer</div>
                    <div class="value">~${appData.summary.dataTransferGB.toFixed(1)} GB</div>
                    <div class="subvalue">$${appData.summary.dataTransferCost.toFixed(2)}</div>
                </div>
                <div class="cost-card total">
                    <div class="label">Total Estimated</div>
                    <div class="value">$${appData.summary.totalCost.toFixed(2)}</div>
                    <div class="subvalue">for this period</div>
                </div>
            </div>

            <div class="projection">
                <h3>📈 Monthly Projection</h3>
                <p>Based on current usage, estimated monthly cost: <strong>$${appData.monthlyProjection.totalCost.toFixed(2)}/month</strong></p>
                <p style="color: var(--vscode-descriptionForeground); font-size: 0.9em;">
                    (~${appData.monthlyProjection.buildMinutes.toFixed(0)} build minutes/month)
                </p>
            </div>

            <h2>📋 Build History</h2>
            <table>
                <thead>
                    <tr>
                        <th>Job</th>
                        <th>Status</th>
                        <th>Started</th>
                        <th>Duration</th>
                        <th>Est. Cost</th>
                    </tr>
                </thead>
                <tbody>
                    ${appData.jobs.map(job => `
                        <tr>
                            <td>#${job.jobId}</td>
                            <td><span class="status-badge status-${job.status}">${job.status}</span></td>
                            <td>${new Date(job.startTime).toLocaleString()}</td>
                            <td>${job.durationMinutes} min</td>
                            <td>$${job.estimatedCost.toFixed(4)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>

            <script>
                const vscode = acquireVsCodeApi();
                
                function selectPeriod(period) {
                    vscode.postMessage({ command: 'selectPeriod', period });
                }
                
                function exportCsv() {
                    vscode.postMessage({ command: 'exportCsv', data: ${JSON.stringify(data)} });
                }
            </script>
        </body>
        </html>`;
    }
}
