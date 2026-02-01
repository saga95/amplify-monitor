import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AmplifyMonitorCli } from '../cli';

// Common env var patterns and their requirements
const ENV_VAR_PATTERNS = {
    // Next.js
    nextPublic: /NEXT_PUBLIC_[A-Z0-9_]+/g,
    nextPrivate: /(?<!NEXT_PUBLIC_)[A-Z][A-Z0-9_]*(?:_KEY|_SECRET|_TOKEN|_URL|_API|_ID|_PASSWORD|_CREDENTIAL)/g,
    
    // React (Create React App)
    reactApp: /REACT_APP_[A-Z0-9_]+/g,
    
    // Vite
    vite: /VITE_[A-Z0-9_]+/g,
    
    // Generic
    generic: /process\.env\.([A-Z][A-Z0-9_]*)/g,
    importMeta: /import\.meta\.env\.([A-Z][A-Z0-9_]*)/g
};

// Known sensitive env var patterns that should never be in code
const SENSITIVE_PATTERNS = [
    /AWS_ACCESS_KEY_ID/,
    /AWS_SECRET_ACCESS_KEY/,
    /AWS_SESSION_TOKEN/,
    /GITHUB_TOKEN/,
    /NPM_TOKEN/,
    /SLACK_TOKEN/,
    /DISCORD_TOKEN/,
    /DATABASE_PASSWORD/,
    /DB_PASSWORD/,
    /PRIVATE_KEY/,
    /API_SECRET/,
    /JWT_SECRET/,
    /ENCRYPTION_KEY/,
    /MASTER_KEY/
];

// Framework detection
interface FrameworkInfo {
    name: string;
    envPrefix: string;
    clientSidePrefix?: string;
    serverSideOnly?: string[];
}

const FRAMEWORKS: { [key: string]: FrameworkInfo } = {
    nextjs: {
        name: 'Next.js',
        envPrefix: 'NEXT_PUBLIC_',
        clientSidePrefix: 'NEXT_PUBLIC_',
        serverSideOnly: ['DATABASE_URL', 'AWS_', 'PRIVATE_']
    },
    cra: {
        name: 'Create React App',
        envPrefix: 'REACT_APP_',
        clientSidePrefix: 'REACT_APP_'
    },
    vite: {
        name: 'Vite',
        envPrefix: 'VITE_',
        clientSidePrefix: 'VITE_'
    },
    gatsby: {
        name: 'Gatsby',
        envPrefix: 'GATSBY_',
        clientSidePrefix: 'GATSBY_'
    }
};

interface EnvVarIssue {
    type: 'error' | 'warning' | 'info';
    category: string;
    variable: string;
    message: string;
    file?: string;
    line?: number;
    fix?: {
        action: string;
        description: string;
        data?: any;
    };
}

interface EnvVarSource {
    name: string;
    variables: Map<string, string>;
    file?: string;
}

interface TroubleshootResult {
    framework: FrameworkInfo | null;
    sources: EnvVarSource[];
    codeReferences: Map<string, { file: string; line: number }[]>;
    amplifyVars: string[];
    issues: EnvVarIssue[];
    summary: {
        total: number;
        errors: number;
        warnings: number;
        info: number;
    };
}

