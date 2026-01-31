import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface OptimizationCheck {
    id: string;
    name: string;
    category: 'cache' | 'dependencies' | 'build' | 'assets' | 'config';
    status: 'pass' | 'warn' | 'fail' | 'info';
    message: string;
    impact: 'high' | 'medium' | 'low';
    autoFixAvailable: boolean;
    autoFix?: () => Promise<void>;
    docsUrl?: string;
}

interface OptimizationResult {
    checks: OptimizationCheck[];
    score: number;
    estimatedSavings: string;
    summary: {
        passed: number;
        warnings: number;
        failed: number;
    };
}

export class BuildOptimizationWizard {
    public static currentPanel: BuildOptimizationWizard | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _workspaceRoot: string;

    public static createOrShow(workspaceRoot: string) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (BuildOptimizationWizard.currentPanel) {
            BuildOptimizationWizard.currentPanel._panel.reveal(column);
            BuildOptimizationWizard.currentPanel.analyze();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'buildOptimizationWizard',
            '🧙 Build Optimization Wizard',
            column || vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        BuildOptimizationWizard.currentPanel = new BuildOptimizationWizard(panel, workspaceRoot);
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
                    case 'applyAll':
                        await this.applyAllFixes();
                        break;
                    case 'refresh':
                        await this.analyze();
                        break;
                    case 'openDocs':
                        if (message.url) {
                            vscode.env.openExternal(vscode.Uri.parse(message.url));
                        }
                        break;
                    case 'openFile':
                        const uri = vscode.Uri.file(message.path);
                        vscode.window.showTextDocument(uri);
                        break;
                }
            },
            null,
            this._disposables
        );

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this.analyze();
    }

    private _checks: OptimizationCheck[] = [];

    public async analyze() {
        this._panel.webview.html = this._getLoadingHtml();
        this._checks = [];

        // Run all optimization checks
        await this.checkCaching();
        await this.checkDependencies();
        await this.checkBuildConfig();
        await this.checkAssets();
        await this.checkAmplifyConfig();

        const result = this.calculateResults();
        this._panel.webview.html = this._getResultsHtml(result);
    }

    private async checkCaching() {
        // Check 1: Amplify cache configuration
        const amplifyYmlPath = path.join(this._workspaceRoot, 'amplify.yml');
        const amplifyYmlExists = fs.existsSync(amplifyYmlPath);
        
        if (amplifyYmlExists) {
            const content = fs.readFileSync(amplifyYmlPath, 'utf-8');
            
            // Check for cache configuration
            if (!content.includes('cache:')) {
                this._checks.push({
                    id: 'cache-amplify-yml',
                    name: 'Enable Amplify Build Cache',
                    category: 'cache',
                    status: 'fail',
                    message: 'No cache configuration found in amplify.yml. Adding cache paths can speed up builds by 30-50%.',
                    impact: 'high',
                    autoFixAvailable: true,
                    autoFix: async () => {
                        await this.addCacheToAmplifyYml();
                    },
                    docsUrl: 'https://docs.aws.amazon.com/amplify/latest/userguide/build-settings.html#build-cache'
                });
            } else {
                this._checks.push({
                    id: 'cache-amplify-yml',
                    name: 'Amplify Build Cache',
                    category: 'cache',
                    status: 'pass',
                    message: 'Cache configuration is present in amplify.yml.',
                    impact: 'high',
                    autoFixAvailable: false
                });
            }

            // Check for node_modules caching
            if (content.includes('cache:') && !content.includes('node_modules')) {
                this._checks.push({
                    id: 'cache-node-modules',
                    name: 'Cache node_modules',
                    category: 'cache',
                    status: 'warn',
                    message: 'Consider adding node_modules to cache paths for faster dependency installation.',
                    impact: 'high',
                    autoFixAvailable: true,
                    autoFix: async () => {
                        await this.addNodeModulesToCache();
                    }
                });
            }
        }

        // Check 2: Next.js cache
        const nextConfigPath = path.join(this._workspaceRoot, 'next.config.js');
        const nextConfigMjsPath = path.join(this._workspaceRoot, 'next.config.mjs');
        const isNextJs = fs.existsSync(nextConfigPath) || fs.existsSync(nextConfigMjsPath);

        if (isNextJs && amplifyYmlExists) {
            const content = fs.readFileSync(amplifyYmlPath, 'utf-8');
            if (!content.includes('.next/cache')) {
                this._checks.push({
                    id: 'cache-nextjs',
                    name: 'Cache Next.js Build Cache',
                    category: 'cache',
                    status: 'warn',
                    message: 'Add .next/cache to amplify.yml cache paths. Next.js incremental builds can be 60% faster.',
                    impact: 'high',
                    autoFixAvailable: true,
                    autoFix: async () => {
                        await this.addNextCacheToAmplifyYml();
                    },
                    docsUrl: 'https://nextjs.org/docs/pages/building-your-application/deploying/ci-build-caching'
                });
            }
        }
    }

    private async checkDependencies() {
        const packageJsonPath = path.join(this._workspaceRoot, 'package.json');
        if (!fs.existsSync(packageJsonPath)) return;

        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        const allDeps = { ...packageJson.dependencies, ...packageJson.devDependencies };

        // Check 1: Lock file presence
        const hasPackageLock = fs.existsSync(path.join(this._workspaceRoot, 'package-lock.json'));
        const hasPnpmLock = fs.existsSync(path.join(this._workspaceRoot, 'pnpm-lock.yaml'));
        const hasYarnLock = fs.existsSync(path.join(this._workspaceRoot, 'yarn.lock'));

        if (!hasPackageLock && !hasPnpmLock && !hasYarnLock) {
            this._checks.push({
                id: 'dep-lockfile',
                name: 'Lock File Missing',
                category: 'dependencies',
                status: 'fail',
                message: 'No lock file found. This causes slow builds as dependencies must be resolved each time.',
                impact: 'high',
                autoFixAvailable: true,
                autoFix: async () => {
                    const terminal = vscode.window.createTerminal('Amplify Monitor');
                    terminal.show();
                    terminal.sendText('npm install --package-lock-only');
                }
            });
        } else {
            this._checks.push({
                id: 'dep-lockfile',
                name: 'Lock File Present',
                category: 'dependencies',
                status: 'pass',
                message: 'Lock file found - dependencies will install faster.',
                impact: 'high',
                autoFixAvailable: false
            });
        }

        // Check 2: Use npm ci instead of npm install
        const amplifyYmlPath = path.join(this._workspaceRoot, 'amplify.yml');
        if (fs.existsSync(amplifyYmlPath) && hasPackageLock) {
            const content = fs.readFileSync(amplifyYmlPath, 'utf-8');
            if (content.includes('npm install') && !content.includes('npm ci')) {
                this._checks.push({
                    id: 'dep-npm-ci',
                    name: 'Use npm ci Instead of npm install',
                    category: 'dependencies',
                    status: 'warn',
                    message: 'npm ci is faster than npm install for CI environments (uses lock file directly).',
                    impact: 'medium',
                    autoFixAvailable: true,
                    autoFix: async () => {
                        await this.replaceNpmInstallWithCi();
                    },
                    docsUrl: 'https://docs.npmjs.com/cli/v9/commands/npm-ci'
                });
            }
        }

        // Check 3: Heavy devDependencies
        const heavyDevDeps = ['@storybook/react', 'cypress', 'playwright', 'jest', '@testing-library/react'];
        const foundHeavyDeps = Object.keys(packageJson.devDependencies || {}).filter(
            dep => heavyDevDeps.some(h => dep.includes(h))
        );

        if (foundHeavyDeps.length > 0) {
            this._checks.push({
                id: 'dep-heavy-dev',
                name: 'Heavy Dev Dependencies',
                category: 'dependencies',
                status: 'info',
                message: `Found ${foundHeavyDeps.length} heavy dev dependencies (${foundHeavyDeps.slice(0, 3).join(', ')}). Consider using --production flag if not needed for build.`,
                impact: 'medium',
                autoFixAvailable: false,
                docsUrl: 'https://docs.aws.amazon.com/amplify/latest/userguide/build-settings.html'
            });
        }

        // Check 4: Duplicate packages (check package-lock for duplicates)
        if (hasPackageLock) {
            try {
                const lockContent = fs.readFileSync(path.join(this._workspaceRoot, 'package-lock.json'), 'utf-8');
                const lockJson = JSON.parse(lockContent);
                
                // Simple heuristic: check lock file size
                const lockSizeMB = Buffer.byteLength(lockContent, 'utf-8') / (1024 * 1024);
                if (lockSizeMB > 5) {
                    this._checks.push({
                        id: 'dep-lock-size',
                        name: 'Large Lock File',
                        category: 'dependencies',
                        status: 'warn',
                        message: `package-lock.json is ${lockSizeMB.toFixed(1)}MB. Consider running npm dedupe to reduce duplicate packages.`,
                        impact: 'medium',
                        autoFixAvailable: true,
                        autoFix: async () => {
                            const terminal = vscode.window.createTerminal('Amplify Monitor');
                            terminal.show();
                            terminal.sendText('npm dedupe');
                        }
                    });
                }
            } catch (e) {
                // Ignore parse errors
            }
        }
    }

    private async checkBuildConfig() {
        const packageJsonPath = path.join(this._workspaceRoot, 'package.json');
        if (!fs.existsSync(packageJsonPath)) return;

        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

        // Check 1: Source maps in production
        const nextConfigPath = path.join(this._workspaceRoot, 'next.config.js');
        const nextConfigMjsPath = path.join(this._workspaceRoot, 'next.config.mjs');
        
        if (fs.existsSync(nextConfigPath) || fs.existsSync(nextConfigMjsPath)) {
            const configPath = fs.existsSync(nextConfigMjsPath) ? nextConfigMjsPath : nextConfigPath;
            const content = fs.readFileSync(configPath, 'utf-8');
            
            if (content.includes('productionBrowserSourceMaps: true') || content.includes('productionBrowserSourceMaps:true')) {
                this._checks.push({
                    id: 'build-sourcemaps',
                    name: 'Production Source Maps Enabled',
                    category: 'build',
                    status: 'warn',
                    message: 'Production source maps increase build time and bundle size. Disable unless needed for debugging.',
                    impact: 'medium',
                    autoFixAvailable: false,
                    docsUrl: 'https://nextjs.org/docs/app/api-reference/next-config-js/productionBrowserSourceMaps'
                });
            }
        }

        // Check 2: TypeScript strict mode (slower but recommended)
        const tsconfigPath = path.join(this._workspaceRoot, 'tsconfig.json');
        if (fs.existsSync(tsconfigPath)) {
            try {
                const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf-8').replace(/\/\/.*/g, ''));
                if (tsconfig.compilerOptions?.skipLibCheck === false || !tsconfig.compilerOptions?.skipLibCheck) {
                    this._checks.push({
                        id: 'build-skip-lib-check',
                        name: 'Enable skipLibCheck',
                        category: 'build',
                        status: 'warn',
                        message: 'Setting skipLibCheck: true in tsconfig.json can speed up TypeScript compilation by 20-30%.',
                        impact: 'medium',
                        autoFixAvailable: true,
                        autoFix: async () => {
                            await this.enableSkipLibCheck();
                        }
                    });
                } else {
                    this._checks.push({
                        id: 'build-skip-lib-check',
                        name: 'TypeScript skipLibCheck',
                        category: 'build',
                        status: 'pass',
                        message: 'skipLibCheck is enabled for faster TypeScript builds.',
                        impact: 'medium',
                        autoFixAvailable: false
                    });
                }
            } catch (e) {
                // Ignore parse errors
            }
        }

        // Check 3: Parallel builds
        const amplifyYmlPath = path.join(this._workspaceRoot, 'amplify.yml');
        if (fs.existsSync(amplifyYmlPath)) {
            const content = fs.readFileSync(amplifyYmlPath, 'utf-8');
            
            // Check for parallel commands
            if (!content.includes('&&') && !content.includes('concurrently') && !content.includes('npm-run-all')) {
                this._checks.push({
                    id: 'build-parallel',
                    name: 'Consider Parallel Commands',
                    category: 'build',
                    status: 'info',
                    message: 'Use && or tools like concurrently to run independent build steps in parallel.',
                    impact: 'medium',
                    autoFixAvailable: false
                });
            }
        }

        // Check 4: Node.js version
        if (fs.existsSync(amplifyYmlPath)) {
            const content = fs.readFileSync(amplifyYmlPath, 'utf-8');
            const nodeVersionMatch = content.match(/nvm use (\d+)/);
            
            if (nodeVersionMatch) {
                const nodeVersion = parseInt(nodeVersionMatch[1]);
                if (nodeVersion < 18) {
                    this._checks.push({
                        id: 'build-node-version',
                        name: 'Upgrade Node.js Version',
                        category: 'build',
                        status: 'warn',
                        message: `Using Node.js ${nodeVersion}. Node 18+ has faster startup and better performance.`,
                        impact: 'medium',
                        autoFixAvailable: true,
                        autoFix: async () => {
                            await this.upgradeNodeVersion();
                        }
                    });
                } else if (nodeVersion < 20) {
                    this._checks.push({
                        id: 'build-node-version',
                        name: 'Node.js Version',
                        category: 'build',
                        status: 'info',
                        message: `Using Node.js ${nodeVersion}. Consider Node 20 LTS for best performance.`,
                        impact: 'low',
                        autoFixAvailable: true,
                        autoFix: async () => {
                            await this.upgradeNodeVersion();
                        }
                    });
                } else {
                    this._checks.push({
                        id: 'build-node-version',
                        name: 'Node.js Version',
                        category: 'build',
                        status: 'pass',
                        message: `Using Node.js ${nodeVersion} - great choice!`,
                        impact: 'medium',
                        autoFixAvailable: false
                    });
                }
            }
        }
    }

    private async checkAssets() {
        // Check 1: Large images in public folder
        const publicDir = path.join(this._workspaceRoot, 'public');
        if (fs.existsSync(publicDir)) {
            const largeImages: string[] = [];
            this.findLargeImages(publicDir, largeImages);

            if (largeImages.length > 0) {
                this._checks.push({
                    id: 'assets-large-images',
                    name: 'Large Unoptimized Images',
                    category: 'assets',
                    status: 'warn',
                    message: `Found ${largeImages.length} images over 500KB. Consider using next/image or optimizing with tools like squoosh.`,
                    impact: 'medium',
                    autoFixAvailable: false,
                    docsUrl: 'https://nextjs.org/docs/app/building-your-application/optimizing/images'
                });
            } else {
                this._checks.push({
                    id: 'assets-large-images',
                    name: 'Image Sizes',
                    category: 'assets',
                    status: 'pass',
                    message: 'No large unoptimized images detected in public folder.',
                    impact: 'medium',
                    autoFixAvailable: false
                });
            }
        }

        // Check 2: Fonts optimization
        const packageJsonPath = path.join(this._workspaceRoot, 'package.json');
        if (fs.existsSync(packageJsonPath)) {
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
            const allDeps = { ...packageJson.dependencies, ...packageJson.devDependencies };

            const hasNextFont = allDeps['@next/font'] || allDeps['next'];
            const hasGoogleFontsInPublic = this.hasGoogleFontsImport();

            if (hasGoogleFontsInPublic && hasNextFont) {
                this._checks.push({
                    id: 'assets-fonts',
                    name: 'Optimize Google Fonts',
                    category: 'assets',
                    status: 'info',
                    message: 'Consider using next/font for automatic font optimization and faster loading.',
                    impact: 'low',
                    autoFixAvailable: false,
                    docsUrl: 'https://nextjs.org/docs/app/building-your-application/optimizing/fonts'
                });
            }
        }
    }

    private async checkAmplifyConfig() {
        const amplifyYmlPath = path.join(this._workspaceRoot, 'amplify.yml');
        
        // Check 1: amplify.yml exists
        if (!fs.existsSync(amplifyYmlPath)) {
            this._checks.push({
                id: 'config-amplify-yml',
                name: 'Create amplify.yml',
                category: 'config',
                status: 'fail',
                message: 'No amplify.yml found. Create one to customize build settings and enable caching.',
                impact: 'high',
                autoFixAvailable: true,
                autoFix: async () => {
                    await this.createAmplifyYml();
                },
                docsUrl: 'https://docs.aws.amazon.com/amplify/latest/userguide/build-settings.html'
            });
            return;
        }

        const content = fs.readFileSync(amplifyYmlPath, 'utf-8');

        // Check 2: Artifacts configuration
        if (!content.includes('artifacts:')) {
            this._checks.push({
                id: 'config-artifacts',
                name: 'Configure Artifacts',
                category: 'config',
                status: 'warn',
                message: 'No artifacts configuration. Specify baseDirectory and files to deploy only what\'s needed.',
                impact: 'medium',
                autoFixAvailable: false,
                docsUrl: 'https://docs.aws.amazon.com/amplify/latest/userguide/build-settings.html#artifacts'
            });
        }

        // Check 3: Environment variables in build
        if (content.includes('$') && !content.includes('env:')) {
            this._checks.push({
                id: 'config-env-vars',
                name: 'Environment Variables Section',
                category: 'config',
                status: 'info',
                message: 'Consider using the env section in amplify.yml to set build-time environment variables.',
                impact: 'low',
                autoFixAvailable: false
            });
        }

        // Check 4: preBuild phase
        if (!content.includes('preBuild:')) {
            this._checks.push({
                id: 'config-prebuild',
                name: 'Add preBuild Phase',
                category: 'config',
                status: 'info',
                message: 'Consider adding preBuild phase for setup tasks like nvm use, to keep build phase clean.',
                impact: 'low',
                autoFixAvailable: false
            });
        }

        // Check passed if we get here
        this._checks.push({
            id: 'config-amplify-yml',
            name: 'amplify.yml Configuration',
            category: 'config',
            status: 'pass',
            message: 'amplify.yml is configured.',
            impact: 'high',
            autoFixAvailable: false
        });
    }

    private findLargeImages(dir: string, results: string[], maxDepth = 3, depth = 0) {
        if (depth > maxDepth) return;

        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory() && !entry.name.startsWith('.')) {
                    this.findLargeImages(fullPath, results, maxDepth, depth + 1);
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name).toLowerCase();
                    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) {
                        const stats = fs.statSync(fullPath);
                        if (stats.size > 500 * 1024) { // 500KB
                            results.push(fullPath);
                        }
                    }
                }
            }
        } catch (e) {
            // Ignore permission errors
        }
    }

    private hasGoogleFontsImport(): boolean {
        const srcDir = path.join(this._workspaceRoot, 'src');
        const appDir = path.join(this._workspaceRoot, 'app');
        const pagesDir = path.join(this._workspaceRoot, 'pages');

        for (const dir of [srcDir, appDir, pagesDir]) {
            if (fs.existsSync(dir)) {
                try {
                    const files = fs.readdirSync(dir);
                    for (const file of files) {
                        if (file.endsWith('.css') || file.endsWith('.scss')) {
                            const content = fs.readFileSync(path.join(dir, file), 'utf-8');
                            if (content.includes('fonts.googleapis.com') || content.includes('fonts.gstatic.com')) {
                                return true;
                            }
                        }
                    }
                } catch (e) {
                    // Ignore errors
                }
            }
        }
        return false;
    }

    // Auto-fix implementations
    private async addCacheToAmplifyYml() {
        const amplifyYmlPath = path.join(this._workspaceRoot, 'amplify.yml');
        let content = fs.readFileSync(amplifyYmlPath, 'utf-8');
        
        const cacheSection = `
cache:
  paths:
    - node_modules/**/*
`;
        content = content.trimEnd() + '\n' + cacheSection;
        fs.writeFileSync(amplifyYmlPath, content);
        
        vscode.window.showInformationMessage('Added cache configuration to amplify.yml');
        await this.analyze();
    }

    private async addNodeModulesToCache() {
        const amplifyYmlPath = path.join(this._workspaceRoot, 'amplify.yml');
        let content = fs.readFileSync(amplifyYmlPath, 'utf-8');
        
        // Find cache section and add node_modules
        content = content.replace(
            /cache:\s*\n(\s*)paths:/,
            'cache:\n$1paths:\n$1  - node_modules/**/*'
        );
        
        fs.writeFileSync(amplifyYmlPath, content);
        vscode.window.showInformationMessage('Added node_modules to cache paths');
        await this.analyze();
    }

    private async addNextCacheToAmplifyYml() {
        const amplifyYmlPath = path.join(this._workspaceRoot, 'amplify.yml');
        let content = fs.readFileSync(amplifyYmlPath, 'utf-8');
        
        if (content.includes('cache:') && content.includes('paths:')) {
            // Add to existing cache paths
            content = content.replace(
                /(cache:\s*\n\s*paths:)/,
                '$1\n    - .next/cache/**/*'
            );
        } else {
            // Add new cache section
            content = content.trimEnd() + `
cache:
  paths:
    - node_modules/**/*
    - .next/cache/**/*
`;
        }
        
        fs.writeFileSync(amplifyYmlPath, content);
        vscode.window.showInformationMessage('Added .next/cache to amplify.yml');
        await this.analyze();
    }

    private async replaceNpmInstallWithCi() {
        const amplifyYmlPath = path.join(this._workspaceRoot, 'amplify.yml');
        let content = fs.readFileSync(amplifyYmlPath, 'utf-8');
        
        content = content.replace(/npm install(?!\s+[-\w])/g, 'npm ci');
        
        fs.writeFileSync(amplifyYmlPath, content);
        vscode.window.showInformationMessage('Replaced npm install with npm ci');
        await this.analyze();
    }

    private async enableSkipLibCheck() {
        const tsconfigPath = path.join(this._workspaceRoot, 'tsconfig.json');
        let content = fs.readFileSync(tsconfigPath, 'utf-8');
        
        if (content.includes('"compilerOptions"')) {
            if (content.includes('"skipLibCheck"')) {
                content = content.replace(/"skipLibCheck"\s*:\s*false/, '"skipLibCheck": true');
            } else {
                content = content.replace(
                    /"compilerOptions"\s*:\s*{/,
                    '"compilerOptions": {\n    "skipLibCheck": true,'
                );
            }
            
            fs.writeFileSync(tsconfigPath, content);
            vscode.window.showInformationMessage('Enabled skipLibCheck in tsconfig.json');
            await this.analyze();
        }
    }

    private async upgradeNodeVersion() {
        const amplifyYmlPath = path.join(this._workspaceRoot, 'amplify.yml');
        let content = fs.readFileSync(amplifyYmlPath, 'utf-8');
        
        content = content.replace(/nvm use \d+/, 'nvm use 20');
        
        fs.writeFileSync(amplifyYmlPath, content);
        vscode.window.showInformationMessage('Updated Node.js version to 20 in amplify.yml');
        await this.analyze();
    }

    private async createAmplifyYml() {
        const amplifyYmlPath = path.join(this._workspaceRoot, 'amplify.yml');
        
        // Detect project type
        const packageJsonPath = path.join(this._workspaceRoot, 'package.json');
        let buildCommand = 'npm run build';
        let baseDirectory = 'build';
        
        if (fs.existsSync(packageJsonPath)) {
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
            
            if (packageJson.dependencies?.next) {
                baseDirectory = '.next';
            } else if (packageJson.dependencies?.vite || packageJson.devDependencies?.vite) {
                baseDirectory = 'dist';
            }
        }
        
        const template = `version: 1
frontend:
  phases:
    preBuild:
      commands:
        - nvm use 20
        - npm ci
    build:
      commands:
        - ${buildCommand}
  artifacts:
    baseDirectory: ${baseDirectory}
    files:
      - '**/*'
  cache:
    paths:
      - node_modules/**/*
`;
        
        fs.writeFileSync(amplifyYmlPath, template);
        vscode.window.showInformationMessage('Created amplify.yml with optimized settings');
        
        // Open the file
        const doc = await vscode.workspace.openTextDocument(amplifyYmlPath);
        await vscode.window.showTextDocument(doc);
        
        await this.analyze();
    }

    private async applyFix(checkId: string) {
        const check = this._checks.find(c => c.id === checkId);
        if (check?.autoFix) {
            try {
                await check.autoFix();
                vscode.window.showInformationMessage(`Applied fix: ${check.name}`);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to apply fix: ${error}`);
            }
        }
    }

    private async applyAllFixes() {
        const fixableChecks = this._checks.filter(c => c.autoFixAvailable && c.status !== 'pass');
        
        for (const check of fixableChecks) {
            if (check.autoFix) {
                try {
                    await check.autoFix();
                } catch (error) {
                    console.error(`Failed to apply ${check.name}:`, error);
                }
            }
        }
        
        vscode.window.showInformationMessage(`Applied ${fixableChecks.length} optimizations`);
    }

    private calculateResults(): OptimizationResult {
        const passed = this._checks.filter(c => c.status === 'pass').length;
        const warnings = this._checks.filter(c => c.status === 'warn' || c.status === 'info').length;
        const failed = this._checks.filter(c => c.status === 'fail').length;
        
        const total = this._checks.length || 1;
        const score = Math.round((passed / total) * 100);
        
        // Estimate savings based on checks
        let savingsMinutes = 0;
        for (const check of this._checks) {
            if (check.status === 'fail' || check.status === 'warn') {
                if (check.impact === 'high') savingsMinutes += 2;
                else if (check.impact === 'medium') savingsMinutes += 1;
                else savingsMinutes += 0.5;
            }
        }
        
        return {
            checks: this._checks,
            score,
            estimatedSavings: savingsMinutes > 0 ? `~${savingsMinutes} min per build` : 'Already optimized',
            summary: { passed, warnings, failed }
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
        <p>Analyzing your project for optimization opportunities...</p>
    </div>
</body>
</html>`;
    }

    private _getResultsHtml(result: OptimizationResult): string {
        const getCategoryIcon = (cat: string) => {
            switch (cat) {
                case 'cache': return '💾';
                case 'dependencies': return '📦';
                case 'build': return '🔨';
                case 'assets': return '🖼️';
                case 'config': return '⚙️';
                default: return '📋';
            }
        };

        const getStatusBadge = (status: string) => {
            switch (status) {
                case 'pass': return '<span class="badge pass">✓ PASS</span>';
                case 'warn': return '<span class="badge warn">⚠ WARN</span>';
                case 'fail': return '<span class="badge fail">✗ FAIL</span>';
                case 'info': return '<span class="badge info">ℹ INFO</span>';
                default: return '';
            }
        };

        const getImpactBadge = (impact: string) => {
            switch (impact) {
                case 'high': return '<span class="impact high">High Impact</span>';
                case 'medium': return '<span class="impact medium">Medium</span>';
                case 'low': return '<span class="impact low">Low</span>';
                default: return '';
            }
        };

        const groupedChecks: Record<string, OptimizationCheck[]> = {};
        for (const check of result.checks) {
            if (!groupedChecks[check.category]) {
                groupedChecks[check.category] = [];
            }
            groupedChecks[check.category].push(check);
        }

        const fixableCount = result.checks.filter(c => c.autoFixAvailable && c.status !== 'pass').length;

        return `<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); max-width: 900px; margin: 0 auto; }
        h1 { display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--vscode-input-border); padding-bottom: 15px; }
        .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin: 20px 0; }
        .summary-card { background: var(--vscode-input-background); padding: 15px; border-radius: 8px; text-align: center; }
        .summary-card.score { background: ${result.score >= 80 ? 'rgba(0,200,83,0.1)' : result.score >= 50 ? 'rgba(255,193,7,0.1)' : 'rgba(244,67,54,0.1)'}; }
        .summary-value { font-size: 28px; font-weight: bold; }
        .summary-value.score { color: ${result.score >= 80 ? '#00c853' : result.score >= 50 ? '#ffc107' : '#f44336'}; }
        .summary-label { font-size: 12px; opacity: 0.7; margin-top: 5px; }
        
        .actions { display: flex; gap: 10px; margin: 20px 0; }
        button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-size: 14px; display: flex; align-items: center; gap: 8px; }
        button:hover { background: var(--vscode-button-hoverBackground); }
        button.secondary { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); }
        button:disabled { opacity: 0.5; cursor: not-allowed; }
        
        .category { margin: 25px 0; }
        .category-header { display: flex; align-items: center; gap: 10px; font-size: 18px; font-weight: 600; margin-bottom: 15px; }
        
        .check { background: var(--vscode-input-background); border-radius: 8px; padding: 15px; margin: 10px 0; border-left: 4px solid var(--vscode-input-border); }
        .check.pass { border-left-color: #00c853; }
        .check.warn { border-left-color: #ffc107; }
        .check.fail { border-left-color: #f44336; }
        .check.info { border-left-color: #2196f3; }
        
        .check-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
        .check-name { font-weight: 600; }
        .check-badges { display: flex; gap: 8px; align-items: center; }
        
        .badge { padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
        .badge.pass { background: rgba(0,200,83,0.2); color: #00c853; }
        .badge.warn { background: rgba(255,193,7,0.2); color: #ffc107; }
        .badge.fail { background: rgba(244,67,54,0.2); color: #f44336; }
        .badge.info { background: rgba(33,150,243,0.2); color: #2196f3; }
        
        .impact { padding: 2px 6px; border-radius: 3px; font-size: 10px; text-transform: uppercase; }
        .impact.high { background: rgba(244,67,54,0.15); color: #f44336; }
        .impact.medium { background: rgba(255,193,7,0.15); color: #ffc107; }
        .impact.low { background: rgba(33,150,243,0.15); color: #2196f3; }
        
        .check-message { font-size: 13px; opacity: 0.9; line-height: 1.5; }
        .check-actions { margin-top: 12px; display: flex; gap: 10px; }
        .check-actions button { padding: 6px 12px; font-size: 12px; }
        
        .savings { background: linear-gradient(135deg, rgba(0,200,83,0.1), rgba(33,150,243,0.1)); padding: 20px; border-radius: 8px; margin: 20px 0; text-align: center; }
        .savings-value { font-size: 24px; font-weight: bold; color: #00c853; }
        .savings-label { font-size: 12px; opacity: 0.7; margin-top: 5px; }
    </style>
</head>
<body>
    <h1>🧙 Build Optimization Wizard</h1>
    
    <div class="summary">
        <div class="summary-card score">
            <div class="summary-value score">${result.score}%</div>
            <div class="summary-label">Optimization Score</div>
        </div>
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
    </div>
    
    <div class="savings">
        <div class="savings-value">${result.estimatedSavings}</div>
        <div class="savings-label">Potential time savings by fixing issues</div>
    </div>
    
    <div class="actions">
        <button onclick="applyAll()" ${fixableCount === 0 ? 'disabled' : ''}>
            ✨ Apply All Fixes (${fixableCount})
        </button>
        <button class="secondary" onclick="refresh()">
            🔄 Re-analyze
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
                        <div class="check-badges">
                            ${getImpactBadge(check.impact)}
                            ${getStatusBadge(check.status)}
                        </div>
                    </div>
                    <div class="check-message">${check.message}</div>
                    ${(check.autoFixAvailable && check.status !== 'pass') || check.docsUrl ? `
                        <div class="check-actions">
                            ${check.autoFixAvailable && check.status !== 'pass' ? `
                                <button onclick="applyFix('${check.id}')">🔧 Apply Fix</button>
                            ` : ''}
                            ${check.docsUrl ? `
                                <button class="secondary" onclick="openDocs('${check.docsUrl}')">📖 Learn More</button>
                            ` : ''}
                        </div>
                    ` : ''}
                </div>
            `).join('')}
        </div>
    `).join('')}
    
    <script>
        const vscode = acquireVsCodeApi();
        
        function applyFix(checkId) {
            vscode.postMessage({ command: 'applyFix', checkId });
        }
        
        function applyAll() {
            vscode.postMessage({ command: 'applyAll' });
        }
        
        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }
        
        function openDocs(url) {
            vscode.postMessage({ command: 'openDocs', url });
        }
    </script>
</body>
</html>`;
    }

    public dispose() {
        BuildOptimizationWizard.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) x.dispose();
        }
    }
}
