import * as vscode from 'vscode';
import { AmplifyMonitorCli } from '../cli';

interface BuildInfo {
    jobId: string;
    branchName: string;
    status: string;
    startTime?: string;
    endTime?: string;
    duration?: number;
    commitId?: string;
    commitMessage?: string;
}

interface BuildComparison {
    build1: BuildInfo;
    build2: BuildInfo;
    differences: {
        category: string;
        items: ComparisonItem[];
    }[];
}

interface ComparisonItem {
    type: 'added' | 'removed' | 'changed' | 'same';
    label: string;
    build1Value?: string;
    build2Value?: string;
}

export class BuildComparisonPanel {
    public static currentPanel: BuildComparisonPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _cli: AmplifyMonitorCli;
    private _disposables: vscode.Disposable[] = [];
    private _currentAppId: string = '';
    private _currentBranch: string = '';

    public static createOrShow(extensionUri: vscode.Uri, cli: AmplifyMonitorCli, appId?: string, branch?: string) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (BuildComparisonPanel.currentPanel) {
            BuildComparisonPanel.currentPanel._panel.reveal(column);
            if (appId) BuildComparisonPanel.currentPanel._currentAppId = appId;
            if (branch) BuildComparisonPanel.currentPanel._currentBranch = branch;
            BuildComparisonPanel.currentPanel._loadBuilds();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'buildComparison',
            'Build Comparison',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        BuildComparisonPanel.currentPanel = new BuildComparisonPanel(panel, extensionUri, cli, appId, branch);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, cli: AmplifyMonitorCli, appId?: string, branch?: string) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._cli = cli;
        this._currentAppId = appId || '';
        this._currentBranch = branch || '';

