import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface FileInfo {
    path: string;
    size: number;
    sizeFormatted: string;
}

interface DirectoryInfo {
    name: string;
    path: string;
    size: number;
    sizeFormatted: string;
    files: FileInfo[];
    children: DirectoryInfo[];
    percentage: number;
}

interface BundleAnalysis {
    totalSize: number;
    totalSizeFormatted: string;
    exceededLimit: boolean;
    limit: number;
    limitFormatted: string;
    directories: DirectoryInfo[];
    largestFiles: FileInfo[];
    recommendations: string[];
}

const AMPLIFY_SIZE_LIMIT = 220 * 1024 * 1024; // 220MB (Amplify's limit is ~230MB, warn earlier)

export class BundleAnalyzerPanel {
    public static currentPanel: BundleAnalyzerPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(workspaceRoot: string, buildDir?: string) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (BundleAnalyzerPanel.currentPanel) {
            BundleAnalyzerPanel.currentPanel._panel.reveal(column);
            BundleAnalyzerPanel.currentPanel.analyze(workspaceRoot, buildDir);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'bundleAnalyzer',
            '📦 Bundle Analyzer',
            column || vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        BundleAnalyzerPanel.currentPanel = new BundleAnalyzerPanel(panel, workspaceRoot, buildDir);
    }

    private constructor(panel: vscode.WebviewPanel, workspaceRoot: string, buildDir?: string) {
        this._panel = panel;
        this._panel.webview.html = this._getLoadingHtml();

        this._panel.webview.onDidReceiveMessage(
            async message => {
                if (message.command === 'openFile') {
                    const uri = vscode.Uri.file(message.path);
                    vscode.commands.executeCommand('revealFileInOS', uri);
                } else if (message.command === 'refresh') {
                    this.analyze(workspaceRoot, buildDir);
                }
            },
            null,
            this._disposables
        );

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this.analyze(workspaceRoot, buildDir);
    }

    public async analyze(workspaceRoot: string, buildDir?: string) {
        this._panel.webview.html = this._getLoadingHtml();

        // Auto-detect build directory
        const possibleDirs = [
            buildDir,
            '.next',
            'dist',
            'build',
            'out',
            '.output',
            'public'
        ].filter(Boolean) as string[];

        let targetDir: string | undefined;
        for (const dir of possibleDirs) {
            const fullPath = path.join(workspaceRoot, dir);
            if (fs.existsSync(fullPath)) {
                targetDir = fullPath;
                break;
            }
        }

        if (!targetDir) {
            this._panel.webview.html = this._getErrorHtml('No build output directory found. Run your build first.');
            return;
        }

        try {
            const analysis = await this._analyzeBundleSize(targetDir);
            this._panel.webview.html = this._getAnalysisHtml(analysis, path.basename(targetDir));
        } catch (error) {
            this._panel.webview.html = this._getErrorHtml(`Analysis failed: ${error}`);
        }
    }

    private async _analyzeBundleSize(dir: string): Promise<BundleAnalysis> {
        const allFiles: FileInfo[] = [];
        const rootDir = this._analyzeDirectory(dir, allFiles);

        // Sort files by size
        allFiles.sort((a, b) => b.size - a.size);
        const largestFiles = allFiles.slice(0, 20);

        const totalSize = rootDir.size;
        const exceededLimit = totalSize > AMPLIFY_SIZE_LIMIT;

        // Generate recommendations
        const recommendations: string[] = [];

        if (exceededLimit) {
            recommendations.push('⚠️ Build output exceeds Amplify\'s 230MB limit! Reduce bundle size before deploying.');
        }

        // Check for common bloat
        const nodeModulesSize = allFiles
            .filter(f => f.path.includes('node_modules'))
            .reduce((sum, f) => sum + f.size, 0);
        
        if (nodeModulesSize > 50 * 1024 * 1024) {
            recommendations.push('📦 node_modules in build output is large. Consider excluding dev dependencies.');
        }

        const sourceMapSize = allFiles
            .filter(f => f.path.endsWith('.map'))
            .reduce((sum, f) => sum + f.size, 0);
        
        if (sourceMapSize > 10 * 1024 * 1024) {
            recommendations.push('🗺️ Source maps are ' + this._formatSize(sourceMapSize) + '. Consider disabling in production.');
        }

        const imageSize = allFiles
            .filter(f => /\.(png|jpg|jpeg|gif|svg|webp|ico)$/i.test(f.path))
            .reduce((sum, f) => sum + f.size, 0);
        
        if (imageSize > 20 * 1024 * 1024) {
            recommendations.push('🖼️ Images are ' + this._formatSize(imageSize) + '. Consider using next/image or optimizing.');
        }

        // Check for large individual files
        const hugeFiles = largestFiles.filter(f => f.size > 5 * 1024 * 1024);
        if (hugeFiles.length > 0) {
            recommendations.push(`📁 ${hugeFiles.length} file(s) over 5MB. Consider code splitting or lazy loading.`);
        }

        if (recommendations.length === 0) {
            recommendations.push('✅ Bundle size looks healthy!');
        }

        return {
            totalSize,
            totalSizeFormatted: this._formatSize(totalSize),
            exceededLimit,
            limit: AMPLIFY_SIZE_LIMIT,
            limitFormatted: this._formatSize(AMPLIFY_SIZE_LIMIT),
            directories: rootDir.children,
            largestFiles,
            recommendations
        };
    }

