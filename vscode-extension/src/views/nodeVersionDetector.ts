import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Amplify supported Node.js versions (as of 2026)
const AMPLIFY_SUPPORTED_VERSIONS = {
    lts: ['18', '20', '22'],
    current: ['23', '24'],
    deprecated: ['14', '16'],
    experimental: ['25']
};

const AMPLIFY_DEFAULT_VERSION = '18';
const AMPLIFY_RECOMMENDED_VERSION = '20';

interface NodeVersionSource {
    source: string;
    version: string | null;
    file?: string;
    line?: number;
}

interface NodeVersionAnalysis {
    sources: NodeVersionSource[];
    localVersion: string | null;
    amplifyVersion: string | null;
    conflicts: string[];
    recommendations: Recommendation[];
    compatibility: 'supported' | 'deprecated' | 'experimental' | 'unsupported';
}

interface Recommendation {
    type: 'error' | 'warning' | 'info' | 'success';
    title: string;
    description: string;
    fix?: {
        file: string;
        action: string;
        content?: string;
    };
}

export class NodeVersionDetectorPanel {
    public static currentPanel: NodeVersionDetectorPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionUri: vscode.Uri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (NodeVersionDetectorPanel.currentPanel) {
            NodeVersionDetectorPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'nodeVersionDetector',
            'Node Version Detector',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        NodeVersionDetectorPanel.currentPanel = new NodeVersionDetectorPanel(panel, extensionUri);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        this._update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'analyze':
                        await this._analyzeNodeVersions();
                        break;
                    case 'applyFix':
                        await this._applyFix(message.fix);
                        break;
                    case 'openFile':
                        await this._openFile(message.file, message.line);
                        break;
                    case 'createNvmrc':
                        await this._createNvmrc(message.version);
                        break;
                    case 'updateAmplifyYml':
                        await this._updateAmplifyYml(message.version);
                        break;
                    case 'copyToClipboard':
                        await vscode.env.clipboard.writeText(message.text);
                        vscode.window.showInformationMessage('Copied to clipboard!');
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    public dispose() {
        NodeVersionDetectorPanel.currentPanel = undefined;
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
        await this._analyzeNodeVersions();
    }

    private async _analyzeNodeVersions() {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            this._panel.webview.postMessage({
                command: 'analysisResult',
                error: 'No workspace folder open'
            });
            return;
        }

        const rootPath = workspaceFolder.uri.fsPath;
        const analysis = await this._performAnalysis(rootPath);

        this._panel.webview.postMessage({
            command: 'analysisResult',
            analysis
        });
    }