        this._update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'loadApps':
                        await this._loadApps();
                        break;
                    case 'loadBranches':
                        await this._loadBranches(message.appId);
                        break;
                    case 'loadBuilds':
                        this._currentAppId = message.appId;
                        this._currentBranch = message.branch;
                        await this._loadBuilds();
                        break;
                    case 'compare':
                        await this._compareBuilds(message.jobId1, message.jobId2);
                        break;
                    case 'viewLogs':
                        this._viewLogs(message.jobId);
                        break;
                    case 'openInConsole':
                        this._openInConsole(message.jobId);
                        break;
                }
            },
            null,
            this._disposables
        );

        this._loadApps();
    }

    public dispose() {
        BuildComparisonPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private async _update() {
        this._panel.webview.html = this._getHtmlContent();
    }

    private async _loadApps() {
        try {
            const apps = await this._cli.listApps(true);
            this._panel.webview.postMessage({
                command: 'appsLoaded',
                apps: apps.map((a: any) => ({ id: a.appId, name: a.name })),
                currentAppId: this._currentAppId
            });
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'error',
                error: `Failed to load apps: ${error}`
            });
        }
    }

    private async _loadBranches(appId: string) {
        try {
            const branches = await this._cli.listBranches(appId);
            this._panel.webview.postMessage({
                command: 'branchesLoaded',
                branches: branches.map((b: any) => b.branchName),
                currentBranch: this._currentBranch
            });
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'error',
                error: `Failed to load branches: ${error}`
            });
        }
    }

    private async _loadBuilds() {
        if (!this._currentAppId || !this._currentBranch) {
            return;
        }

        try {
            const jobs = await this._cli.listJobs(this._currentAppId, this._currentBranch);
            
            const builds: BuildInfo[] = jobs.slice(0, 20).map((j: any) => ({
                jobId: j.jobId,
                branchName: j.branchName,
                status: j.status,
                startTime: j.startTime,
                endTime: j.endTime,
                duration: j.endTime ? 
                    Math.round((new Date(j.endTime).getTime() - new Date(j.startTime).getTime()) / 1000) : 
                    undefined,
                commitId: j.commitId?.substring(0, 7),
                commitMessage: j.commitMessage?.substring(0, 50)
            }));

            this._panel.webview.postMessage({
                command: 'buildsLoaded',
                builds
            });
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'error',
                error: `Failed to load builds: ${error}`
            });
        }
    }

    private async _compareBuilds(jobId1: string, jobId2: string) {
        this._panel.webview.postMessage({ command: 'comparing' });

        try {
            // Get job details from the builds list
            const jobs = await this._cli.listJobs(this._currentAppId, this._currentBranch);
            const job1 = jobs.find((j: any) => j.jobId === jobId1);
            const job2 = jobs.find((j: any) => j.jobId === jobId2);

            if (!job1 || !job2) {
                throw new Error('Could not find job details');
            }

            // Try to get diagnosis for both builds (which includes log analysis)
            let diagnosis1: any = null;
            let diagnosis2: any = null;
            
            try {
                diagnosis1 = await this._cli.diagnose(this._currentAppId, this._currentBranch, jobId1);
            } catch { /* Diagnosis may fail for old builds */ }
            
            try {
                diagnosis2 = await this._cli.diagnose(this._currentAppId, this._currentBranch, jobId2);
            } catch { /* Diagnosis may fail for old builds */ }

            // Build comparison result
            const comparison: BuildComparison = {
                build1: {
                    jobId: jobId1,
                    branchName: this._currentBranch,
                    status: job1.status,
                    startTime: job1.startTime,
                    endTime: job1.endTime,
                    duration: job1.endTime && job1.startTime ? 
                        Math.round((new Date(job1.endTime).getTime() - new Date(job1.startTime).getTime()) / 1000) : 
                        undefined
                },
                build2: {
                    jobId: jobId2,
                    branchName: this._currentBranch,
                    status: job2.status,
                    startTime: job2.startTime,
                    endTime: job2.endTime,
                    duration: job2.endTime && job2.startTime ? 
                        Math.round((new Date(job2.endTime).getTime() - new Date(job2.startTime).getTime()) / 1000) : 
                        undefined
                },
                differences: []
            };

            // Compare build metadata
            const metaDiffs: ComparisonItem[] = [];
            
            if (comparison.build1.status !== comparison.build2.status) {
                metaDiffs.push({
                    type: 'changed',
                    label: 'Status',
                    build1Value: comparison.build1.status,
                    build2Value: comparison.build2.status
                });
            } else {
                metaDiffs.push({
                    type: 'same',
                    label: 'Status',
                    build1Value: comparison.build1.status,
                    build2Value: comparison.build2.status
                });
            }

            if (comparison.build1.duration && comparison.build2.duration) {
                const durationDiff = comparison.build2.duration - comparison.build1.duration;
                const durationChange = durationDiff > 0 ? `+${durationDiff}s slower` : `${Math.abs(durationDiff)}s faster`;
                metaDiffs.push({
                    type: durationDiff !== 0 ? 'changed' : 'same',
                    label: 'Duration',
                    build1Value: this._formatDuration(comparison.build1.duration),
                    build2Value: `${this._formatDuration(comparison.build2.duration)} (${durationChange})`
                });
            }

            if (comparison.build1.commitId !== comparison.build2.commitId) {
                metaDiffs.push({
                    type: 'changed',
                    label: 'Commit',
                    build1Value: `${comparison.build1.commitId || 'N/A'} - ${comparison.build1.commitMessage || ''}`,
                    build2Value: `${comparison.build2.commitId || 'N/A'} - ${comparison.build2.commitMessage || ''}`
                });
            }

            comparison.differences.push({
                category: 'Build Metadata',
                items: metaDiffs
            });

            // Compare issues from diagnosis
            if (diagnosis1 || diagnosis2) {
                const issueDiffs: ComparisonItem[] = [];
                
                const issues1 = diagnosis1?.issues || [];
                const issues2 = diagnosis2?.issues || [];
                
                const patterns1 = new Set(issues1.map((i: any) => i.pattern));
                const patterns2 = new Set(issues2.map((i: any) => i.pattern));

                // Find new issues in build 2
                for (const issue of issues2) {
                    if (!patterns1.has(issue.pattern)) {
                        issueDiffs.push({
                            type: 'added',
                            label: 'New Issue',
                            build2Value: `${issue.pattern}: ${issue.rootCause}`
                        });
                    }
                }

                // Find issues fixed in build 2
                for (const issue of issues1) {
                    if (!patterns2.has(issue.pattern)) {
                        issueDiffs.push({
                            type: 'removed',
                            label: 'Fixed Issue',
                            build1Value: `${issue.pattern}: ${issue.rootCause}`
                        });
                    }
                }

                // Show issue count change
                if (issues1.length !== issues2.length) {
                    issueDiffs.push({
                        type: 'changed',
                        label: 'Issue Count',
                        build1Value: `${issues1.length} issues`,
                        build2Value: `${issues2.length} issues (${issues2.length > issues1.length ? '+' : ''}${issues2.length - issues1.length})`
                    });
                }

                if (issueDiffs.length > 0) {
                    comparison.differences.push({
                        category: 'Issue Analysis',
                        items: issueDiffs
                    });
                }
            }

            this._panel.webview.postMessage({
                command: 'comparisonComplete',
                comparison
            });
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'error',
                error: `Failed to compare builds: ${error}`
            });
        }
    }

    private _formatDuration(seconds: number): string {
        if (seconds < 60) {
            return `${seconds}s`;
        }
        const minutes = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${minutes}m ${secs}s`;
    }

    private _viewLogs(jobId: string) {
        vscode.commands.executeCommand('amplify-monitor.diagnoseJob', this._currentAppId, this._currentBranch, jobId);
    }

    private _openInConsole(jobId: string) {
        const region = vscode.workspace.getConfiguration('amplifyMonitor').get<string>('defaultRegion') || 'us-east-1';
        const url = `https://${region}.console.aws.amazon.com/amplify/home?region=${region}#/${this._currentAppId}/${this._currentBranch}/${jobId}`;
        vscode.env.openExternal(vscode.Uri.parse(url));
    }

    private _getHtmlContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Build Comparison</title>
    <style>
        :root {
            --bg-color: var(--vscode-editor-background);
            --text-color: var(--vscode-editor-foreground);
            --border-color: var(--vscode-panel-border);
            --card-bg: var(--vscode-editorWidget-background);
            --input-bg: var(--vscode-input-background);
            --input-fg: var(--vscode-input-foreground);
            --btn-bg: var(--vscode-button-background);
            --btn-fg: var(--vscode-button-foreground);
            --success: #4caf50;
            --warning: #ff9800;
            --error: #f44336;
            --info: #2196f3;
            --added: #4caf50;
            --removed: #f44336;
            --changed: #ff9800;
        }
        
        * { box-sizing: border-box; }
        
        body {
            font-family: var(--vscode-font-family);
            color: var(--text-color);
            background: var(--bg-color);
            padding: 20px;
            margin: 0;
        }
        
        h1, h2, h3 { margin-top: 0; }
        
        .header {
            margin-bottom: 24px;
        }
        
        .subtitle { color: var(--vscode-descriptionForeground); margin: 8px 0 0 0; }
        
        .selectors {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 16px;
            margin-bottom: 24px;
        }
        
        .form-group label {
            display: block;
            margin-bottom: 6px;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        
        .form-group select {
            width: 100%;
            padding: 8px 12px;
            border: 1px solid var(--border-color);
            border-radius: 4px;
            background: var(--input-bg);
            color: var(--input-fg);
            font-size: 13px;
        }
        
        button {
            background: var(--btn-bg);
            color: var(--btn-fg);
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            display: inline-flex;
            align-items: center;
            gap: 6px;
        }
        
        button:hover { opacity: 0.9; }
        button:disabled { opacity: 0.5; cursor: not-allowed; }
        button.secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        
        .builds-section {
            display: grid;
            grid-template-columns: 1fr auto 1fr;
            gap: 16px;
            margin-bottom: 24px;
        }
        
        .build-list {
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 16px;
            max-height: 400px;
            overflow-y: auto;
        }
        
        .build-list h3 {
            margin-bottom: 12px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .build-item {
            padding: 12px;
            border: 1px solid var(--border-color);
            border-radius: 6px;
            margin-bottom: 8px;
            cursor: pointer;
            transition: all 0.2s;
        }
        
        .build-item:hover {
            border-color: var(--vscode-focusBorder);
        }
        
        .build-item.selected {
            border-color: var(--info);
            background: rgba(33, 150, 243, 0.1);
        }
        
        .build-item .job-id {
            font-weight: 600;
            font-family: var(--vscode-editor-font-family);
        }
        
        .build-item .meta {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
        }
        
        .status-badge {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 10px;
            font-size: 10px;
            font-weight: 500;
        }
        
        .status-badge.SUCCEED { background: var(--success); color: white; }
        .status-badge.FAILED { background: var(--error); color: white; }
        .status-badge.RUNNING { background: var(--info); color: white; }
        .status-badge.PENDING { background: var(--warning); color: black; }
        .status-badge.CANCELLED { background: var(--border-color); color: var(--text-color); }
        
        .compare-arrow {
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 24px;
            color: var(--vscode-descriptionForeground);
        }
        
        .compare-btn-container {
            text-align: center;
            margin-bottom: 24px;
        }
        
        .comparison-results {
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 20px;
        }
        
        .comparison-header {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 16px;
            margin-bottom: 24px;
            padding-bottom: 16px;
            border-bottom: 1px solid var(--border-color);
        }
        
        .comparison-build {
            padding: 12px;
            background: var(--input-bg);
            border-radius: 6px;
        }
        
        .comparison-build h4 { margin: 0 0 8px 0; }
        
        .diff-category {
            margin-bottom: 20px;
        }
        
        .diff-category h4 {
            margin: 0 0 12px 0;
            padding-bottom: 8px;
            border-bottom: 1px solid var(--border-color);
        }
        
        .diff-item {
            display: grid;
            grid-template-columns: 120px 1fr 1fr;
            gap: 12px;
            padding: 8px 0;
            border-bottom: 1px solid var(--border-color);
            font-size: 13px;
        }
        
        .diff-item:last-child { border-bottom: none; }
        
        .diff-label {
            font-weight: 500;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        
        .diff-value {
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
            word-break: break-word;
        }
        
        .diff-type-added { color: var(--added); }
        .diff-type-removed { color: var(--removed); text-decoration: line-through; opacity: 0.7; }
        .diff-type-changed .diff-value:first-of-type { color: var(--removed); }
        .diff-type-changed .diff-value:last-of-type { color: var(--added); }
        
        .type-indicator {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            display: inline-block;
        }
        
        .type-indicator.added { background: var(--added); }
        .type-indicator.removed { background: var(--removed); }
        .type-indicator.changed { background: var(--changed); }
        .type-indicator.same { background: var(--border-color); }
        
        .loading {
            text-align: center;
            padding: 40px;
            color: var(--vscode-descriptionForeground);
        }
        
        .spinner {
            display: inline-block;
            width: 24px;
            height: 24px;
            border: 2px solid var(--border-color);
            border-top-color: var(--vscode-focusBorder);
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        
        @keyframes spin { to { transform: rotate(360deg); } }
        
        .empty-state {
            text-align: center;
            padding: 40px;
            color: var(--vscode-descriptionForeground);
        }
        
        .summary-bar {
            display: flex;
            gap: 16px;
            margin-bottom: 16px;
            flex-wrap: wrap;
        }
        
        .summary-item {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 12px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>🔄 Build Comparison</h1>
        <p class="subtitle">Compare two builds to see what changed between them</p>
    </div>
    
    <div class="selectors">
        <div class="form-group">
            <label>App</label>
            <select id="app-select" onchange="onAppChange()">
                <option value="">Select an app...</option>
            </select>
        </div>
        <div class="form-group">
            <label>Branch</label>
            <select id="branch-select" onchange="onBranchChange()" disabled>
                <option value="">Select a branch...</option>
            </select>
        </div>
    </div>
    
    <div id="builds-container" style="display: none;">
        <div class="builds-section">
            <div class="build-list">
                <h3>📋 Build 1 (Older)</h3>
                <div id="builds-list-1"></div>
            </div>
            <div class="compare-arrow">→</div>
            <div class="build-list">
                <h3>📋 Build 2 (Newer)</h3>
                <div id="builds-list-2"></div>
            </div>
        </div>
        
        <div class="compare-btn-container">
            <button id="compare-btn" onclick="compareBuilds()" disabled>🔍 Compare Selected Builds</button>
        </div>
    </div>
    
    <div id="comparison-results"></div>
    
    <script>
        const vscode = acquireVsCodeApi();
        let builds = [];
        let selectedBuild1 = null;
        let selectedBuild2 = null;
        
        function onAppChange() {
            const appId = document.getElementById('app-select').value;
            const branchSelect = document.getElementById('branch-select');
            
            if (appId) {
                branchSelect.disabled = false;
                vscode.postMessage({ command: 'loadBranches', appId });
            } else {
                branchSelect.disabled = true;
                branchSelect.innerHTML = '<option value="">Select a branch...</option>';
                document.getElementById('builds-container').style.display = 'none';
            }
        }
        
        function onBranchChange() {
            const appId = document.getElementById('app-select').value;
            const branch = document.getElementById('branch-select').value;
            
            if (appId && branch) {
                vscode.postMessage({ command: 'loadBuilds', appId, branch });
            } else {
                document.getElementById('builds-container').style.display = 'none';
            }
        }
        
        function selectBuild(listNum, jobId) {
            if (listNum === 1) {
                selectedBuild1 = selectedBuild1 === jobId ? null : jobId;
            } else {
                selectedBuild2 = selectedBuild2 === jobId ? null : jobId;
            }
            
            renderBuilds();
            updateCompareButton();
        }
        
        function renderBuilds() {
            const list1 = document.getElementById('builds-list-1');
            const list2 = document.getElementById('builds-list-2');
            
            list1.innerHTML = builds.map(b => \`
                <div class="build-item \${selectedBuild1 === b.jobId ? 'selected' : ''}" onclick="selectBuild(1, '\${b.jobId}')">
                    <div class="job-id">#\${b.jobId}</div>
                    <span class="status-badge \${b.status}">\${b.status}</span>
                    <div class="meta">
                        \${b.commitId ? \`📝 \${b.commitId}\` : ''} 
                        \${b.duration ? \`⏱️ \${formatDuration(b.duration)}\` : ''}
                        <br>\${new Date(b.startTime).toLocaleString()}
                    </div>
                </div>
            \`).join('');
            
            list2.innerHTML = builds.map(b => \`
                <div class="build-item \${selectedBuild2 === b.jobId ? 'selected' : ''}" onclick="selectBuild(2, '\${b.jobId}')">
                    <div class="job-id">#\${b.jobId}</div>
                    <span class="status-badge \${b.status}">\${b.status}</span>
                    <div class="meta">
                        \${b.commitId ? \`📝 \${b.commitId}\` : ''} 
                        \${b.duration ? \`⏱️ \${formatDuration(b.duration)}\` : ''}
                        <br>\${new Date(b.startTime).toLocaleString()}
                    </div>
                </div>
            \`).join('');
        }
        
        function formatDuration(seconds) {
            if (seconds < 60) return \`\${seconds}s\`;
            const m = Math.floor(seconds / 60);
            const s = seconds % 60;
            return \`\${m}m \${s}s\`;
        }
        
        function updateCompareButton() {
            const btn = document.getElementById('compare-btn');
            btn.disabled = !selectedBuild1 || !selectedBuild2 || selectedBuild1 === selectedBuild2;
        }
        
        function compareBuilds() {
            if (selectedBuild1 && selectedBuild2) {
                vscode.postMessage({ command: 'compare', jobId1: selectedBuild1, jobId2: selectedBuild2 });
            }
        }
        
        function renderComparison(comparison) {
            const container = document.getElementById('comparison-results');
            
            const summaryItems = comparison.differences.flatMap(d => d.items);
            const added = summaryItems.filter(i => i.type === 'added').length;
            const removed = summaryItems.filter(i => i.type === 'removed').length;
            const changed = summaryItems.filter(i => i.type === 'changed').length;
            
            container.innerHTML = \`
                <div class="comparison-results">
                    <h3>📊 Comparison Results</h3>
                    
                    <div class="summary-bar">
                        <div class="summary-item"><span class="type-indicator added"></span> \${added} added</div>
                        <div class="summary-item"><span class="type-indicator removed"></span> \${removed} removed</div>
                        <div class="summary-item"><span class="type-indicator changed"></span> \${changed} changed</div>
                    </div>
                    
                    <div class="comparison-header">
                        <div class="comparison-build">
                            <h4>Build #\${comparison.build1.jobId}</h4>
                            <span class="status-badge \${comparison.build1.status}">\${comparison.build1.status}</span>
                            <div style="font-size: 12px; margin-top: 8px;">
                                \${new Date(comparison.build1.startTime).toLocaleString()}
                            </div>
                        </div>
                        <div class="comparison-build">
                            <h4>Build #\${comparison.build2.jobId}</h4>
                            <span class="status-badge \${comparison.build2.status}">\${comparison.build2.status}</span>
                            <div style="font-size: 12px; margin-top: 8px;">
                                \${new Date(comparison.build2.startTime).toLocaleString()}
                            </div>
                        </div>
                    </div>
                    
                    \${comparison.differences.map(diff => \`
                        <div class="diff-category">
                            <h4>\${diff.category}</h4>
                            \${diff.items.map(item => \`
                                <div class="diff-item diff-type-\${item.type}">
                                    <div class="diff-label">
                                        <span class="type-indicator \${item.type}"></span>
                                        \${item.label}
                                    </div>
                                    <div class="diff-value">\${item.build1Value || '-'}</div>
                                    <div class="diff-value">\${item.build2Value || '-'}</div>
                                </div>
                            \`).join('')}
                        </div>
                    \`).join('')}
                </div>
            \`;
        }
        
        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.command) {
                case 'appsLoaded':
                    const appSelect = document.getElementById('app-select');
                    appSelect.innerHTML = '<option value="">Select an app...</option>' +
                        message.apps.map(a => \`<option value="\${a.id}" \${a.id === message.currentAppId ? 'selected' : ''}>\${a.name}</option>\`).join('');
                    
                    if (message.currentAppId) {
                        vscode.postMessage({ command: 'loadBranches', appId: message.currentAppId });
                    }
                    break;
                    
                case 'branchesLoaded':
                    const branchSelect = document.getElementById('branch-select');
                    branchSelect.innerHTML = '<option value="">Select a branch...</option>' +
                        message.branches.map(b => \`<option value="\${b}" \${b === message.currentBranch ? 'selected' : ''}>\${b}</option>\`).join('');
                    branchSelect.disabled = false;
                    
                    if (message.currentBranch) {
                        onBranchChange();
                    }
                    break;
                    
                case 'buildsLoaded':
                    builds = message.builds;
                    selectedBuild1 = null;
                    selectedBuild2 = null;
                    document.getElementById('builds-container').style.display = 'block';
                    renderBuilds();
                    updateCompareButton();
                    document.getElementById('comparison-results').innerHTML = '';
                    break;
                    
                case 'comparing':
                    document.getElementById('comparison-results').innerHTML = \`
                        <div class="loading">
                            <div class="spinner"></div>
                            <p>Comparing builds...</p>
                        </div>
                    \`;
                    break;
                    
                case 'comparisonComplete':
                    renderComparison(message.comparison);
                    break;
                    
                case 'error':
                    document.getElementById('comparison-results').innerHTML = \`
                        <div class="empty-state">
                            <p>❌ \${message.error}</p>
                        </div>
                    \`;
                    break;
            }
        });
        
        // Initial load
        vscode.postMessage({ command: 'loadApps' });
    </script>
</body>
</html>`;
    }
}