    private _analyzeDirectory(dir: string, allFiles: FileInfo[]): DirectoryInfo {
        const stats = fs.statSync(dir);
        const name = path.basename(dir);
        
        if (!stats.isDirectory()) {
            const fileInfo: FileInfo = {
                path: dir,
                size: stats.size,
                sizeFormatted: this._formatSize(stats.size)
            };
            allFiles.push(fileInfo);
            return {
                name,
                path: dir,
                size: stats.size,
                sizeFormatted: this._formatSize(stats.size),
                files: [fileInfo],
                children: [],
                percentage: 0
            };
        }

        const entries = fs.readdirSync(dir);
        const children: DirectoryInfo[] = [];
        const files: FileInfo[] = [];
        let totalSize = 0;

        for (const entry of entries) {
            const fullPath = path.join(dir, entry);
            try {
                const entryStats = fs.statSync(fullPath);
                if (entryStats.isDirectory()) {
                    const child = this._analyzeDirectory(fullPath, allFiles);
                    children.push(child);
                    totalSize += child.size;
                } else {
                    const fileInfo: FileInfo = {
                        path: fullPath,
                        size: entryStats.size,
                        sizeFormatted: this._formatSize(entryStats.size)
                    };
                    files.push(fileInfo);
                    allFiles.push(fileInfo);
                    totalSize += entryStats.size;
                }
            } catch {
                // Skip files we can't access
            }
        }

        // Sort children by size
        children.sort((a, b) => b.size - a.size);
        files.sort((a, b) => b.size - a.size);

        return {
            name,
            path: dir,
            size: totalSize,
            sizeFormatted: this._formatSize(totalSize),
            files: files.slice(0, 10), // Top 10 files in this dir
            children: children.slice(0, 15), // Top 15 subdirs
            percentage: 0
        };
    }

    private _formatSize(bytes: number): string {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
        return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }

    private _getLoadingHtml(): string {
        return `<!DOCTYPE html>
        <html><head><style>
            body { font-family: var(--vscode-font-family); padding: 20px; display: flex; justify-content: center; align-items: center; height: 100vh; }
            .loader { border: 4px solid var(--vscode-editor-background); border-top: 4px solid var(--vscode-button-background); border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        </style></head>
        <body><div class="loader"></div><span style="margin-left:15px">Analyzing bundle size...</span></body></html>`;
    }

    private _getErrorHtml(error: string): string {
        return `<!DOCTYPE html>
        <html><head><style>
            body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); }
            .error { color: var(--vscode-errorForeground); }
        </style></head>
        <body><h2>⚠️ Bundle Analysis Error</h2><p class="error">${error}</p></body></html>`;
    }