    private async _performAnalysis(rootPath: string): Promise<NodeVersionAnalysis> {
        const sources: NodeVersionSource[] = [];
        const conflicts: string[] = [];
        const recommendations: Recommendation[] = [];

        // 1. Check package.json engines
        const packageJsonVersion = await this._checkPackageJson(rootPath);
        if (packageJsonVersion) {
            sources.push(packageJsonVersion);
        }

        // 2. Check .nvmrc
        const nvmrcVersion = await this._checkNvmrc(rootPath);
        if (nvmrcVersion) {
            sources.push(nvmrcVersion);
        }

        // 3. Check .node-version
        const nodeVersionFile = await this._checkNodeVersionFile(rootPath);
        if (nodeVersionFile) {
            sources.push(nodeVersionFile);
        }

        // 4. Check amplify.yml
        const amplifyYmlVersion = await this._checkAmplifyYml(rootPath);
        if (amplifyYmlVersion) {
            sources.push(amplifyYmlVersion);
        }

        // 5. Check Dockerfile if exists
        const dockerVersion = await this._checkDockerfile(rootPath);
        if (dockerVersion) {
            sources.push(dockerVersion);
        }

        // 6. Get local Node.js version
        const localVersion = await this._getLocalNodeVersion();
        sources.push({
            source: 'Local Node.js',
            version: localVersion
        });

        // Determine Amplify build version
        const amplifyVersion = this._determineAmplifyVersion(sources);

        // Detect conflicts
        const versions = sources
            .filter(s => s.version && s.source !== 'Local Node.js')
            .map(s => ({ source: s.source, version: this._normalizeVersion(s.version!) }));

        const uniqueVersions = [...new Set(versions.map(v => v.version))];
        if (uniqueVersions.length > 1) {
            conflicts.push(`Multiple Node versions specified: ${versions.map(v => `${v.source} (${v.version})`).join(', ')}`);
        }

        // Check local vs Amplify mismatch
        if (localVersion && amplifyVersion) {
            const localMajor = this._normalizeVersion(localVersion);
            const amplifyMajor = this._normalizeVersion(amplifyVersion);
            if (localMajor !== amplifyMajor) {
                conflicts.push(`Local Node (${localMajor}) differs from Amplify build (${amplifyMajor})`);
            }
        }

        // Determine compatibility
        const versionToCheck = amplifyVersion || localVersion || AMPLIFY_DEFAULT_VERSION;
        const majorVersion = this._normalizeVersion(versionToCheck);
        let compatibility: NodeVersionAnalysis['compatibility'] = 'unsupported';

        if (AMPLIFY_SUPPORTED_VERSIONS.lts.includes(majorVersion)) {
            compatibility = 'supported';
        } else if (AMPLIFY_SUPPORTED_VERSIONS.current.includes(majorVersion)) {
            compatibility = 'supported';
        } else if (AMPLIFY_SUPPORTED_VERSIONS.deprecated.includes(majorVersion)) {
            compatibility = 'deprecated';
        } else if (AMPLIFY_SUPPORTED_VERSIONS.experimental.includes(majorVersion)) {
            compatibility = 'experimental';
        }

        // Generate recommendations
        this._generateRecommendations(
            sources,
            conflicts,
            compatibility,
            majorVersion,
            recommendations,
            rootPath
        );

        return {
            sources,
            localVersion,
            amplifyVersion,
            conflicts,
            recommendations,
            compatibility
        };
    }

    private async _checkPackageJson(rootPath: string): Promise<NodeVersionSource | null> {
        const packageJsonPath = path.join(rootPath, 'package.json');
        if (!fs.existsSync(packageJsonPath)) {
            return null;
        }

        try {
            const content = fs.readFileSync(packageJsonPath, 'utf-8');
            const pkg = JSON.parse(content);
            if (pkg.engines?.node) {
                return {
                    source: 'package.json (engines.node)',
                    version: pkg.engines.node,
                    file: packageJsonPath
                };
            }
        } catch (e) {
            // Ignore parse errors
        }
        return null;
    }

    private async _checkNvmrc(rootPath: string): Promise<NodeVersionSource | null> {
        const nvmrcPath = path.join(rootPath, '.nvmrc');
        if (!fs.existsSync(nvmrcPath)) {
            return null;
        }

        try {
            const version = fs.readFileSync(nvmrcPath, 'utf-8').trim();
            return {
                source: '.nvmrc',
                version,
                file: nvmrcPath
            };
        } catch (e) {
            return null;
        }
    }

    private async _checkNodeVersionFile(rootPath: string): Promise<NodeVersionSource | null> {
        const nodeVersionPath = path.join(rootPath, '.node-version');
        if (!fs.existsSync(nodeVersionPath)) {
            return null;
        }

        try {
            const version = fs.readFileSync(nodeVersionPath, 'utf-8').trim();
            return {
                source: '.node-version',
                version,
                file: nodeVersionPath
            };
        } catch (e) {
            return null;
        }
    }

