import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface MonorepoInfo {
    isMonorepo: boolean;
    type: 'turborepo' | 'nx' | 'lerna' | 'pnpm-workspaces' | 'yarn-workspaces' | 'npm-workspaces' | 'unknown' | 'none';
    workspaces: WorkspaceInfo[];
    rootPackageManager: 'npm' | 'pnpm' | 'yarn' | 'unknown';
    hasLockFile: boolean;
    lockFileType?: string;
    configFiles: string[];
    recommendations: string[];
    amplifyYmlSuggestion?: string;
}

export interface WorkspaceInfo {
    name: string;
    path: string;
    hasPackageJson: boolean;
    hasBuildScript: boolean;
    framework?: string;
}

export class MonorepoDetector {
    constructor(private workspaceRoot: string) {}

    public async detect(): Promise<MonorepoInfo> {
        const configFiles: string[] = [];
        const recommendations: string[] = [];

        // Check for monorepo tools
        const hasTurboJson = this._fileExists('turbo.json');
        const hasNxJson = this._fileExists('nx.json');
        const hasLernaJson = this._fileExists('lerna.json');
        const hasPnpmWorkspace = this._fileExists('pnpm-workspace.yaml');
        
        if (hasTurboJson) configFiles.push('turbo.json');
        if (hasNxJson) configFiles.push('nx.json');
        if (hasLernaJson) configFiles.push('lerna.json');
        if (hasPnpmWorkspace) configFiles.push('pnpm-workspace.yaml');

        // Check package.json for workspaces
        const packageJson = this._readJson('package.json');
        const hasWorkspacesField = packageJson?.workspaces !== undefined;
        
        // Detect package manager
        const hasPackageLock = this._fileExists('package-lock.json');
        const hasPnpmLock = this._fileExists('pnpm-lock.yaml');
        const hasYarnLock = this._fileExists('yarn.lock');

        let rootPackageManager: 'npm' | 'pnpm' | 'yarn' | 'unknown' = 'unknown';
        let lockFileType: string | undefined;
        
        if (hasPnpmLock) {
            rootPackageManager = 'pnpm';
            lockFileType = 'pnpm-lock.yaml';
        } else if (hasYarnLock) {
            rootPackageManager = 'yarn';
            lockFileType = 'yarn.lock';
        } else if (hasPackageLock) {
            rootPackageManager = 'npm';
            lockFileType = 'package-lock.json';
        }

        // Determine monorepo type
        let type: MonorepoInfo['type'] = 'none';
        let isMonorepo = false;

        if (hasTurboJson) {
            type = 'turborepo';
            isMonorepo = true;
        } else if (hasNxJson) {
            type = 'nx';
            isMonorepo = true;
        } else if (hasLernaJson) {
            type = 'lerna';
            isMonorepo = true;
        } else if (hasPnpmWorkspace) {
            type = 'pnpm-workspaces';
            isMonorepo = true;
        } else if (hasWorkspacesField && rootPackageManager === 'yarn') {
            type = 'yarn-workspaces';
            isMonorepo = true;
        } else if (hasWorkspacesField) {
            type = 'npm-workspaces';
            isMonorepo = true;
        }

        // Detect workspaces
        const workspaces = await this._detectWorkspaces(packageJson, hasPnpmWorkspace);

        // Generate recommendations
        if (isMonorepo) {
            if (type === 'turborepo') {
                recommendations.push('🚀 TurboRepo detected! Use `turbo run build --filter=<app>` in amplify.yml');
                if (rootPackageManager === 'pnpm') {
                    recommendations.push('📦 Using pnpm with TurboRepo - ensure corepack is enabled in preBuild');
                }
            }

            if (type === 'nx') {
                recommendations.push('🔷 Nx detected! Use `npx nx build <app>` in amplify.yml');
            }

            if (workspaces.length > 0) {
                recommendations.push(`📁 Found ${workspaces.length} workspace(s). Set APP_ROOT env var to target specific app.`);
            }

            if (rootPackageManager === 'pnpm' && !this._fileExists('.npmrc')) {
                recommendations.push('⚠️ Create .npmrc with `node-linker=hoisted` for Amplify compatibility');
            }

            // Check for common issues
            if (hasPnpmLock && hasPackageLock) {
                recommendations.push('❌ Multiple lock files detected! Remove package-lock.json when using pnpm.');
            }

            if (hasYarnLock && hasPackageLock) {
                recommendations.push('❌ Multiple lock files detected! Keep only one lock file.');
            }
        }

        // Generate amplify.yml suggestion
        const amplifyYmlSuggestion = this._generateAmplifyYml(type, rootPackageManager, workspaces);

        return {
            isMonorepo,
            type,
            workspaces,
            rootPackageManager,
            hasLockFile: hasPackageLock || hasPnpmLock || hasYarnLock,
            lockFileType,
            configFiles,
            recommendations,
            amplifyYmlSuggestion
        };
    }