    private _getAnalysisHtml(analysis: BundleAnalysis, dirName: string): string {
        const usagePercent = Math.min(100, (analysis.totalSize / analysis.limit) * 100);
        const barColor = analysis.exceededLimit ? '#f44336' : usagePercent > 80 ? '#ff9800' : '#4caf50';

        const dirRows = analysis.directories.map(d => {
            const pct = ((d.size / analysis.totalSize) * 100).toFixed(1);
            return `<tr class="dir-row" onclick="toggleDir('${d.name}')">
                <td><span class="icon">📁</span> ${d.name}</td>
                <td>${d.sizeFormatted}</td>
                <td><div class="bar" style="width:${pct}%;background:var(--vscode-button-background)"></div> ${pct}%</td>
            </tr>`;
        }).join('');

        const fileRows = analysis.largestFiles.map(f => {
            const name = path.basename(f.path);
            const dir = path.dirname(f.path).split(path.sep).slice(-2).join('/');
            return `<tr>
                <td title="${f.path}"><span class="icon">📄</span> ${name}<span class="dir-hint">${dir}</span></td>
                <td>${f.sizeFormatted}</td>
            </tr>`;
        }).join('');

        const recommendations = analysis.recommendations.map(r => `<li>${r}</li>`).join('');

        return `<!DOCTYPE html>
        <html><head><style>
            * { box-sizing: border-box; }
            body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); max-width: 1200px; margin: 0 auto; }
            .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
            h1 { margin: 0; font-size: 24px; }
            .btn { padding: 8px 16px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; border-radius: 4px; }
            .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
            .card { background: var(--vscode-sideBar-background); border-radius: 8px; padding: 16px; border: 1px solid var(--vscode-panel-border); }
            .card h3 { margin: 0 0 8px 0; font-size: 14px; opacity: 0.8; }
            .card .value { font-size: 28px; font-weight: bold; }
            .card .value.danger { color: #f44336; }
            .card .value.warning { color: #ff9800; }
            .card .value.success { color: #4caf50; }
            .usage-bar { height: 20px; background: var(--vscode-input-background); border-radius: 10px; overflow: hidden; margin: 8px 0; }
            .usage-fill { height: 100%; transition: width 0.3s; }
            table { width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 13px; }
            th { text-align: left; padding: 10px; border-bottom: 2px solid var(--vscode-panel-border); }
            td { padding: 8px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
            tr:hover { background: var(--vscode-list-hoverBackground); }
            .icon { margin-right: 6px; }
            .bar { height: 8px; border-radius: 4px; display: inline-block; margin-right: 8px; min-width: 2px; }
            .dir-hint { color: var(--vscode-descriptionForeground); font-size: 11px; margin-left: 8px; }
            .recommendations { background: var(--vscode-sideBar-background); border-radius: 8px; padding: 16px; border: 1px solid var(--vscode-panel-border); }
            .recommendations h3 { margin: 0 0 12px 0; }
            .recommendations ul { margin: 0; padding-left: 20px; }
            .recommendations li { margin: 8px 0; }
            .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
            @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
        </style></head>
        <body>
            <div class="header">
                <h1>📦 Bundle Analysis: ${dirName}</h1>
                <button class="btn" onclick="refresh()">🔄 Refresh</button>
            </div>

            <div class="summary">
                <div class="card">
                    <h3>Total Size</h3>
                    <div class="value ${analysis.exceededLimit ? 'danger' : usagePercent > 80 ? 'warning' : 'success'}">${analysis.totalSizeFormatted}</div>
                    <div class="usage-bar">
                        <div class="usage-fill" style="width:${usagePercent}%;background:${barColor}"></div>
                    </div>
                    <small>${usagePercent.toFixed(1)}% of ${analysis.limitFormatted} limit</small>
                </div>
                <div class="card">
                    <h3>Status</h3>
                    <div class="value ${analysis.exceededLimit ? 'danger' : 'success'}">
                        ${analysis.exceededLimit ? '❌ Over Limit' : '✅ Within Limit'}
                    </div>
                </div>
                <div class="card">
                    <h3>Directories</h3>
                    <div class="value">${analysis.directories.length}</div>
                </div>
                <div class="card">
                    <h3>Files Analyzed</h3>
                    <div class="value">${analysis.largestFiles.length}+</div>
                </div>
            </div>

            <div class="recommendations">
                <h3>💡 Recommendations</h3>
                <ul>${recommendations}</ul>
            </div>

            <div class="grid" style="margin-top:24px">
                <div>
                    <h2>📁 Largest Directories</h2>
                    <table>
                        <thead><tr><th>Directory</th><th>Size</th><th>% of Total</th></tr></thead>
                        <tbody>${dirRows}</tbody>
                    </table>
                </div>
                <div>
                    <h2>📄 Largest Files</h2>
                    <table>
                        <thead><tr><th>File</th><th>Size</th></tr></thead>
                        <tbody>${fileRows}</tbody>
                    </table>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                function refresh() { vscode.postMessage({ command: 'refresh' }); }
                function openFile(path) { vscode.postMessage({ command: 'openFile', path }); }
            </script>
        </body></html>`;
    }

    public dispose() {
        BundleAnalyzerPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }
}