    private async _checkAmplifyYml(rootPath: string): Promise<NodeVersionSource | null> {
        const amplifyYmlPath = path.join(rootPath, 'amplify.yml');
        if (!fs.existsSync(amplifyYmlPath)) {
            return null;
        }

        try {
            const content = fs.readFileSync(amplifyYmlPath, 'utf-8');
            
            // Look for nvm use or nvm install commands
            const nvmMatch = content.match(/nvm\s+(use|install)\s+(\d+)/);
            if (nvmMatch) {
                const lines = content.split('\n');
                const lineNumber = lines.findIndex(l => l.includes(nvmMatch[0])) + 1;
                return {
                    source: 'amplify.yml (nvm)',
                    version: nvmMatch[2],
                    file: amplifyYmlPath,
                    line: lineNumber
                };
            }

            // Look for NODE_VERSION environment variable
            const envMatch = content.match(/NODE_VERSION[:\s]+["']?(\d+)["']?/);
            if (envMatch) {
                return {
                    source: 'amplify.yml (NODE_VERSION)',
                    version: envMatch[1],
                    file: amplifyYmlPath
                };
            }
        } catch (e) {
            // Ignore errors
        }
        return null;
    }

    private async _checkDockerfile(rootPath: string): Promise<NodeVersionSource | null> {
        const dockerfilePath = path.join(rootPath, 'Dockerfile');
        if (!fs.existsSync(dockerfilePath)) {
            return null;
        }

        try {
            const content = fs.readFileSync(dockerfilePath, 'utf-8');
            const nodeMatch = content.match(/FROM\s+node:(\d+)/i);
            if (nodeMatch) {
                return {
                    source: 'Dockerfile',
                    version: nodeMatch[1],
                    file: dockerfilePath
                };
            }
        } catch (e) {
            // Ignore errors
        }
        return null;
    }

    private async _getLocalNodeVersion(): Promise<string | null> {
        try {
            const { stdout } = await execAsync('node --version');
            return stdout.trim().replace('v', '');
        } catch (e) {
            return null;
        }
    }

    private _normalizeVersion(version: string): string {
        // Extract major version from various formats
        // ">=18.0.0" -> "18"
        // "18.x" -> "18"
        // "^20.0.0" -> "20"
        // "lts/*" -> use default
        // "v20.10.0" -> "20"
        
        if (version.toLowerCase().includes('lts')) {
            return AMPLIFY_RECOMMENDED_VERSION;
        }

        const match = version.match(/(\d+)/);
        return match ? match[1] : version;
    }

    private _determineAmplifyVersion(sources: NodeVersionSource[]): string | null {
        // Priority: amplify.yml > .nvmrc > .node-version > package.json
        const priority = [
            'amplify.yml (nvm)',
            'amplify.yml (NODE_VERSION)',
            '.nvmrc',
            '.node-version',
            'package.json (engines.node)'
        ];

        for (const src of priority) {
            const found = sources.find(s => s.source === src && s.version);
            if (found) {
                return found.version;
            }
        }

        return null;
    }

    private _generateRecommendations(
        sources: NodeVersionSource[],
        conflicts: string[],
        compatibility: string,
        majorVersion: string,
        recommendations: Recommendation[],
        rootPath: string
    ) {
        // No version specified
        const hasVersionSpec = sources.some(s => 
            s.version && s.source !== 'Local Node.js'
        );

        if (!hasVersionSpec) {
            recommendations.push({
                type: 'warning',
                title: 'No Node version specified',
                description: `Amplify will use Node ${AMPLIFY_DEFAULT_VERSION} by default. Consider specifying a version for consistent builds.`,
                fix: {
                    file: '.nvmrc',
                    action: 'create',
                    content: AMPLIFY_RECOMMENDED_VERSION
                }
            });
        }

        // Version conflicts
        if (conflicts.length > 0) {
            recommendations.push({
                type: 'error',
                title: 'Version conflict detected',
                description: conflicts.join('. '),
                fix: {
                    file: 'amplify.yml',
                    action: 'sync',
                    content: majorVersion
                }
            });
        }

        // Compatibility issues
        if (compatibility === 'deprecated') {
            recommendations.push({
                type: 'warning',
                title: `Node ${majorVersion} is deprecated`,
                description: `Node ${majorVersion} will be removed from Amplify soon. Upgrade to Node ${AMPLIFY_RECOMMENDED_VERSION} LTS.`,
                fix: {
                    file: '.nvmrc',
                    action: 'update',
                    content: AMPLIFY_RECOMMENDED_VERSION
                }
            });
        }

        if (compatibility === 'experimental') {
            recommendations.push({
                type: 'warning',
                title: `Node ${majorVersion} is experimental`,
                description: `Node ${majorVersion} may have limited support. Consider using Node ${AMPLIFY_RECOMMENDED_VERSION} LTS for production.`
            });
        }

        if (compatibility === 'unsupported') {
            recommendations.push({
                type: 'error',
                title: `Node ${majorVersion} is not supported`,
                description: `Amplify does not support Node ${majorVersion}. Supported versions: ${AMPLIFY_SUPPORTED_VERSIONS.lts.join(', ')} (LTS), ${AMPLIFY_SUPPORTED_VERSIONS.current.join(', ')} (Current).`,
                fix: {
                    file: '.nvmrc',
                    action: 'create',
                    content: AMPLIFY_RECOMMENDED_VERSION
                }
            });
        }

        // Check for .nvmrc without amplify.yml using it
        const hasNvmrc = sources.some(s => s.source === '.nvmrc');
        const amplifyUsesNvm = sources.some(s => s.source.startsWith('amplify.yml'));
        
        if (hasNvmrc && !amplifyUsesNvm) {
            const amplifyYmlPath = path.join(rootPath, 'amplify.yml');
            if (!fs.existsSync(amplifyYmlPath)) {
                recommendations.push({
                    type: 'info',
                    title: 'Create amplify.yml to use .nvmrc',
                    description: 'Amplify needs explicit configuration to use your .nvmrc file.',
                    fix: {
                        file: 'amplify.yml',
                        action: 'create',
                        content: 'auto'
                    }
                });
            } else {
                recommendations.push({
                    type: 'info',
                    title: 'Add nvm use to amplify.yml',
                    description: 'Your .nvmrc exists but amplify.yml doesn\'t reference it.',
                    fix: {
                        file: 'amplify.yml',
                        action: 'add-nvm'
                    }
                });
            }
        }

        // Success message
        if (compatibility === 'supported' && conflicts.length === 0 && hasVersionSpec) {
            recommendations.push({
                type: 'success',
                title: 'Node version configuration looks good!',
                description: `Node ${majorVersion} is fully supported and consistently configured.`
            });
        }
    }

    private async _applyFix(fix: { file: string; action: string; content?: string }) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return;
        }

        const filePath = path.join(workspaceFolder.uri.fsPath, fix.file);

        try {
            if (fix.action === 'create' && fix.file === '.nvmrc') {
                fs.writeFileSync(filePath, fix.content || AMPLIFY_RECOMMENDED_VERSION);
                vscode.window.showInformationMessage(`Created ${fix.file} with Node ${fix.content}`);
            } else if (fix.action === 'create' && fix.file === 'amplify.yml') {
                const content = this._generateAmplifyYml(fix.content || AMPLIFY_RECOMMENDED_VERSION);
                fs.writeFileSync(filePath, content);
                vscode.window.showInformationMessage('Created amplify.yml with Node version configuration');
            } else if (fix.action === 'update') {
                fs.writeFileSync(filePath, fix.content || AMPLIFY_RECOMMENDED_VERSION);
                vscode.window.showInformationMessage(`Updated ${fix.file}`);
            } else if (fix.action === 'add-nvm') {
                await this._addNvmToAmplifyYml(filePath);
            }

            // Re-analyze
            await this._analyzeNodeVersions();
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to apply fix: ${e}`);
        }
    }

    private _generateAmplifyYml(version: string): string {
        const useNvmrc = version === 'auto';
        const nvmCommand = useNvmrc ? 'nvm use' : `nvm use ${version}`;

        return `version: 1
frontend:
  phases:
    preBuild:
      commands:
        - ${nvmCommand}
        - npm ci
    build:
      commands:
        - npm run build
  artifacts:
    baseDirectory: .next
    files:
      - '**/*'
  cache:
    paths:
      - node_modules/**/*
      - .next/cache/**/*
`;
    }

    private async _addNvmToAmplifyYml(filePath: string) {
        if (!fs.existsSync(filePath)) {
            return;
        }

        let content = fs.readFileSync(filePath, 'utf-8');
        
        // Check if nvm is already there
        if (content.includes('nvm use') || content.includes('nvm install')) {
            vscode.window.showInformationMessage('amplify.yml already has nvm configuration');
            return;
        }

        // Add nvm use after preBuild commands
        if (content.includes('preBuild:')) {
            content = content.replace(
                /(preBuild:\s*\n\s*commands:\s*\n)/,
                '$1        - nvm use\n'
            );
        } else {
            // Add preBuild phase
            content = content.replace(
                /(phases:\s*\n)/,
                '$1    preBuild:\n      commands:\n        - nvm use\n'
            );
        }

        fs.writeFileSync(filePath, content);
        vscode.window.showInformationMessage('Added nvm use to amplify.yml');
    }

    private async _createNvmrc(version: string) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return;
        }

        const nvmrcPath = path.join(workspaceFolder.uri.fsPath, '.nvmrc');
        fs.writeFileSync(nvmrcPath, version);
        vscode.window.showInformationMessage(`Created .nvmrc with Node ${version}`);
        await this._analyzeNodeVersions();
    }

    private async _updateAmplifyYml(version: string) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return;
        }

        const amplifyYmlPath = path.join(workspaceFolder.uri.fsPath, 'amplify.yml');
        
        if (!fs.existsSync(amplifyYmlPath)) {
            const content = this._generateAmplifyYml(version);
            fs.writeFileSync(amplifyYmlPath, content);
            vscode.window.showInformationMessage('Created amplify.yml with Node version configuration');
        } else {
            let content = fs.readFileSync(amplifyYmlPath, 'utf-8');
            
            // Update existing nvm command
            if (content.match(/nvm\s+(use|install)\s+\d+/)) {
                content = content.replace(/nvm\s+(use|install)\s+\d+/, `nvm use ${version}`);
            } else if (content.includes('preBuild:')) {
                content = content.replace(
                    /(preBuild:\s*\n\s*commands:\s*\n)/,
                    `$1        - nvm use ${version}\n`
                );
            }
            
            fs.writeFileSync(amplifyYmlPath, content);
            vscode.window.showInformationMessage(`Updated amplify.yml to use Node ${version}`);
        }

        await this._analyzeNodeVersions();
    }

    private async _openFile(file: string, line?: number) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return;
        }

        const filePath = path.join(workspaceFolder.uri.fsPath, file);
        if (!fs.existsSync(filePath)) {
            return;
        }

        const doc = await vscode.workspace.openTextDocument(filePath);
        const editor = await vscode.window.showTextDocument(doc);
        
        if (line) {
            const position = new vscode.Position(line - 1, 0);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position));
        }
    }

    private _getHtmlContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Node Version Detector</title>
    <style>
        :root {
            --bg-color: var(--vscode-editor-background);
            --text-color: var(--vscode-editor-foreground);
            --border-color: var(--vscode-panel-border);
            --card-bg: var(--vscode-editorWidget-background);
            --success-color: #4caf50;
            --warning-color: #ff9800;
            --error-color: #f44336;
            --info-color: #2196f3;
        }
        
        * {
            box-sizing: border-box;
        }
        
        body {
            font-family: var(--vscode-font-family);
            color: var(--text-color);
            background: var(--bg-color);
            padding: 20px;
            margin: 0;
        }
        
        h1 {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 8px;
        }
        
        .subtitle {
            color: var(--vscode-descriptionForeground);
            margin-bottom: 24px;
        }
        
        .card {
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 16px;
            margin-bottom: 16px;
        }
        
        .card h2 {
            margin: 0 0 16px 0;
            font-size: 14px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
        }
        
        .version-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
            gap: 12px;
        }
        
        .version-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px;
            background: var(--vscode-input-background);
            border-radius: 6px;
            cursor: pointer;
            transition: background 0.2s;
        }
        
        .version-item:hover {
            background: var(--vscode-list-hoverBackground);
        }
        
        .version-source {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        
        .version-value {
            font-weight: bold;
            font-family: var(--vscode-editor-font-family);
            font-size: 16px;
        }
        
        .version-value.not-set {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            font-weight: normal;
        }
        
        .compatibility-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 6px 12px;
            border-radius: 20px;
            font-size: 13px;
            font-weight: 500;
        }
        
        .compatibility-badge.supported {
            background: rgba(76, 175, 80, 0.2);
            color: var(--success-color);
        }
        
        .compatibility-badge.deprecated {
            background: rgba(255, 152, 0, 0.2);
            color: var(--warning-color);
        }
        
        .compatibility-badge.experimental {
            background: rgba(33, 150, 243, 0.2);
            color: var(--info-color);
        }
        
        .compatibility-badge.unsupported {
            background: rgba(244, 67, 54, 0.2);
            color: var(--error-color);
        }
        
        .recommendation {
            display: flex;
            gap: 12px;
            padding: 12px;
            border-radius: 6px;
            margin-bottom: 12px;
        }
        
        .recommendation:last-child {
            margin-bottom: 0;
        }
        
        .recommendation.error {
            background: rgba(244, 67, 54, 0.1);
            border-left: 3px solid var(--error-color);
        }
        
        .recommendation.warning {
            background: rgba(255, 152, 0, 0.1);
            border-left: 3px solid var(--warning-color);
        }
        
        .recommendation.info {
            background: rgba(33, 150, 243, 0.1);
            border-left: 3px solid var(--info-color);
        }
        
        .recommendation.success {
            background: rgba(76, 175, 80, 0.1);
            border-left: 3px solid var(--success-color);
        }
        
        .recommendation-icon {
            font-size: 20px;
            flex-shrink: 0;
        }
        
        .recommendation-content {
            flex: 1;
        }
        
        .recommendation-title {
            font-weight: 600;
            margin-bottom: 4px;
        }
        
        .recommendation-desc {
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 8px;
        }
        
        button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            display: inline-flex;
            align-items: center;
            gap: 6px;
        }
        
        button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        
        button.secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        
        .quick-actions {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
            margin-top: 16px;
        }
        
        .version-selector {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
        }
        
        .version-btn {
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.2s;
            background: var(--vscode-input-background);
            border: 1px solid var(--border-color);
            color: var(--text-color);
        }
        
        .version-btn:hover {
            border-color: var(--vscode-focusBorder);
        }
        
        .version-btn.lts {
            border-color: var(--success-color);
        }
        
        .version-btn.lts:hover {
            background: rgba(76, 175, 80, 0.1);
        }
        
        .version-label {
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-left: 4px;
            opacity: 0.7;
        }
        
        .loading {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 40px;
            color: var(--vscode-descriptionForeground);
        }
        
        .spinner {
            width: 24px;
            height: 24px;
            border: 2px solid var(--border-color);
            border-top-color: var(--vscode-focusBorder);
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-right: 12px;
        }
        
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        
        .amplify-versions {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
            margin-top: 8px;
        }
        
        .amplify-version-tag {
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
            background: var(--vscode-input-background);
        }
        
        .amplify-version-tag.lts {
            background: rgba(76, 175, 80, 0.15);
            color: var(--success-color);
        }
        
        .amplify-version-tag.current {
            background: rgba(33, 150, 243, 0.15);
            color: var(--info-color);
        }
        
        .amplify-version-tag.deprecated {
            background: rgba(255, 152, 0, 0.15);
            color: var(--warning-color);
        }
    </style>
</head>
<body>
    <h1>🔍 Node Version Detector</h1>
    <p class="subtitle">Detect and fix Node.js version issues in your Amplify project</p>
    
    <div id="content">
        <div class="loading">
            <div class="spinner"></div>
            Analyzing Node.js configuration...
        </div>
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        
        window.addEventListener('message', event => {
            const message = event.data;
            
            if (message.command === 'analysisResult') {
                if (message.error) {
                    showError(message.error);
                } else {
                    showAnalysis(message.analysis);
                }
            }
        });
        
        function showError(error) {
            document.getElementById('content').innerHTML = \`
                <div class="card">
                    <div class="recommendation error">
                        <div class="recommendation-icon">❌</div>
                        <div class="recommendation-content">
                            <div class="recommendation-title">Error</div>
                            <div class="recommendation-desc">\${error}</div>
                        </div>
                    </div>
                </div>
            \`;
        }
        
        function showAnalysis(analysis) {
            const html = \`
                <div class="card">
                    <h2>📊 Detected Versions</h2>
                    <div class="version-grid">
                        \${analysis.sources.map(s => \`
                            <div class="version-item" \${s.file ? \`onclick="openFile('\${s.file.replace(/\\\\/g, '\\\\\\\\')}', \${s.line || 0})"\` : ''}>
                                <div>
                                    <div class="version-source">\${s.source}</div>
                                    <div class="version-value \${s.version ? '' : 'not-set'}">\${s.version || 'Not set'}</div>
                                </div>
                                \${s.file ? '<span>📄</span>' : ''}
                            </div>
                        \`).join('')}
                    </div>
                </div>
                
                <div class="card">
                    <h2>🎯 Amplify Build Version</h2>
                    <div style="display: flex; align-items: center; gap: 16px; flex-wrap: wrap;">
                        <div style="font-size: 24px; font-weight: bold; font-family: var(--vscode-editor-font-family);">
                            Node \${analysis.amplifyVersion || '18 (default)'}
                        </div>
                        <span class="compatibility-badge \${analysis.compatibility}">
                            \${getCompatibilityIcon(analysis.compatibility)}
                            \${getCompatibilityLabel(analysis.compatibility)}
                        </span>
                    </div>
                    <div style="margin-top: 12px; color: var(--vscode-descriptionForeground); font-size: 13px;">
                        Amplify supported versions:
                    </div>
                    <div class="amplify-versions">
                        <span class="amplify-version-tag lts">18 LTS</span>
                        <span class="amplify-version-tag lts">20 LTS</span>
                        <span class="amplify-version-tag lts">22 LTS</span>
                        <span class="amplify-version-tag current">23</span>
                        <span class="amplify-version-tag current">24</span>
                        <span class="amplify-version-tag deprecated">16 ⚠️</span>
                    </div>
                </div>
                
                <div class="card">
                    <h2>💡 Recommendations</h2>
                    \${analysis.recommendations.length === 0 ? 
                        '<p style="color: var(--vscode-descriptionForeground);">No recommendations at this time.</p>' :
                        analysis.recommendations.map(r => \`
                            <div class="recommendation \${r.type}">
                                <div class="recommendation-icon">\${getRecommendationIcon(r.type)}</div>
                                <div class="recommendation-content">
                                    <div class="recommendation-title">\${r.title}</div>
                                    <div class="recommendation-desc">\${r.description}</div>
                                    \${r.fix ? \`<button onclick="applyFix(\${JSON.stringify(r.fix).replace(/"/g, '&quot;')})">🔧 Apply Fix</button>\` : ''}
                                </div>
                            </div>
                        \`).join('')
                    }
                </div>
                
                <div class="card">
                    <h2>⚡ Quick Actions</h2>
                    <p style="color: var(--vscode-descriptionForeground); margin-bottom: 12px;">
                        Set Node version for your project:
                    </p>
                    <div class="version-selector">
                        <button class="version-btn lts" onclick="setVersion('20')">
                            20 <span class="version-label">LTS Recommended</span>
                        </button>
                        <button class="version-btn lts" onclick="setVersion('22')">
                            22 <span class="version-label">LTS</span>
                        </button>
                        <button class="version-btn" onclick="setVersion('18')">
                            18 <span class="version-label">LTS</span>
                        </button>
                        <button class="version-btn" onclick="setVersion('24')">
                            24 <span class="version-label">Current</span>
                        </button>
                    </div>
                    <div class="quick-actions">
                        <button class="secondary" onclick="refresh()">🔄 Re-analyze</button>
                    </div>
                </div>
            \`;
            
            document.getElementById('content').innerHTML = html;
        }
        
        function getCompatibilityIcon(status) {
            const icons = {
                supported: '✅',
                deprecated: '⚠️',
                experimental: '🧪',
                unsupported: '❌'
            };
            return icons[status] || '❓';
        }
        
        function getCompatibilityLabel(status) {
            const labels = {
                supported: 'Fully Supported',
                deprecated: 'Deprecated',
                experimental: 'Experimental',
                unsupported: 'Not Supported'
            };
            return labels[status] || 'Unknown';
        }
        
        function getRecommendationIcon(type) {
            const icons = {
                error: '❌',
                warning: '⚠️',
                info: '💡',
                success: '✅'
            };
            return icons[type] || '📌';
        }
        
        function applyFix(fix) {
            vscode.postMessage({ command: 'applyFix', fix });
        }
        
        function openFile(file, line) {
            vscode.postMessage({ command: 'openFile', file, line });
        }
        
        function setVersion(version) {
            // Create/update both .nvmrc and amplify.yml
            vscode.postMessage({ command: 'createNvmrc', version });
            vscode.postMessage({ command: 'updateAmplifyYml', version });
        }
        
        function refresh() {
            document.getElementById('content').innerHTML = \`
                <div class="loading">
                    <div class="spinner"></div>
                    Analyzing Node.js configuration...
                </div>
            \`;
            vscode.postMessage({ command: 'analyze' });
        }
    </script>
</body>
</html>`;
    }
}