    private _fileExists(relativePath: string): boolean {
        return fs.existsSync(path.join(this.workspaceRoot, relativePath));
    }

    private _readJson(relativePath: string): Record<string, unknown> | null {
        try {
            const content = fs.readFileSync(path.join(this.workspaceRoot, relativePath), 'utf8');
            return JSON.parse(content);
        } catch {
            return null;
        }
    }

    private _readYaml(relativePath: string): string | null {
        try {
            return fs.readFileSync(path.join(this.workspaceRoot, relativePath), 'utf8');
        } catch {
            return null;
        }
    }

    private async _detectWorkspaces(packageJson: Record<string, unknown> | null, hasPnpmWorkspace: boolean): Promise<WorkspaceInfo[]> {
        const workspaces: WorkspaceInfo[] = [];
        let patterns: string[] = [];

        // Get workspace patterns
        if (packageJson?.workspaces) {
            const ws = packageJson.workspaces;
            if (Array.isArray(ws)) {
                patterns = ws;
            } else if (typeof ws === 'object' && ws !== null && 'packages' in ws) {
                patterns = (ws as { packages: string[] }).packages;
            }
        }

        if (hasPnpmWorkspace) {
            const yaml = this._readYaml('pnpm-workspace.yaml');
            if (yaml) {
                // Simple YAML parsing for packages
                const match = yaml.match(/packages:\s*\n((?:\s*-\s*.+\n?)+)/);
                if (match) {
                    patterns = match[1].split('\n')
                        .map(line => line.replace(/^\s*-\s*['"]?/, '').replace(/['"]?\s*$/, ''))
                        .filter(p => p.length > 0);
                }
            }
        }

        // Expand patterns and find workspaces
        for (const pattern of patterns) {
            const basePath = pattern.replace(/\/\*$/, '').replace(/\*$/, '');
            const fullBasePath = path.join(this.workspaceRoot, basePath);

            if (fs.existsSync(fullBasePath) && fs.statSync(fullBasePath).isDirectory()) {
                const entries = fs.readdirSync(fullBasePath);
                for (const entry of entries) {
                    const entryPath = path.join(fullBasePath, entry);
                    const pkgJsonPath = path.join(entryPath, 'package.json');
                    
                    if (fs.existsSync(pkgJsonPath)) {
                        const pkgJson = this._readJson(path.join(basePath, entry, 'package.json'));
                        const scripts = pkgJson?.scripts as Record<string, string> | undefined;
                        
                        let framework: string | undefined;
                        const deps = { ...(pkgJson?.dependencies || {}), ...(pkgJson?.devDependencies || {}) } as Record<string, string>;
                        
                        if (deps['next']) framework = 'Next.js';
                        else if (deps['vite']) framework = 'Vite';
                        else if (deps['@angular/core']) framework = 'Angular';
                        else if (deps['vue']) framework = 'Vue';
                        else if (deps['react']) framework = 'React';

                        workspaces.push({
                            name: (pkgJson?.name as string) || entry,
                            path: path.join(basePath, entry),
                            hasPackageJson: true,
                            hasBuildScript: !!scripts?.build,
                            framework
                        });
                    }
                }
            }
        }

        return workspaces;
    }

    private _generateAmplifyYml(
        type: MonorepoInfo['type'],
        packageManager: 'npm' | 'pnpm' | 'yarn' | 'unknown',
        workspaces: WorkspaceInfo[]
    ): string {
        const app = workspaces.find(w => w.hasBuildScript) || workspaces[0];
        const appPath = app?.path || 'apps/web';
        const appName = app?.name || 'web';

        let installCmd = 'npm ci';
        let buildCmd = 'npm run build';
        let preBuildCmds: string[] = [];

        switch (packageManager) {
            case 'pnpm':
                preBuildCmds.push('corepack enable');
                preBuildCmds.push('corepack prepare pnpm@latest --activate');
                installCmd = 'pnpm install --frozen-lockfile';
                break;
            case 'yarn':
                installCmd = 'yarn install --frozen-lockfile';
                break;
        }

        switch (type) {
            case 'turborepo':
                buildCmd = `npx turbo run build --filter=${appName}`;
                break;
            case 'nx':
                buildCmd = `npx nx build ${appName}`;
                break;
            case 'lerna':
                buildCmd = `npx lerna run build --scope=${appName}`;
                break;
            default:
                buildCmd = `cd ${appPath} && ${packageManager === 'pnpm' ? 'pnpm' : packageManager === 'yarn' ? 'yarn' : 'npm run'} build`;
        }

        const preBuildSection = preBuildCmds.length > 0 
            ? preBuildCmds.map(c => `        - ${c}`).join('\n') + '\n'
            : '';

        return `version: 1
applications:
  - appRoot: ${appPath}
    frontend:
      phases:
        preBuild:
          commands:
${preBuildSection}            - ${installCmd}
        build:
          commands:
            - ${buildCmd}
      artifacts:
        baseDirectory: ${app?.framework === 'Next.js' ? '.next' : 'dist'}
        files:
          - '**/*'
      cache:
        paths:
          - node_modules/**/*
          - ${app?.framework === 'Next.js' ? '.next/cache/**/*' : '.cache/**/*'}
`;
    }
}

export class MonorepoPanel {
    public static currentPanel: MonorepoPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    public static async createOrShow(workspaceRoot: string) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (MonorepoPanel.currentPanel) {
            MonorepoPanel.currentPanel._panel.reveal(column);
            await MonorepoPanel.currentPanel.refresh(workspaceRoot);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'monorepoDetector',
            '📦 Monorepo Detector',
            column || vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        MonorepoPanel.currentPanel = new MonorepoPanel(panel, workspaceRoot);
    }

    private constructor(panel: vscode.WebviewPanel, workspaceRoot: string) {
        this._panel = panel;
        this._panel.webview.html = this._getLoadingHtml();

        this._panel.webview.onDidReceiveMessage(
            async message => {
                if (message.command === 'refresh') {
                    await this.refresh(workspaceRoot);
                } else if (message.command === 'copyYaml') {
                    await vscode.env.clipboard.writeText(message.yaml);
                    vscode.window.showInformationMessage('amplify.yml copied to clipboard!');
                } else if (message.command === 'createYaml') {
                    const filePath = path.join(workspaceRoot, 'amplify.yml');
                    fs.writeFileSync(filePath, message.yaml);
                    const doc = await vscode.workspace.openTextDocument(filePath);
                    await vscode.window.showTextDocument(doc);
                    vscode.window.showInformationMessage('amplify.yml created!');
                }
            },
            null,
            this._disposables
        );

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this.refresh(workspaceRoot);
    }

    public async refresh(workspaceRoot: string) {
        this._panel.webview.html = this._getLoadingHtml();
        
        const detector = new MonorepoDetector(workspaceRoot);
        const info = await detector.detect();
        
        this._panel.webview.html = this._getHtml(info);
    }

    private _getLoadingHtml(): string {
        return `<!DOCTYPE html>
        <html><head><style>
            body { font-family: var(--vscode-font-family); padding: 20px; display: flex; justify-content: center; align-items: center; height: 100vh; }
            .loader { border: 4px solid var(--vscode-editor-background); border-top: 4px solid var(--vscode-button-background); border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        </style></head>
        <body><div class="loader"></div><span style="margin-left:15px">Analyzing project structure...</span></body></html>`;
    }

    private _getHtml(info: MonorepoInfo): string {
        const typeIcons: Record<string, string> = {
            'turborepo': '🚀',
            'nx': '🔷',
            'lerna': '🐉',
            'pnpm-workspaces': '📦',
            'yarn-workspaces': '🧶',
            'npm-workspaces': '📦',
            'unknown': '❓',
            'none': '📁'
        };

        const pmIcons: Record<string, string> = {
            'npm': '📦',
            'pnpm': '🟡',
            'yarn': '🧶',
            'unknown': '❓'
        };

        const workspaceRows = info.workspaces.map(w => `
            <tr>
                <td>${w.name}</td>
                <td><code>${w.path}</code></td>
                <td>${w.framework || '-'}</td>
                <td>${w.hasBuildScript ? '✅' : '❌'}</td>
            </tr>
        `).join('');

        const recommendations = info.recommendations.map(r => `<li>${r}</li>`).join('');
        const configFiles = info.configFiles.map(f => `<span class="badge">${f}</span>`).join(' ');

        const yamlEscaped = (info.amplifyYmlSuggestion || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        return `<!DOCTYPE html>
        <html><head><style>
            * { box-sizing: border-box; }
            body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); max-width: 1200px; margin: 0 auto; }
            .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
            h1 { margin: 0; font-size: 24px; }
            .btn { padding: 8px 16px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; border-radius: 4px; margin-left: 8px; }
            .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
            .card { background: var(--vscode-sideBar-background); border-radius: 8px; padding: 16px; border: 1px solid var(--vscode-panel-border); }
            .card h3 { margin: 0 0 8px 0; font-size: 14px; opacity: 0.8; }
            .card .value { font-size: 20px; font-weight: bold; }
            .badge { display: inline-block; padding: 2px 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 4px; font-size: 12px; margin: 2px; }
            table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 24px; }
            th { text-align: left; padding: 10px; border-bottom: 2px solid var(--vscode-panel-border); }
            td { padding: 8px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
            code { background: var(--vscode-textCodeBlock-background); padding: 2px 6px; border-radius: 4px; font-size: 12px; }
            .recommendations { background: var(--vscode-sideBar-background); border-radius: 8px; padding: 16px; border: 1px solid var(--vscode-panel-border); margin-bottom: 24px; }
            .recommendations ul { margin: 8px 0 0 0; padding-left: 20px; }
            .yaml-section { background: var(--vscode-sideBar-background); border-radius: 8px; padding: 16px; border: 1px solid var(--vscode-panel-border); }
            .yaml-section pre { background: var(--vscode-textCodeBlock-background); padding: 16px; border-radius: 4px; overflow-x: auto; font-size: 12px; }
            .yaml-actions { margin-top: 12px; }
            .not-monorepo { text-align: center; padding: 40px; }
            .not-monorepo h2 { margin-bottom: 8px; }
        </style></head>
        <body>
            <div class="header">
                <h1>📦 Monorepo Detection</h1>
                <button class="btn" onclick="refresh()">🔄 Refresh</button>
            </div>

            <div class="summary">
                <div class="card">
                    <h3>Project Type</h3>
                    <div class="value">${typeIcons[info.type]} ${info.isMonorepo ? info.type.replace('-', ' ') : 'Single Package'}</div>
                </div>
                <div class="card">
                    <h3>Package Manager</h3>
                    <div class="value">${pmIcons[info.rootPackageManager]} ${info.rootPackageManager}</div>
                    ${info.lockFileType ? `<div style="margin-top:4px;font-size:12px;opacity:0.7">${info.lockFileType}</div>` : ''}
                </div>
                <div class="card">
                    <h3>Workspaces</h3>
                    <div class="value">${info.workspaces.length}</div>
                </div>
                <div class="card">
                    <h3>Config Files</h3>
                    <div>${configFiles || '<span style="opacity:0.6">None detected</span>'}</div>
                </div>
            </div>

            ${info.recommendations.length > 0 ? `
                <div class="recommendations">
                    <h3>💡 Recommendations</h3>
                    <ul>${recommendations}</ul>
                </div>
            ` : ''}

            ${info.workspaces.length > 0 ? `
                <h2>📁 Detected Workspaces</h2>
                <table>
                    <thead><tr><th>Name</th><th>Path</th><th>Framework</th><th>Build Script</th></tr></thead>
                    <tbody>${workspaceRows}</tbody>
                </table>
            ` : ''}

            ${info.isMonorepo && info.amplifyYmlSuggestion ? `
                <div class="yaml-section">
                    <h3>📝 Suggested amplify.yml</h3>
                    <pre>${yamlEscaped}</pre>
                    <div class="yaml-actions">
                        <button class="btn" onclick="copyYaml()">📋 Copy</button>
                        <button class="btn" onclick="createYaml()">💾 Create File</button>
                    </div>
                </div>
            ` : ''}

            ${!info.isMonorepo ? `
                <div class="not-monorepo">
                    <h2>📁 Single Package Project</h2>
                    <p>This doesn't appear to be a monorepo. If you're using workspaces, make sure your configuration is correct.</p>
                </div>
            ` : ''}

            <script>
                const vscode = acquireVsCodeApi();
                const yaml = ${JSON.stringify(info.amplifyYmlSuggestion || '')};
                function refresh() { vscode.postMessage({ command: 'refresh' }); }
                function copyYaml() { vscode.postMessage({ command: 'copyYaml', yaml }); }
                function createYaml() { vscode.postMessage({ command: 'createYaml', yaml }); }
            </script>
        </body></html>`;
    }

    public dispose() {
        MonorepoPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }
}