export class EnvVarsTroubleshooterPanel {
    public static currentPanel: EnvVarsTroubleshooterPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _cli: AmplifyMonitorCli;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionUri: vscode.Uri, cli: AmplifyMonitorCli) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (EnvVarsTroubleshooterPanel.currentPanel) {
            EnvVarsTroubleshooterPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'envVarsTroubleshooter',
            'Env Vars Troubleshooter',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        EnvVarsTroubleshooterPanel.currentPanel = new EnvVarsTroubleshooterPanel(panel, extensionUri, cli);
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
                    case 'analyze':
                        await this._analyze();
                        break;
                    case 'applyFix':
                        await this._applyFix(message.fix, message.variable);
                        break;
                    case 'openFile':
                        await this._openFile(message.file, message.line);
                        break;
                    case 'createEnvExample':
                        await this._createEnvExample(message.variables);
                        break;
                    case 'addToAmplify':
                        await this._addToAmplify(message.variable, message.value);
                        break;
                    case 'copyToClipboard':
                        await vscode.env.clipboard.writeText(message.text);
                        vscode.window.showInformationMessage('Copied to clipboard!');
                        break;
                    case 'openAmplifyConsole':
                        await this._openAmplifyConsole();
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    public dispose() {
        EnvVarsTroubleshooterPanel.currentPanel = undefined;
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
        await this._analyze();
    }

    private async _analyze() {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            this._panel.webview.postMessage({
                command: 'analysisResult',
                error: 'No workspace folder open'
            });
            return;
        }

        try {
            const result = await this._performAnalysis(workspaceFolder.uri.fsPath);
            this._panel.webview.postMessage({
                command: 'analysisResult',
                result: {
                    ...result,
                    codeReferences: Object.fromEntries(result.codeReferences)
                }
            });
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'analysisResult',
                error: `Analysis failed: ${error}`
            });
        }
    }

    private async _performAnalysis(rootPath: string): Promise<TroubleshootResult> {
        const issues: EnvVarIssue[] = [];
        const sources: EnvVarSource[] = [];
        const codeReferences = new Map<string, { file: string; line: number }[]>();

        // 1. Detect framework
        const framework = await this._detectFramework(rootPath);

        // 2. Collect env vars from various sources
        // .env files
        const envFiles = ['.env', '.env.local', '.env.development', '.env.production', '.env.example'];
        for (const envFile of envFiles) {
            const envPath = path.join(rootPath, envFile);
            if (fs.existsSync(envPath)) {
                const vars = this._parseEnvFile(envPath);
                sources.push({
                    name: envFile,
                    variables: vars,
                    file: envPath
                });
            }
        }

        // 3. Get Amplify env vars (if available)
        let amplifyVars: string[] = [];
        try {
            const appId = this._cli.getSelectedApp();
            const branch = this._cli.getSelectedBranch();
            if (appId && branch) {
                const envVarsResult = await this._cli.getEnvVariables(appId, branch);
                if (envVarsResult) {
                    amplifyVars = envVarsResult.map((v: any) => v.name);
                    sources.push({
                        name: 'Amplify Environment Variables',
                        variables: new Map(envVarsResult.map((v: any) => [v.name, '***']))
                    });
                }
            }
        } catch (e) {
            // Amplify not connected or no app selected
        }

        // 4. Scan code for env var references
        await this._scanCodeForEnvVars(rootPath, codeReferences);

        // 5. Analyze and find issues
        // Check for missing env vars
        for (const [varName, refs] of codeReferences) {
            const isInAnySource = sources.some(s => s.variables.has(varName));
            const isInAmplify = amplifyVars.includes(varName);
            
            if (!isInAnySource && !isInAmplify) {
                issues.push({
                    type: 'error',
                    category: 'Missing Variable',
                    variable: varName,
                    message: `Referenced in code but not defined in any .env file or Amplify`,
                    file: refs[0]?.file,
                    line: refs[0]?.line,
                    fix: {
                        action: 'add_to_env',
                        description: 'Add to .env file',
                        data: { variable: varName }
                    }
                });
            } else if (isInAnySource && !isInAmplify && amplifyVars.length > 0) {
                // In local .env but not in Amplify
                const localSource = sources.find(s => s.variables.has(varName) && s.name !== 'Amplify Environment Variables');
                if (localSource && !localSource.name.includes('example')) {
                    issues.push({
                        type: 'warning',
                        category: 'Not in Amplify',
                        variable: varName,
                        message: `Defined in ${localSource.name} but not in Amplify - builds may fail`,
                        fix: {
                            action: 'add_to_amplify',
                            description: 'Add to Amplify env vars',
                            data: { variable: varName }
                        }
                    });
                }
            }
        }

        // Check for client-side exposure issues
        if (framework?.clientSidePrefix) {
            for (const [varName, refs] of codeReferences) {
                // Check if sensitive var might be exposed client-side
                const isSensitive = SENSITIVE_PATTERNS.some(p => p.test(varName));
                const hasClientPrefix = varName.startsWith(framework.clientSidePrefix);
                
                if (isSensitive && hasClientPrefix) {
                    issues.push({
                        type: 'error',
                        category: 'Security Risk',
                        variable: varName,
                        message: `Sensitive variable with client-side prefix - will be exposed in browser!`,
                        file: refs[0]?.file,
                        line: refs[0]?.line,
                        fix: {
                            action: 'rename_var',
                            description: `Remove ${framework.clientSidePrefix} prefix`,
                            data: { oldName: varName, newName: varName.replace(framework.clientSidePrefix, '') }
                        }
                    });
                }

                // Check if trying to access server-side var on client
                if (!hasClientPrefix && this._isClientSideFile(refs[0]?.file || '', framework)) {
                    issues.push({
                        type: 'warning',
                        category: 'Client Access Issue',
                        variable: varName,
                        message: `Accessed in client-side code without ${framework.clientSidePrefix} prefix - will be undefined`,
                        file: refs[0]?.file,
                        line: refs[0]?.line,
                        fix: {
                            action: 'rename_var',
                            description: `Add ${framework.clientSidePrefix} prefix`,
                            data: { oldName: varName, newName: framework.clientSidePrefix + varName }
                        }
                    });
                }
            }
        }

        // Check for hardcoded secrets in code
        await this._checkForHardcodedSecrets(rootPath, issues);

        // Check .gitignore for .env files
        await this._checkGitignore(rootPath, issues, sources);

        // Check for .env.example completeness
        const envExample = sources.find(s => s.name === '.env.example');
        const envLocal = sources.find(s => s.name === '.env' || s.name === '.env.local');
        if (envLocal && !envExample) {
            issues.push({
                type: 'info',
                category: 'Best Practice',
                variable: '-',
                message: 'No .env.example file found - consider creating one for team documentation',
                fix: {
                    action: 'create_env_example',
                    description: 'Create .env.example from current .env',
                    data: { variables: Array.from(envLocal.variables.keys()) }
                }
            });
        } else if (envExample && envLocal) {
            // Check for vars in .env but not in .env.example
            for (const [varName] of envLocal.variables) {
                if (!envExample.variables.has(varName)) {
                    issues.push({
                        type: 'info',
                        category: 'Documentation',
                        variable: varName,
                        message: `In ${envLocal.name} but not in .env.example`,
                        fix: {
                            action: 'add_to_example',
                            description: 'Add to .env.example',
                            data: { variable: varName }
                        }
                    });
                }
            }
        }

        // Summary
        const summary = {
            total: issues.length,
            errors: issues.filter(i => i.type === 'error').length,
            warnings: issues.filter(i => i.type === 'warning').length,
            info: issues.filter(i => i.type === 'info').length
        };

        return {
            framework,
            sources,
            codeReferences,
            amplifyVars,
            issues,
            summary
        };
    }

    private async _detectFramework(rootPath: string): Promise<FrameworkInfo | null> {
        const packageJsonPath = path.join(rootPath, 'package.json');
        if (!fs.existsSync(packageJsonPath)) {
            return null;
        }

        try {
            const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
            const deps = { ...pkg.dependencies, ...pkg.devDependencies };

            if (deps['next']) {
                return FRAMEWORKS.nextjs;
            } else if (deps['react-scripts']) {
                return FRAMEWORKS.cra;
            } else if (deps['vite']) {
                return FRAMEWORKS.vite;
            } else if (deps['gatsby']) {
                return FRAMEWORKS.gatsby;
            }
        } catch (e) {
            // Ignore parse errors
        }

        return null;
    }

    private _parseEnvFile(filePath: string): Map<string, string> {
        const vars = new Map<string, string>();
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');
            
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#')) {
                    const match = trimmed.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
                    if (match) {
                        vars.set(match[1], match[2].replace(/^["']|["']$/g, ''));
                    }
                }
            }
        } catch (e) {
            // Ignore read errors
        }
        return vars;
    }

    private async _scanCodeForEnvVars(
        rootPath: string,
        codeReferences: Map<string, { file: string; line: number }[]>
    ) {
        const extensions = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];
        const ignoreDirs = ['node_modules', '.next', 'dist', 'build', '.git', 'coverage'];

        const scanDir = (dir: string) => {
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    
                    if (entry.isDirectory()) {
                        if (!ignoreDirs.includes(entry.name)) {
                            scanDir(fullPath);
                        }
                    } else if (entry.isFile() && extensions.some(ext => entry.name.endsWith(ext))) {
                        this._scanFile(fullPath, rootPath, codeReferences);
                    }
                }
            } catch (e) {
                // Ignore permission errors
            }
        };

        scanDir(rootPath);
    }

    private _scanFile(
        filePath: string,
        rootPath: string,
        codeReferences: Map<string, { file: string; line: number }[]>
    ) {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');
            const relativePath = path.relative(rootPath, filePath);

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                
                // Match process.env.VAR_NAME
                const processEnvMatches = line.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g);
                for (const match of processEnvMatches) {
                    const varName = match[1];
                    if (!codeReferences.has(varName)) {
                        codeReferences.set(varName, []);
                    }
                    codeReferences.get(varName)!.push({ file: relativePath, line: i + 1 });
                }

                // Match import.meta.env.VAR_NAME (Vite)
                const importMetaMatches = line.matchAll(/import\.meta\.env\.([A-Z][A-Z0-9_]*)/g);
                for (const match of importMetaMatches) {
                    const varName = match[1];
                    if (!codeReferences.has(varName)) {
                        codeReferences.set(varName, []);
                    }
                    codeReferences.get(varName)!.push({ file: relativePath, line: i + 1 });
                }
            }
        } catch (e) {
            // Ignore read errors
        }
    }

    private _isClientSideFile(filePath: string, framework: FrameworkInfo): boolean {
        if (framework.name === 'Next.js') {
            // In Next.js, files in pages/ or app/ that don't have 'use server' are client-side
            // Components are client-side unless they have 'use server'
            if (filePath.includes('/api/') || filePath.includes('\\api\\')) {
                return false; // API routes are server-side
            }
            // For simplicity, assume most files could be client-side in Next.js
            return true;
        }
        
        // CRA and Vite are primarily client-side
        if (framework.name === 'Create React App' || framework.name === 'Vite') {
            return true;
        }

        return false;
    }

    private async _checkForHardcodedSecrets(rootPath: string, issues: EnvVarIssue[]) {
        const secretPatterns = [
            { pattern: /['"`]sk_live_[a-zA-Z0-9]{24,}['"`]/, name: 'Stripe Secret Key' },
            { pattern: /['"`]sk_test_[a-zA-Z0-9]{24,}['"`]/, name: 'Stripe Test Key' },
            { pattern: /['"`]AKIA[A-Z0-9]{16}['"`]/, name: 'AWS Access Key' },
            { pattern: /['"`]ghp_[a-zA-Z0-9]{36}['"`]/, name: 'GitHub Token' },
            { pattern: /['"`]xoxb-[a-zA-Z0-9-]+['"`]/, name: 'Slack Bot Token' },
            { pattern: /['"`]mongodb\+srv:\/\/[^'"`]+['"`]/, name: 'MongoDB Connection String' },
            { pattern: /['"`]postgres:\/\/[^'"`]+['"`]/, name: 'PostgreSQL Connection String' }
        ];

        const extensions = ['.js', '.jsx', '.ts', '.tsx'];
        const ignoreDirs = ['node_modules', '.next', 'dist', 'build', '.git'];

        const scanDir = (dir: string) => {
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    
                    if (entry.isDirectory() && !ignoreDirs.includes(entry.name)) {
                        scanDir(fullPath);
                    } else if (entry.isFile() && extensions.some(ext => entry.name.endsWith(ext))) {
                        const content = fs.readFileSync(fullPath, 'utf-8');
                        const relativePath = path.relative(rootPath, fullPath);
                        
                        for (const { pattern, name } of secretPatterns) {
                            if (pattern.test(content)) {
                                const lines = content.split('\n');
                                for (let i = 0; i < lines.length; i++) {
                                    if (pattern.test(lines[i])) {
                                        issues.push({
                                            type: 'error',
                                            category: 'Hardcoded Secret',
                                            variable: name,
                                            message: `Hardcoded ${name} found in source code - major security risk!`,
                                            file: relativePath,
                                            line: i + 1,
                                            fix: {
                                                action: 'move_to_env',
                                                description: 'Move to environment variable',
                                                data: { secretType: name }
                                            }
                                        });
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                // Ignore errors
            }
        };

        scanDir(rootPath);
    }

    private async _checkGitignore(rootPath: string, issues: EnvVarIssue[], sources: EnvVarSource[]) {
        const gitignorePath = path.join(rootPath, '.gitignore');
        
        if (!fs.existsSync(gitignorePath)) {
            if (sources.some(s => s.name === '.env' || s.name === '.env.local')) {
                issues.push({
                    type: 'error',
                    category: 'Security Risk',
                    variable: '.gitignore',
                    message: 'No .gitignore file - .env files may be committed to git!',
                    fix: {
                        action: 'create_gitignore',
                        description: 'Create .gitignore with .env entries'
                    }
                });
            }
            return;
        }

        try {
            const content = fs.readFileSync(gitignorePath, 'utf-8');
            
            // Check if .env is ignored
            const envPatterns = ['.env', '.env.local', '.env*.local', '*.env'];
            const hasEnvIgnore = envPatterns.some(p => 
                content.includes(p) || content.match(new RegExp(`^${p.replace('.', '\\.').replace('*', '.*')}$`, 'm'))
            );

            if (!hasEnvIgnore && sources.some(s => s.name === '.env' || s.name === '.env.local')) {
                issues.push({
                    type: 'error',
                    category: 'Security Risk',
                    variable: '.env',
                    message: '.env files are not in .gitignore - secrets may be exposed!',
                    fix: {
                        action: 'add_to_gitignore',
                        description: 'Add .env to .gitignore'
                    }
                });
            }
        } catch (e) {
            // Ignore read errors
        }
    }

    private async _applyFix(fix: { action: string; description: string; data?: any }, variable: string) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return;
        }

        const rootPath = workspaceFolder.uri.fsPath;

        try {
            switch (fix.action) {
                case 'add_to_env': {
                    const envPath = path.join(rootPath, '.env');
                    const content = fs.existsSync(envPath) 
                        ? fs.readFileSync(envPath, 'utf-8') + '\n'
                        : '';
                    fs.writeFileSync(envPath, content + `${variable}=\n`);
                    vscode.window.showInformationMessage(`Added ${variable} to .env`);
                    break;
                }

                case 'add_to_amplify': {
                    const value = await vscode.window.showInputBox({
                        prompt: `Enter value for ${variable}`,
                        password: variable.toLowerCase().includes('secret') || 
                                 variable.toLowerCase().includes('key') ||
                                 variable.toLowerCase().includes('password')
                    });
                    if (value !== undefined) {
                        await this._addToAmplify(variable, value);
                    }
                    break;
                }

                case 'create_env_example': {
                    const envExamplePath = path.join(rootPath, '.env.example');
                    const variables = fix.data?.variables || [];
                    const content = variables.map((v: string) => `${v}=`).join('\n');
                    fs.writeFileSync(envExamplePath, content + '\n');
                    vscode.window.showInformationMessage('Created .env.example');
                    break;
                }

                case 'add_to_example': {
                    const envExamplePath = path.join(rootPath, '.env.example');
                    const content = fs.existsSync(envExamplePath)
                        ? fs.readFileSync(envExamplePath, 'utf-8') + '\n'
                        : '';
                    fs.writeFileSync(envExamplePath, content + `${variable}=\n`);
                    vscode.window.showInformationMessage(`Added ${variable} to .env.example`);
                    break;
                }

                case 'add_to_gitignore': {
                    const gitignorePath = path.join(rootPath, '.gitignore');
                    const content = fs.existsSync(gitignorePath)
                        ? fs.readFileSync(gitignorePath, 'utf-8') + '\n'
                        : '';
                    fs.writeFileSync(gitignorePath, content + `# Environment files\n.env\n.env.local\n.env*.local\n`);
                    vscode.window.showInformationMessage('Added .env to .gitignore');
                    break;
                }

                case 'create_gitignore': {
                    const gitignorePath = path.join(rootPath, '.gitignore');
                    const content = `# Dependencies
node_modules/

# Environment files
.env
.env.local
.env*.local

# Build outputs
dist/
build/
.next/
out/

# IDE
.vscode/
.idea/

# Logs
*.log
npm-debug.log*
`;
                    fs.writeFileSync(gitignorePath, content);
                    vscode.window.showInformationMessage('Created .gitignore');
                    break;
                }

                case 'rename_var': {
                    vscode.window.showInformationMessage(
                        `Please rename ${fix.data.oldName} to ${fix.data.newName} in your code and .env files`
                    );
                    break;
                }
            }

            // Re-analyze
            await this._analyze();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to apply fix: ${error}`);
        }
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

    private async _createEnvExample(variables: string[]) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return;
        }

        const envExamplePath = path.join(workspaceFolder.uri.fsPath, '.env.example');
        const content = variables.map(v => `${v}=`).join('\n') + '\n';
        fs.writeFileSync(envExamplePath, content);
        vscode.window.showInformationMessage('Created .env.example');
        await this._analyze();
    }

    private async _addToAmplify(variable: string, value: string) {
        try {
            const appId = this._cli.getSelectedApp();
            const branch = this._cli.getSelectedBranch();
            
            if (!appId || !branch) {
                vscode.window.showWarningMessage('Please select an Amplify app and branch first');
                return;
            }

            // Note: This would require AWS SDK integration to actually set the env var
            // For now, we'll open the AWS Console
            vscode.window.showInformationMessage(
                `To add ${variable} to Amplify, open the AWS Console and navigate to your app's environment variables.`
            );
            await this._openAmplifyConsole();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to add env var: ${error}`);
        }
    }

    private async _openAmplifyConsole() {
        const appId = this._cli.getSelectedApp();
        const branch = this._cli.getSelectedBranch();
        const region = vscode.workspace.getConfiguration('amplifyMonitor').get('defaultRegion', 'us-east-1');

        if (appId && branch) {
            const url = `https://${region}.console.aws.amazon.com/amplify/apps/${appId}/branches/${branch}/environment-variables`;
            vscode.env.openExternal(vscode.Uri.parse(url));
        } else {
            vscode.env.openExternal(vscode.Uri.parse(`https://${region}.console.aws.amazon.com/amplify/home`));
        }
    }

    private _getHtmlContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Env Vars Troubleshooter</title>
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
        
        * { box-sizing: border-box; }
        
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
        
        .summary-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 12px;
            margin-bottom: 16px;
        }
        
        .summary-item {
            text-align: center;
            padding: 16px;
            border-radius: 8px;
            background: var(--vscode-input-background);
        }
        
        .summary-item .count {
            font-size: 32px;
            font-weight: bold;
        }
        
        .summary-item .label {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
        }
        
        .summary-item.errors .count { color: var(--error-color); }
        .summary-item.warnings .count { color: var(--warning-color); }
        .summary-item.info .count { color: var(--info-color); }
        .summary-item.sources .count { color: var(--success-color); }
        
        .framework-badge {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 8px 16px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 20px;
            font-size: 13px;
        }
        
        .source-list {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
        }
        
        .source-tag {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 6px 12px;
            background: var(--vscode-input-background);
            border-radius: 4px;
            font-size: 13px;
            cursor: pointer;
        }
        
        .source-tag:hover {
            background: var(--vscode-list-hoverBackground);
        }
        
        .source-count {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 2px 6px;
            border-radius: 10px;
            font-size: 11px;
        }
        
        .issue {
            display: flex;
            gap: 12px;
            padding: 12px;
            border-radius: 6px;
            margin-bottom: 8px;
            align-items: flex-start;
        }
        
        .issue:last-child { margin-bottom: 0; }
        
        .issue.error {
            background: rgba(244, 67, 54, 0.1);
            border-left: 3px solid var(--error-color);
        }
        
        .issue.warning {
            background: rgba(255, 152, 0, 0.1);
            border-left: 3px solid var(--warning-color);
        }
        
        .issue.info {
            background: rgba(33, 150, 243, 0.1);
            border-left: 3px solid var(--info-color);
        }
        
        .issue-icon { font-size: 18px; flex-shrink: 0; }
        
        .issue-content { flex: 1; min-width: 0; }
        
        .issue-header {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
        }
        
        .issue-variable {
            font-family: var(--vscode-editor-font-family);
            font-weight: bold;
            color: var(--vscode-textLink-foreground);
        }
        
        .issue-category {
            font-size: 11px;
            padding: 2px 6px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 3px;
        }
        
        .issue-message {
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
        }
        
        .issue-location {
            font-size: 12px;
            color: var(--vscode-textLink-foreground);
            cursor: pointer;
            margin-top: 4px;
        }
        
        .issue-location:hover { text-decoration: underline; }
        
        .issue-actions { margin-top: 8px; }
        
        button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            display: inline-flex;
            align-items: center;
            gap: 4px;
        }
        
        button:hover { background: var(--vscode-button-hoverBackground); }
        
        button.secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        
        .var-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
            gap: 8px;
        }
        
        .var-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 12px;
            background: var(--vscode-input-background);
            border-radius: 4px;
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
        }
        
        .var-status {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            flex-shrink: 0;
        }
        
        .var-status.ok { background: var(--success-color); }
        .var-status.missing { background: var(--error-color); }
        .var-status.warning { background: var(--warning-color); }
        
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
        
        @keyframes spin { to { transform: rotate(360deg); } }
        
        .empty-state {
            text-align: center;
            padding: 40px;
            color: var(--vscode-descriptionForeground);
        }
        
        .empty-state-icon {
            font-size: 48px;
            margin-bottom: 16px;
        }
        
        .tabs {
            display: flex;
            gap: 4px;
            margin-bottom: 16px;
            border-bottom: 1px solid var(--border-color);
        }
        
        .tab {
            padding: 8px 16px;
            cursor: pointer;
            border-bottom: 2px solid transparent;
            color: var(--vscode-descriptionForeground);
        }
        
        .tab:hover { color: var(--text-color); }
        
        .tab.active {
            color: var(--text-color);
            border-bottom-color: var(--vscode-focusBorder);
        }
        
        .tab-content { display: none; }
        .tab-content.active { display: block; }
    </style>
</head>
<body>
    <h1>🔧 Environment Variables Troubleshooter</h1>
    <p class="subtitle">Detect and fix env var issues before they cause build failures</p>
    
    <div id="content">
        <div class="loading">
            <div class="spinner"></div>
            Analyzing environment variables...
        </div>
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        let currentResult = null;
        let currentTab = 'issues';
        
        window.addEventListener('message', event => {
            const message = event.data;
            
            if (message.command === 'analysisResult') {
                if (message.error) {
                    showError(message.error);
                } else {
                    currentResult = message.result;
                    showResult(message.result);
                }
            }
        });
        
        function showError(error) {
            document.getElementById('content').innerHTML = \`
                <div class="card">
                    <div class="issue error">
                        <div class="issue-icon">❌</div>
                        <div class="issue-content">
                            <div class="issue-header">
                                <span class="issue-variable">Error</span>
                            </div>
                            <div class="issue-message">\${error}</div>
                        </div>
                    </div>
                </div>
            \`;
        }
        
        function showResult(result) {
            const html = \`
                <div class="card">
                    <div class="summary-grid">
                        <div class="summary-item errors">
                            <div class="count">\${result.summary.errors}</div>
                            <div class="label">Errors</div>
                        </div>
                        <div class="summary-item warnings">
                            <div class="count">\${result.summary.warnings}</div>
                            <div class="label">Warnings</div>
                        </div>
                        <div class="summary-item info">
                            <div class="count">\${result.summary.info}</div>
                            <div class="label">Info</div>
                        </div>
                        <div class="summary-item sources">
                            <div class="count">\${result.sources.length}</div>
                            <div class="label">Sources</div>
                        </div>
                    </div>
                    
                    \${result.framework ? \`
                        <div style="margin-bottom: 12px;">
                            <span class="framework-badge">
                                📦 \${result.framework.name} detected
                                \${result.framework.clientSidePrefix ? \`<span style="opacity: 0.7">(prefix: \${result.framework.clientSidePrefix})</span>\` : ''}
                            </span>
                        </div>
                    \` : ''}
                    
                    <div class="source-list">
                        \${result.sources.map(s => \`
                            <span class="source-tag" \${s.file ? \`onclick="openFile('\${s.file.replace(/\\\\/g, '\\\\\\\\')}')"\` : ''}>
                                📄 \${s.name}
                                <span class="source-count">\${s.variables ? Object.keys(s.variables).length : 0}</span>
                            </span>
                        \`).join('')}
                    </div>
                </div>
                
                <div class="tabs">
                    <div class="tab \${currentTab === 'issues' ? 'active' : ''}" onclick="switchTab('issues')">
                        Issues (\${result.summary.total})
                    </div>
                    <div class="tab \${currentTab === 'variables' ? 'active' : ''}" onclick="switchTab('variables')">
                        All Variables (\${Object.keys(result.codeReferences).length})
                    </div>
                </div>
                
                <div id="tab-issues" class="tab-content \${currentTab === 'issues' ? 'active' : ''}">
                    \${result.issues.length === 0 ? \`
                        <div class="empty-state">
                            <div class="empty-state-icon">✅</div>
                            <div>No issues found! Your environment variables look good.</div>
                        </div>
                    \` : \`
                        <div class="card">
                            <h2>🚨 Issues Found</h2>
                            \${result.issues.map(issue => \`
                                <div class="issue \${issue.type}">
                                    <div class="issue-icon">\${getIssueIcon(issue.type)}</div>
                                    <div class="issue-content">
                                        <div class="issue-header">
                                            <span class="issue-variable">\${issue.variable}</span>
                                            <span class="issue-category">\${issue.category}</span>
                                        </div>
                                        <div class="issue-message">\${issue.message}</div>
                                        \${issue.file ? \`
                                            <div class="issue-location" onclick="openFile('\${issue.file.replace(/\\\\/g, '\\\\\\\\')}', \${issue.line || 0})">
                                                📍 \${issue.file}\${issue.line ? ':' + issue.line : ''}
                                            </div>
                                        \` : ''}
                                        \${issue.fix ? \`
                                            <div class="issue-actions">
                                                <button onclick="applyFix(\${JSON.stringify(issue.fix).replace(/"/g, '&quot;')}, '\${issue.variable}')">
                                                    🔧 \${issue.fix.description}
                                                </button>
                                            </div>
                                        \` : ''}
                                    </div>
                                </div>
                            \`).join('')}
                        </div>
                    \`}
                </div>
                
                <div id="tab-variables" class="tab-content \${currentTab === 'variables' ? 'active' : ''}">
                    <div class="card">
                        <h2>📋 Variables Found in Code</h2>
                        \${Object.keys(result.codeReferences).length === 0 ? \`
                            <div class="empty-state">
                                <div>No environment variable references found in code.</div>
                            </div>
                        \` : \`
                            <div class="var-grid">
                                \${Object.entries(result.codeReferences).map(([varName, refs]) => {
                                    const hasIssue = result.issues.some(i => i.variable === varName && i.type === 'error');
                                    const hasWarning = result.issues.some(i => i.variable === varName && i.type === 'warning');
                                    const status = hasIssue ? 'missing' : hasWarning ? 'warning' : 'ok';
                                    return \`
                                        <div class="var-item" onclick="openFile('\${refs[0].file.replace(/\\\\/g, '\\\\\\\\')}', \${refs[0].line})" style="cursor: pointer;">
                                            <span>\${varName}</span>
                                            <span class="var-status \${status}" title="\${status}"></span>
                                        </div>
                                    \`;
                                }).join('')}
                            </div>
                        \`}
                    </div>
                </div>
                
                <div class="card" style="display: flex; gap: 8px; flex-wrap: wrap;">
                    <button onclick="refresh()">🔄 Re-analyze</button>
                    <button class="secondary" onclick="openAmplifyConsole()">🔗 Open Amplify Console</button>
                </div>
            \`;
            
            document.getElementById('content').innerHTML = html;
        }
        
        function getIssueIcon(type) {
            const icons = { error: '❌', warning: '⚠️', info: '💡' };
            return icons[type] || '📌';
        }
        
        function switchTab(tab) {
            currentTab = tab;
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
            document.querySelector(\`.tab:nth-child(\${tab === 'issues' ? 1 : 2})\`).classList.add('active');
            document.getElementById('tab-' + tab).classList.add('active');
        }
        
        function applyFix(fix, variable) {
            vscode.postMessage({ command: 'applyFix', fix, variable });
        }
        
        function openFile(file, line) {
            vscode.postMessage({ command: 'openFile', file, line });
        }
        
        function openAmplifyConsole() {
            vscode.postMessage({ command: 'openAmplifyConsole' });
        }
        
        function refresh() {
            document.getElementById('content').innerHTML = \`
                <div class="loading">
                    <div class="spinner"></div>
                    Analyzing environment variables...
                </div>
            \`;
            vscode.postMessage({ command: 'analyze' });
        }
    </script>
</body>
</html>`;
    }
}
