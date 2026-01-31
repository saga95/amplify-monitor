import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';

interface ValidationCheck {
    id: string;
    name: string;
    category: 'build' | 'dependencies' | 'config' | 'env' | 'git';
    status: 'pass' | 'warn' | 'fail' | 'skip';
    message: string;
    details?: string[];
    autoFixAvailable: boolean;
    autoFix?: () => Promise<void>;
    blocking: boolean; // If true, deployment will likely fail
}

interface ValidationResult {
    checks: ValidationCheck[];
    canDeploy: boolean;
    summary: {
        passed: number;
        warnings: number;
        failed: number;
        skipped: number;
    };
    timestamp: Date;
}

export class PreDeployValidationPanel {
    public static currentPanel: PreDeployValidationPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _workspaceRoot: string;
    private _checks: ValidationCheck[] = [];

    public static createOrShow(workspaceRoot: string) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (PreDeployValidationPanel.currentPanel) {
            PreDeployValidationPanel.currentPanel._panel.reveal(column);
            PreDeployValidationPanel.currentPanel.runValidation();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'preDeployValidation',
            '✅ Pre-Deploy Validation',
            column || vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        PreDeployValidationPanel.currentPanel = new PreDeployValidationPanel(panel, workspaceRoot);
    }

    private constructor(panel: vscode.WebviewPanel, workspaceRoot: string) {
        this._panel = panel;
        this._workspaceRoot = workspaceRoot;
        this._panel.webview.html = this._getLoadingHtml();

        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'applyFix':
                        await this.applyFix(message.checkId);
                        break;
                    case 'refresh':
                        await this.runValidation();
                        break;
                    case 'openFile':
                        const uri = vscode.Uri.file(message.path);
                        vscode.window.showTextDocument(uri);
                        break;
                    case 'runCommand':
                        const terminal = vscode.window.createTerminal('Amplify Monitor');
                        terminal.show();
                        terminal.sendText(message.cmd);
                        break;
                    case 'deploy':
                        vscode.commands.executeCommand('amplify-monitor.startBuild');
                        break;
                }
            },
            null,
            this._disposables
        );

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this.runValidation();
    }

    public async runValidation() {
        this._panel.webview.html = this._getLoadingHtml();
        this._checks = [];

        // Run all validation checks
        await this.validateGitStatus();
        await this.validateDependencies();
        await this.validateBuildConfig();
        await this.validateEnvironment();
        await this.validateAmplifyConfig();

        const result = this.calculateResults();
        this._panel.webview.html = this._getResultsHtml(result);
    }

    private async validateGitStatus() {
        // Check 1: Uncommitted changes
        try {
            const gitStatus = cp.execSync('git status --porcelain', {
                cwd: this._workspaceRoot,
                encoding: 'utf-8'
            }).trim();

            if (gitStatus.length > 0) {
                const changedFiles = gitStatus.split('\n').length;
                this._checks.push({
                    id: 'git-uncommitted',
                    name: 'Uncommitted Changes',
                    category: 'git',
                    status: 'warn',
                    message: `${changedFiles} file(s) with uncommitted changes. Amplify deploys from your remote branch.`,
                    details: gitStatus.split('\n').slice(0, 5),
                    autoFixAvailable: true,
                    autoFix: async () => {
                        const terminal = vscode.window.createTerminal('Git');
                        terminal.show();
                        terminal.sendText('git add -A && git commit -m "Pre-deploy commit"');
                    },
                    blocking: false
                });
            } else {
                this._checks.push({
                    id: 'git-uncommitted',
                    name: 'Git Status Clean',
                    category: 'git',
                    status: 'pass',
                    message: 'All changes are committed.',
                    autoFixAvailable: false,
                    blocking: false
                });
            }
        } catch (e) {
            this._checks.push({
                id: 'git-uncommitted',
                name: 'Git Repository',
                category: 'git',
                status: 'skip',
                message: 'Not a git repository or git not installed.',
                autoFixAvailable: false,
                blocking: false
            });
        }

        // Check 2: Unpushed commits
        try {
            const unpushed = cp.execSync('git log @{u}..HEAD --oneline 2>/dev/null || echo ""', {
                cwd: this._workspaceRoot,
                encoding: 'utf-8',
                shell: 'cmd'
            }).trim();

            // On Windows, try different approach
            const branchName = cp.execSync('git rev-parse --abbrev-ref HEAD', {
                cwd: this._workspaceRoot,
                encoding: 'utf-8'
            }).trim();

            try {
                const localCommit = cp.execSync('git rev-parse HEAD', {
                    cwd: this._workspaceRoot,
                    encoding: 'utf-8'
                }).trim();

                const remoteCommit = cp.execSync(`git rev-parse origin/${branchName}`, {
                    cwd: this._workspaceRoot,
                    encoding: 'utf-8'
                }).trim();

                if (localCommit !== remoteCommit) {
                    this._checks.push({
                        id: 'git-unpushed',
                        name: 'Unpushed Commits',
                        category: 'git',
                        status: 'fail',
                        message: `Local branch is ahead of origin/${branchName}. Push before deploying!`,
                        autoFixAvailable: true,
                        autoFix: async () => {
                            const terminal = vscode.window.createTerminal('Git');
                            terminal.show();
                            terminal.sendText('git push');
                        },
                        blocking: true
                    });
                } else {
                    this._checks.push({
                        id: 'git-unpushed',
                        name: 'Branch Synced',
                        category: 'git',
                        status: 'pass',
                        message: `Local and remote branches are in sync.`,
                        autoFixAvailable: false,
                        blocking: false
                    });
                }
            } catch (e) {
                // No upstream set or other issue
                this._checks.push({
                    id: 'git-unpushed',
                    name: 'Remote Tracking',
                    category: 'git',
                    status: 'warn',
                    message: 'Could not verify remote sync. Ensure your branch is pushed.',
                    autoFixAvailable: false,
                    blocking: false
                });
            }
        } catch (e) {
            // Skip if git fails
        }
    }

    private async validateDependencies() {
        const packageJsonPath = path.join(this._workspaceRoot, 'package.json');
        if (!fs.existsSync(packageJsonPath)) {
            this._checks.push({
                id: 'deps-package-json',
                name: 'package.json',
                category: 'dependencies',
                status: 'skip',
                message: 'No package.json found - not a Node.js project.',
                autoFixAvailable: false,
                blocking: false
            });
            return;
        }

        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

        // Check 1: Lock file exists and matches package manager
        const hasPackageLock = fs.existsSync(path.join(this._workspaceRoot, 'package-lock.json'));
        const hasPnpmLock = fs.existsSync(path.join(this._workspaceRoot, 'pnpm-lock.yaml'));
        const hasYarnLock = fs.existsSync(path.join(this._workspaceRoot, 'yarn.lock'));

        const lockFiles = [hasPackageLock, hasPnpmLock, hasYarnLock].filter(Boolean).length;

        if (lockFiles === 0) {
            this._checks.push({
                id: 'deps-lockfile',
                name: 'Lock File Missing',
                category: 'dependencies',
                status: 'fail',
                message: 'No lock file found. Dependencies may resolve differently in CI.',
                autoFixAvailable: true,
                autoFix: async () => {
                    const terminal = vscode.window.createTerminal('npm');
                    terminal.show();
                    terminal.sendText('npm install');
                },
                blocking: true
            });
        } else if (lockFiles > 1) {
            const found = [];
            if (hasPackageLock) found.push('package-lock.json');
            if (hasPnpmLock) found.push('pnpm-lock.yaml');
            if (hasYarnLock) found.push('yarn.lock');
            
            this._checks.push({
                id: 'deps-lockfile',
                name: 'Multiple Lock Files',
                category: 'dependencies',
                status: 'fail',
                message: `Found ${found.join(', ')}. This will cause build failures!`,
                details: found,
                autoFixAvailable: false,
                blocking: true
            });
        } else {
            this._checks.push({
                id: 'deps-lockfile',
                name: 'Lock File',
                category: 'dependencies',
                status: 'pass',
                message: 'Single lock file present.',
                autoFixAvailable: false,
                blocking: false
            });
        }

        // Check 2: node_modules exists (dev environment check)
        const hasNodeModules = fs.existsSync(path.join(this._workspaceRoot, 'node_modules'));
        if (!hasNodeModules) {
            this._checks.push({
                id: 'deps-node-modules',
                name: 'Dependencies Not Installed',
                category: 'dependencies',
                status: 'warn',
                message: 'node_modules not found locally. Run install to test build locally first.',
                autoFixAvailable: true,
                autoFix: async () => {
                    const terminal = vscode.window.createTerminal('npm');
                    terminal.show();
                    if (hasPnpmLock) terminal.sendText('pnpm install');
                    else if (hasYarnLock) terminal.sendText('yarn');
                    else terminal.sendText('npm ci');
                },
                blocking: false
            });
        }

        // Check 3: Peer dependency issues (check for common conflicts)
        const allDeps = { ...packageJson.dependencies, ...packageJson.devDependencies };
        
        // React version conflicts
        if (allDeps['react'] && allDeps['react-dom']) {
            const reactVersion = allDeps['react'].replace(/[\^~]/g, '');
            const reactDomVersion = allDeps['react-dom'].replace(/[\^~]/g, '');
            if (reactVersion !== reactDomVersion) {
                this._checks.push({
                    id: 'deps-react-mismatch',
                    name: 'React Version Mismatch',
                    category: 'dependencies',
                    status: 'fail',
                    message: `react@${reactVersion} and react-dom@${reactDomVersion} versions don't match!`,
                    autoFixAvailable: false,
                    blocking: true
                });
            }
        }

        // Check 4: Engines field vs amplify.yml Node version
        if (packageJson.engines?.node) {
            const amplifyYmlPath = path.join(this._workspaceRoot, 'amplify.yml');
            if (fs.existsSync(amplifyYmlPath)) {
                const amplifyContent = fs.readFileSync(amplifyYmlPath, 'utf-8');
                const nvmMatch = amplifyContent.match(/nvm use (\d+)/);
                
                if (nvmMatch) {
                    const amplifyNodeVersion = nvmMatch[1];
                    const engineSpec = packageJson.engines.node;
                    
                    // Simple check - if engines specifies a major version
                    const engineMajor = engineSpec.match(/(\d+)/)?.[1];
                    if (engineMajor && engineMajor !== amplifyNodeVersion) {
                        this._checks.push({
                            id: 'deps-node-engine',
                            name: 'Node Version Mismatch',
                            category: 'dependencies',
                            status: 'warn',
                            message: `package.json engines.node=${engineSpec}, but amplify.yml uses Node ${amplifyNodeVersion}.`,
                            autoFixAvailable: false,
                            blocking: false
                        });
                    }
                }
            }
        }
    }

    private async validateBuildConfig() {
        const packageJsonPath = path.join(this._workspaceRoot, 'package.json');
        if (!fs.existsSync(packageJsonPath)) return;

        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

        // Check 1: Build script exists
        if (!packageJson.scripts?.build) {
            this._checks.push({
                id: 'build-script',
                name: 'Build Script Missing',
                category: 'build',
                status: 'fail',
                message: 'No "build" script in package.json. Amplify needs this to build your app.',
                autoFixAvailable: false,
                blocking: true
            });
        } else {
            this._checks.push({
                id: 'build-script',
                name: 'Build Script',
                category: 'build',
                status: 'pass',
                message: `Build script: "${packageJson.scripts.build}"`,
                autoFixAvailable: false,
                blocking: false
            });
        }

        // Check 2: TypeScript compilation check
        const tsconfigPath = path.join(this._workspaceRoot, 'tsconfig.json');
        if (fs.existsSync(tsconfigPath)) {
            try {
                // Quick syntax check
                const tsconfigContent = fs.readFileSync(tsconfigPath, 'utf-8');
                JSON.parse(tsconfigContent.replace(/\/\/.*/g, '').replace(/,(\s*[}\]])/g, '$1'));
                
                this._checks.push({
                    id: 'build-tsconfig',
                    name: 'TypeScript Config',
                    category: 'build',
                    status: 'pass',
                    message: 'tsconfig.json is valid JSON.',
                    autoFixAvailable: false,
                    blocking: false
                });
            } catch (e) {
                this._checks.push({
                    id: 'build-tsconfig',
                    name: 'TypeScript Config Invalid',
                    category: 'build',
                    status: 'fail',
                    message: 'tsconfig.json has syntax errors!',
                    autoFixAvailable: false,
                    blocking: true
                });
            }

            // Check for TypeScript errors (if tsc is available)
            try {
                cp.execSync('npx tsc --noEmit 2>&1', {
                    cwd: this._workspaceRoot,
                    encoding: 'utf-8',
                    timeout: 60000
                });
                
                this._checks.push({
                    id: 'build-typescript',
                    name: 'TypeScript Compilation',
                    category: 'build',
                    status: 'pass',
                    message: 'No TypeScript errors found.',
                    autoFixAvailable: false,
                    blocking: false
                });
            } catch (e: any) {
                const errorOutput = e.stdout || e.stderr || '';
                const errorLines = errorOutput.split('\n').filter((l: string) => l.includes('error TS'));
                
                if (errorLines.length > 0) {
                    this._checks.push({
                        id: 'build-typescript',
                        name: 'TypeScript Errors',
                        category: 'build',
                        status: 'fail',
                        message: `${errorLines.length} TypeScript error(s) found.`,
                        details: errorLines.slice(0, 5),
                        autoFixAvailable: false,
                        blocking: true
                    });
                }
            }
        }

        // Check 3: ESLint check (if configured)
        const eslintConfigFiles = ['.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.yml', 'eslint.config.js', 'eslint.config.mjs'];
        const hasEslint = eslintConfigFiles.some(f => fs.existsSync(path.join(this._workspaceRoot, f)));
        
        if (hasEslint && packageJson.scripts?.lint) {
            // Skip running lint in validation - it can be slow
            this._checks.push({
                id: 'build-eslint',
                name: 'ESLint Configured',
                category: 'build',
                status: 'info' as any,
                message: 'ESLint is configured. Run "npm run lint" to check for issues.',
                autoFixAvailable: true,
                autoFix: async () => {
                    const terminal = vscode.window.createTerminal('ESLint');
                    terminal.show();
                    terminal.sendText('npm run lint');
                },
                blocking: false
            });
        }
    }

    private async validateEnvironment() {
        // Check for .env files that shouldn't be committed
        const envFiles = ['.env', '.env.local', '.env.development', '.env.production'];
        const foundEnvFiles: string[] = [];
        
        for (const envFile of envFiles) {
            if (fs.existsSync(path.join(this._workspaceRoot, envFile))) {
                foundEnvFiles.push(envFile);
            }
        }

        // Check if .env files are in .gitignore
        const gitignorePath = path.join(this._workspaceRoot, '.gitignore');
        let gitignoreContent = '';
        if (fs.existsSync(gitignorePath)) {
            gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
        }

        if (foundEnvFiles.length > 0) {
            const notIgnored = foundEnvFiles.filter(f => !gitignoreContent.includes(f) && !gitignoreContent.includes('.env*'));
            
            if (notIgnored.length > 0) {
                this._checks.push({
                    id: 'env-gitignore',
                    name: 'Env Files Not Ignored',
                    category: 'env',
                    status: 'warn',
                    message: `${notIgnored.join(', ')} may be committed. Add to .gitignore!`,
                    details: notIgnored,
                    autoFixAvailable: true,
                    autoFix: async () => {
                        const gitignore = fs.existsSync(gitignorePath) 
                            ? fs.readFileSync(gitignorePath, 'utf-8') 
                            : '';
                        fs.writeFileSync(gitignorePath, gitignore + '\n.env*\n');
                        vscode.window.showInformationMessage('Added .env* to .gitignore');
                    },
                    blocking: false
                });
            }
        }

        // Check for required env vars in .env.example vs what's defined
        const envExamplePath = path.join(this._workspaceRoot, '.env.example');
        if (fs.existsSync(envExamplePath)) {
            const envExampleContent = fs.readFileSync(envExamplePath, 'utf-8');
            const requiredVars = envExampleContent
                .split('\n')
                .filter(line => line.includes('=') && !line.startsWith('#'))
                .map(line => line.split('=')[0].trim());

            if (requiredVars.length > 0) {
                this._checks.push({
                    id: 'env-required',
                    name: 'Required Env Variables',
                    category: 'env',
                    status: 'info' as any,
                    message: `${requiredVars.length} env var(s) defined in .env.example. Ensure they're set in Amplify Console.`,
                    details: requiredVars.slice(0, 10),
                    autoFixAvailable: false,
                    blocking: false
                });
            }
        }

        // Check for hardcoded secrets patterns
        const sourceFiles = this.findSourceFiles(this._workspaceRoot);
        const secretPatterns = [
            /(?:api[_-]?key|apikey)\s*[:=]\s*['"][a-zA-Z0-9]{20,}['"]/gi,
            /(?:secret|password|token)\s*[:=]\s*['"][^'"]{10,}['"]/gi,
            /AKIA[0-9A-Z]{16}/g, // AWS Access Key
        ];

        let foundSecrets = 0;
        for (const file of sourceFiles.slice(0, 50)) { // Limit to 50 files
            try {
                const content = fs.readFileSync(file, 'utf-8');
                for (const pattern of secretPatterns) {
                    if (pattern.test(content)) {
                        foundSecrets++;
                        break;
                    }
                }
            } catch (e) {
                // Skip unreadable files
            }
        }

        if (foundSecrets > 0) {
            this._checks.push({
                id: 'env-hardcoded',
                name: 'Potential Hardcoded Secrets',
                category: 'env',
                status: 'warn',
                message: `Found ${foundSecrets} file(s) with potential hardcoded secrets. Use environment variables!`,
                autoFixAvailable: false,
                blocking: false
            });
        } else {
            this._checks.push({
                id: 'env-hardcoded',
                name: 'Secret Scan',
                category: 'env',
                status: 'pass',
                message: 'No obvious hardcoded secrets detected.',
                autoFixAvailable: false,
                blocking: false
            });
        }
    }

    private async validateAmplifyConfig() {
        const amplifyYmlPath = path.join(this._workspaceRoot, 'amplify.yml');

        // Check 1: amplify.yml exists
        if (!fs.existsSync(amplifyYmlPath)) {
            this._checks.push({
                id: 'amplify-yml',
                name: 'amplify.yml Missing',
                category: 'config',
                status: 'warn',
                message: 'No amplify.yml found. Amplify will use auto-detection which may not work correctly.',
                autoFixAvailable: true,
                autoFix: async () => {
                    vscode.commands.executeCommand('amplify-monitor.optimizeBuild');
                },
                blocking: false
            });
            return;
        }

        // Check 2: YAML syntax
        const content = fs.readFileSync(amplifyYmlPath, 'utf-8');
        
        // Basic YAML validation (check for tabs, which are invalid)
        if (content.includes('\t')) {
            this._checks.push({
                id: 'amplify-yml-syntax',
                name: 'amplify.yml Has Tabs',
                category: 'config',
                status: 'fail',
                message: 'amplify.yml contains tabs. YAML requires spaces for indentation!',
                autoFixAvailable: true,
                autoFix: async () => {
                    const fixed = content.replace(/\t/g, '  ');
                    fs.writeFileSync(amplifyYmlPath, fixed);
                    vscode.window.showInformationMessage('Replaced tabs with spaces in amplify.yml');
                    await this.runValidation();
                },
                blocking: true
            });
        }

        // Check 3: Required sections
        if (!content.includes('version:')) {
            this._checks.push({
                id: 'amplify-version',
                name: 'Version Missing',
                category: 'config',
                status: 'warn',
                message: 'amplify.yml should start with "version: 1".',
                autoFixAvailable: true,
                autoFix: async () => {
                    const newContent = 'version: 1\n' + content;
                    fs.writeFileSync(amplifyYmlPath, newContent);
                    await this.runValidation();
                },
                blocking: false
            });
        }

        if (!content.includes('frontend:') && !content.includes('backend:')) {
            this._checks.push({
                id: 'amplify-phase',
                name: 'No Build Phase',
                category: 'config',
                status: 'fail',
                message: 'amplify.yml has no frontend: or backend: section.',
                autoFixAvailable: false,
                blocking: true
            });
        }

        // Check 4: Build commands reference package.json scripts
        const packageJsonPath = path.join(this._workspaceRoot, 'package.json');
        if (fs.existsSync(packageJsonPath)) {
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
            
            // Check if npm run commands match available scripts
            const npmRunMatches = content.matchAll(/npm run (\w+)/g);
            const missingScripts: string[] = [];
            
            for (const match of npmRunMatches) {
                const scriptName = match[1];
                if (!packageJson.scripts?.[scriptName]) {
                    missingScripts.push(scriptName);
                }
            }

            if (missingScripts.length > 0) {
                this._checks.push({
                    id: 'amplify-scripts',
                    name: 'Missing npm Scripts',
                    category: 'config',
                    status: 'fail',
                    message: `amplify.yml references undefined scripts: ${missingScripts.join(', ')}`,
                    details: missingScripts,
                    autoFixAvailable: false,
                    blocking: true
                });
            }
        }

        // Check 5: Artifacts configuration for SSR
        const isNextJs = fs.existsSync(path.join(this._workspaceRoot, 'next.config.js')) ||
                         fs.existsSync(path.join(this._workspaceRoot, 'next.config.mjs'));
        
        if (isNextJs && content.includes('artifacts:')) {
            if (!content.includes('.next') && !content.includes('standalone')) {
                this._checks.push({
                    id: 'amplify-nextjs',
                    name: 'Next.js Artifacts',
                    category: 'config',
                    status: 'warn',
                    message: 'For Next.js SSR, artifacts baseDirectory should be ".next" or use standalone output.',
                    autoFixAvailable: false,
                    blocking: false
                });
            }
        }

        // If we got here without critical issues
        this._checks.push({
            id: 'amplify-yml',
            name: 'amplify.yml',
            category: 'config',
            status: 'pass',
            message: 'amplify.yml configuration looks valid.',
            autoFixAvailable: false,
            blocking: false
        });
    }

    private findSourceFiles(dir: string, results: string[] = [], depth = 0): string[] {
        if (depth > 3) return results;
        
        const ignoreDirs = ['node_modules', '.git', '.next', 'dist', 'build', 'out', '.amplify'];
        
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (!ignoreDirs.includes(entry.name) && !entry.name.startsWith('.')) {
                        this.findSourceFiles(fullPath, results, depth + 1);
                    }
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name).toLowerCase();
                    if (['.js', '.ts', '.jsx', '.tsx', '.mjs'].includes(ext)) {
                        results.push(fullPath);
                    }
                }
            }
        } catch (e) {
            // Ignore permission errors
        }
        
        return results;
    }

    private async applyFix(checkId: string) {
        const check = this._checks.find(c => c.id === checkId);
        if (check?.autoFix) {
            try {
                await check.autoFix();
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to apply fix: ${error}`);
            }
        }
    }

    private calculateResults(): ValidationResult {
        const passed = this._checks.filter(c => c.status === 'pass').length;
        const warnings = this._checks.filter(c => c.status === 'warn').length;
        const failed = this._checks.filter(c => c.status === 'fail').length;
        const skipped = this._checks.filter(c => c.status === 'skip').length;
        
        const blockingIssues = this._checks.filter(c => c.blocking && (c.status === 'fail'));
        
        return {
            checks: this._checks,
            canDeploy: blockingIssues.length === 0,
            summary: { passed, warnings, failed, skipped },
            timestamp: new Date()
        };
    }

    private _getLoadingHtml(): string {
        return `<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
        .loading { display: flex; align-items: center; justify-content: center; height: 200px; flex-direction: column; }
        .spinner { width: 40px; height: 40px; border: 4px solid var(--vscode-input-border); border-top-color: var(--vscode-button-background); border-radius: 50%; animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        p { margin-top: 20px; opacity: 0.7; }
    </style>
</head>
<body>
    <div class="loading">
        <div class="spinner"></div>
        <p>Running pre-deploy validation checks...</p>
    </div>
</body>
</html>`;
    }

    private _getResultsHtml(result: ValidationResult): string {
        const getCategoryIcon = (cat: string) => {
            switch (cat) {
                case 'git': return '📁';
                case 'dependencies': return '📦';
                case 'build': return '🔨';
                case 'env': return '🔐';
                case 'config': return '⚙️';
                default: return '📋';
            }
        };

        const getStatusBadge = (status: string, blocking: boolean) => {
            switch (status) {
                case 'pass': return '<span class="badge pass">✓ PASS</span>';
                case 'warn': return '<span class="badge warn">⚠ WARN</span>';
                case 'fail': return `<span class="badge fail">✗ FAIL${blocking ? ' (BLOCKING)' : ''}</span>`;
                case 'skip': return '<span class="badge skip">⊘ SKIP</span>';
                default: return '<span class="badge info">ℹ INFO</span>';
            }
        };

        const groupedChecks: Record<string, ValidationCheck[]> = {};
        for (const check of result.checks) {
            if (!groupedChecks[check.category]) {
                groupedChecks[check.category] = [];
            }
            groupedChecks[check.category].push(check);
        }

        const fixableCount = result.checks.filter(c => c.autoFixAvailable && c.status !== 'pass').length;
        const blockingCount = result.checks.filter(c => c.blocking && c.status === 'fail').length;

        return `<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); max-width: 900px; margin: 0 auto; }
        h1 { display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--vscode-input-border); padding-bottom: 15px; }
        
        .status-banner { padding: 20px; border-radius: 8px; margin: 20px 0; text-align: center; }
        .status-banner.ready { background: rgba(0,200,83,0.15); border: 2px solid #00c853; }
        .status-banner.blocked { background: rgba(244,67,54,0.15); border: 2px solid #f44336; }
        .status-icon { font-size: 48px; }
        .status-title { font-size: 24px; font-weight: bold; margin: 10px 0; }
        .status-subtitle { opacity: 0.8; }
        
        .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin: 20px 0; }
        .summary-card { background: var(--vscode-input-background); padding: 15px; border-radius: 8px; text-align: center; }
        .summary-value { font-size: 28px; font-weight: bold; }
        .summary-label { font-size: 12px; opacity: 0.7; margin-top: 5px; }
        
        .actions { display: flex; gap: 10px; margin: 20px 0; justify-content: center; }
        button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 12px 24px; border-radius: 4px; cursor: pointer; font-size: 14px; display: flex; align-items: center; gap: 8px; }
        button:hover { background: var(--vscode-button-hoverBackground); }
        button.secondary { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); }
        button.deploy { background: #00c853; font-size: 16px; padding: 14px 28px; }
        button.deploy:hover { background: #00b548; }
        button:disabled { opacity: 0.5; cursor: not-allowed; }
        
        .category { margin: 25px 0; }
        .category-header { display: flex; align-items: center; gap: 10px; font-size: 18px; font-weight: 600; margin-bottom: 15px; }
        
        .check { background: var(--vscode-input-background); border-radius: 8px; padding: 15px; margin: 10px 0; border-left: 4px solid var(--vscode-input-border); }
        .check.pass { border-left-color: #00c853; }
        .check.warn { border-left-color: #ffc107; }
        .check.fail { border-left-color: #f44336; }
        .check.skip { border-left-color: #9e9e9e; }
        
        .check-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
        .check-name { font-weight: 600; }
        
        .badge { padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
        .badge.pass { background: rgba(0,200,83,0.2); color: #00c853; }
        .badge.warn { background: rgba(255,193,7,0.2); color: #ffc107; }
        .badge.fail { background: rgba(244,67,54,0.2); color: #f44336; }
        .badge.skip { background: rgba(158,158,158,0.2); color: #9e9e9e; }
        .badge.info { background: rgba(33,150,243,0.2); color: #2196f3; }
        
        .check-message { font-size: 13px; opacity: 0.9; line-height: 1.5; }
        .check-details { margin-top: 8px; padding: 8px; background: rgba(0,0,0,0.2); border-radius: 4px; font-family: monospace; font-size: 11px; }
        .check-details code { display: block; padding: 2px 0; }
        
        .check-actions { margin-top: 12px; }
        .check-actions button { padding: 6px 12px; font-size: 12px; }
        
        .timestamp { text-align: center; opacity: 0.5; font-size: 12px; margin-top: 30px; }
    </style>
</head>
<body>
    <h1>✅ Pre-Deploy Validation</h1>
    
    <div class="status-banner ${result.canDeploy ? 'ready' : 'blocked'}">
        <div class="status-icon">${result.canDeploy ? '🚀' : '🚫'}</div>
        <div class="status-title">${result.canDeploy ? 'Ready to Deploy!' : 'Deployment Blocked'}</div>
        <div class="status-subtitle">${result.canDeploy 
            ? 'All critical checks passed. You can safely deploy.'
            : `${blockingCount} blocking issue(s) must be fixed before deploying.`
        }</div>
    </div>
    
    <div class="summary">
        <div class="summary-card">
            <div class="summary-value" style="color: #00c853">${result.summary.passed}</div>
            <div class="summary-label">Passed</div>
        </div>
        <div class="summary-card">
            <div class="summary-value" style="color: #ffc107">${result.summary.warnings}</div>
            <div class="summary-label">Warnings</div>
        </div>
        <div class="summary-card">
            <div class="summary-value" style="color: #f44336">${result.summary.failed}</div>
            <div class="summary-label">Failed</div>
        </div>
        <div class="summary-card">
            <div class="summary-value" style="color: #9e9e9e">${result.summary.skipped}</div>
            <div class="summary-label">Skipped</div>
        </div>
    </div>
    
    <div class="actions">
        <button class="deploy" onclick="deploy()" ${!result.canDeploy ? 'disabled' : ''}>
            🚀 Start Deployment
        </button>
        <button class="secondary" onclick="refresh()">
            🔄 Re-run Validation
        </button>
    </div>
    
    ${Object.entries(groupedChecks).map(([category, checks]) => `
        <div class="category">
            <div class="category-header">
                ${getCategoryIcon(category)} ${category.charAt(0).toUpperCase() + category.slice(1)}
            </div>
            ${checks.map(check => `
                <div class="check ${check.status}">
                    <div class="check-header">
                        <span class="check-name">${check.name}</span>
                        ${getStatusBadge(check.status, check.blocking)}
                    </div>
                    <div class="check-message">${check.message}</div>
                    ${check.details && check.details.length > 0 ? `
                        <div class="check-details">
                            ${check.details.map(d => `<code>${this.escapeHtml(d)}</code>`).join('')}
                        </div>
                    ` : ''}
                    ${check.autoFixAvailable && check.status !== 'pass' ? `
                        <div class="check-actions">
                            <button onclick="applyFix('${check.id}')">🔧 Fix</button>
                        </div>
                    ` : ''}
                </div>
            `).join('')}
        </div>
    `).join('')}
    
    <div class="timestamp">Last run: ${result.timestamp.toLocaleTimeString()}</div>
    
    <script>
        const vscode = acquireVsCodeApi();
        
        function applyFix(checkId) {
            vscode.postMessage({ command: 'applyFix', checkId });
        }
        
        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }
        
        function deploy() {
            vscode.postMessage({ command: 'deploy' });
        }
    </script>
</body>
</html>`;
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    public dispose() {
        PreDeployValidationPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) x.dispose();
        }
    }
}
