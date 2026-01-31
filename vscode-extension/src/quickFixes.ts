import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface QuickFix {
    id: string;
    title: string;
    description: string;
    pattern: string;  // Issue pattern this fix addresses
    command: string;  // VS Code command to execute
    args?: unknown[];
    requiresConfirmation?: boolean;
    fileModification?: {
        relativePath: string;
        action: 'create' | 'modify' | 'delete';
        content?: string | ((existing: string) => string);
    };
    terminalCommand?: string;
}

// Map of issue patterns to their quick fixes
export const QUICK_FIXES: Record<string, QuickFix[]> = {
    'LOCK_FILE_MISMATCH': [
        {
            id: 'switch-to-npm',
            title: '🔧 Switch to npm',
            description: 'Update amplify.yml to use npm install',
            pattern: 'LOCK_FILE_MISMATCH',
            command: 'amplify-monitor.applyQuickFix',
            fileModification: {
                relativePath: 'amplify.yml',
                action: 'modify',
                content: (existing) => existing.replace(/pnpm install|yarn install/g, 'npm ci')
            }
        },
        {
            id: 'switch-to-pnpm',
            title: '🔧 Switch to pnpm',
            description: 'Update amplify.yml to use pnpm install and remove package-lock.json',
            pattern: 'LOCK_FILE_MISMATCH',
            command: 'amplify-monitor.applyQuickFix',
            fileModification: {
                relativePath: 'amplify.yml',
                action: 'modify',
                content: (existing) => existing.replace(/npm ci|npm install|yarn install/g, 'pnpm install')
            }
        },
        {
            id: 'delete-package-lock',
            title: '🗑️ Delete package-lock.json',
            description: 'Remove package-lock.json (use with pnpm)',
            pattern: 'LOCK_FILE_MISMATCH',
            command: 'amplify-monitor.applyQuickFix',
            requiresConfirmation: true,
            fileModification: {
                relativePath: 'package-lock.json',
                action: 'delete'
            }
        }
    ],
    'NODE_VERSION_MISMATCH': [
        {
            id: 'add-nvmrc',
            title: '📄 Create .nvmrc file',
            description: 'Add .nvmrc with Node.js 18 for consistent version',
            pattern: 'NODE_VERSION_MISMATCH',
            command: 'amplify-monitor.applyQuickFix',
            fileModification: {
                relativePath: '.nvmrc',
                action: 'create',
                content: '18'
            }
        },
        {
            id: 'add-node-version-amplify',
            title: '⚙️ Set Node 18 in amplify.yml',
            description: 'Add nvm use 18 to preBuild phase',
            pattern: 'NODE_VERSION_MISMATCH',
            command: 'amplify-monitor.applyQuickFix',
            fileModification: {
                relativePath: 'amplify.yml',
                action: 'modify',
                content: (existing) => {
                    if (existing.includes('nvm use')) {
                        return existing.replace(/nvm use \d+/, 'nvm use 18');
                    }
                    // Add nvm use to preBuild
                    return existing.replace(
                        /(preBuild:\s*commands:\s*\n)/,
                        '$1        - nvm use 18\n'
                    );
                }
            }
        }
    ],
    'MISSING_ENV_VAR': [
        {
            id: 'open-env-vars',
            title: '🔐 Open Environment Variables',
            description: 'Open the Amplify Console to add missing env vars',
            pattern: 'MISSING_ENV_VAR',
            command: 'amplify-monitor.openInConsole'
        },
        {
            id: 'create-env-example',
            title: '📝 Create .env.example',
            description: 'Create an example env file to document required variables',
            pattern: 'MISSING_ENV_VAR',
            command: 'amplify-monitor.applyQuickFix',
            fileModification: {
                relativePath: '.env.example',
                action: 'create',
                content: `# Required Environment Variables for Amplify Build
# Copy this to .env.local for local development

# API Keys
# NEXT_PUBLIC_API_KEY=
# NEXT_PUBLIC_API_URL=

# AWS Configuration (automatically set by Amplify)
# AWS_REGION=
# AWS_BRANCH=
`
            }
        }
    ],
    'NPM_INSTALL_FAILED': [
        {
            id: 'clear-cache-amplify',
            title: '🧹 Add cache clear to build',
            description: 'Add npm cache clean to preBuild phase',
            pattern: 'NPM_INSTALL_FAILED',
            command: 'amplify-monitor.applyQuickFix',
            fileModification: {
                relativePath: 'amplify.yml',
                action: 'modify',
                content: (existing) => {
                    if (existing.includes('npm cache clean')) {
                        return existing;
                    }
                    return existing.replace(
                        /(preBuild:\s*commands:\s*\n)/,
                        '$1        - npm cache clean --force\n'
                    );
                }
            }
        },
        {
            id: 'use-legacy-deps',
            title: '⚠️ Use legacy peer deps',
            description: 'Add --legacy-peer-deps to npm install',
            pattern: 'NPM_INSTALL_FAILED',
            command: 'amplify-monitor.applyQuickFix',
            fileModification: {
                relativePath: 'amplify.yml',
                action: 'modify',
                content: (existing) => existing.replace(
                    /npm ci(?!\s*--legacy)/g,
                    'npm ci --legacy-peer-deps'
                )
            }
        }
    ],
    'BUILD_COMMAND_FAILED': [
        {
            id: 'check-build-script',
            title: '📋 Open package.json',
            description: 'Check build script configuration',
            pattern: 'BUILD_COMMAND_FAILED',
            command: 'vscode.open',
            args: ['package.json']
        },
        {
            id: 'add-ci-flag',
            title: '🔧 Add CI=false to build',
            description: 'Suppress warnings as errors with CI=false',
            pattern: 'BUILD_COMMAND_FAILED',
            command: 'amplify-monitor.applyQuickFix',
            fileModification: {
                relativePath: 'amplify.yml',
                action: 'modify',
                content: (existing) => {
                    if (existing.includes('CI=false') || existing.includes('CI=true')) {
                        return existing;
                    }
                    return existing.replace(
                        /(build:\s*commands:\s*\n\s*-\s*)/,
                        '$1CI=false '
                    );
                }
            }
        }
    ],
    'OUT_OF_MEMORY': [
        {
            id: 'increase-memory',
            title: '💾 Increase Node memory',
            description: 'Set NODE_OPTIONS with increased heap size',
            pattern: 'OUT_OF_MEMORY',
            command: 'amplify-monitor.applyQuickFix',
            fileModification: {
                relativePath: 'amplify.yml',
                action: 'modify',
                content: (existing) => {
                    if (existing.includes('NODE_OPTIONS')) {
                        return existing.replace(
                            /--max-old-space-size=\d+/,
                            '--max-old-space-size=8192'
                        );
                    }
                    return existing.replace(
                        /(preBuild:\s*commands:\s*\n)/,
                        '$1        - export NODE_OPTIONS="--max-old-space-size=8192"\n'
                    );
                }
            }
        }
    ],
    'AMPLIFY_YML_ERROR': [
        {
            id: 'create-amplify-yml',
            title: '📄 Create amplify.yml template',
            description: 'Create a basic amplify.yml buildspec file',
            pattern: 'AMPLIFY_YML_ERROR',
            command: 'amplify-monitor.applyQuickFix',
            fileModification: {
                relativePath: 'amplify.yml',
                action: 'create',
                content: `version: 1
frontend:
  phases:
    preBuild:
      commands:
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
`
            }
        },
        {
            id: 'validate-amplify-yml',
            title: '✅ Validate amplify.yml',
            description: 'Open and validate amplify.yml syntax',
            pattern: 'AMPLIFY_YML_ERROR',
            command: 'vscode.open',
            args: ['amplify.yml']
        }
    ],
    'PNPM_INSTALL_FAILED': [
        {
            id: 'add-pnpm-version',
            title: '📌 Pin pnpm version',
            description: 'Add corepack enable and pin pnpm version',
            pattern: 'PNPM_INSTALL_FAILED',
            command: 'amplify-monitor.applyQuickFix',
            fileModification: {
                relativePath: 'amplify.yml',
                action: 'modify',
                content: (existing) => {
                    if (existing.includes('corepack enable')) {
                        return existing;
                    }
                    return existing.replace(
                        /(preBuild:\s*commands:\s*\n)/,
                        '$1        - corepack enable\n        - corepack prepare pnpm@latest --activate\n'
                    );
                }
            }
        }
    ],
    'TYPESCRIPT_ERROR': [
        {
            id: 'open-tsconfig',
            title: '📋 Open tsconfig.json',
            description: 'Review TypeScript configuration',
            pattern: 'TYPESCRIPT_ERROR',
            command: 'vscode.open',
            args: ['tsconfig.json']
        },
        {
            id: 'add-skip-lib-check',
            title: '⚡ Skip library type checking',
            description: 'Add skipLibCheck to tsconfig for faster builds',
            pattern: 'TYPESCRIPT_ERROR',
            command: 'amplify-monitor.applyQuickFix',
            fileModification: {
                relativePath: 'tsconfig.json',
                action: 'modify',
                content: (existing) => {
                    if (existing.includes('"skipLibCheck"')) {
                        return existing.replace(/"skipLibCheck"\s*:\s*false/, '"skipLibCheck": true');
                    }
                    return existing.replace(
                        /"compilerOptions"\s*:\s*\{/,
                        '"compilerOptions": {\n    "skipLibCheck": true,'
                    );
                }
            }
        },
        {
            id: 'run-tsc-check',
            title: '🔍 Run TypeScript check',
            description: 'Run npx tsc --noEmit to see all errors',
            pattern: 'TYPESCRIPT_ERROR',
            command: 'amplify-monitor.applyQuickFix',
            terminalCommand: 'npx tsc --noEmit'
        }
    ],
    'ESLINT_ERROR': [
        {
            id: 'add-ci-false',
            title: '🔧 Disable CI lint warnings',
            description: 'Set CI=false to treat warnings as warnings, not errors',
            pattern: 'ESLINT_ERROR',
            command: 'amplify-monitor.applyQuickFix',
            fileModification: {
                relativePath: 'amplify.yml',
                action: 'modify',
                content: (existing) => {
                    if (existing.includes('CI=false') || existing.includes('CI=true')) {
                        return existing.replace(/CI=true/g, 'CI=false');
                    }
                    return existing.replace(
                        /(build:\s*commands:\s*\n\s*-\s*)/,
                        '$1CI=false '
                    );
                }
            }
        },
        {
            id: 'run-lint-fix',
            title: '🔧 Run ESLint auto-fix',
            description: 'Automatically fix linting errors where possible',
            pattern: 'ESLINT_ERROR',
            command: 'amplify-monitor.applyQuickFix',
            terminalCommand: 'npx eslint . --fix'
        },
        {
            id: 'open-eslint-config',
            title: '📋 Open ESLint config',
            description: 'Review ESLint rules and configuration',
            pattern: 'ESLINT_ERROR',
            command: 'vscode.open',
            args: ['.eslintrc.js']
        }
    ],
    'MODULE_NOT_FOUND': [
        {
            id: 'install-deps',
            title: '📦 Install dependencies',
            description: 'Run npm install to install all dependencies',
            pattern: 'MODULE_NOT_FOUND',
            command: 'amplify-monitor.applyQuickFix',
            terminalCommand: 'npm install'
        },
        {
            id: 'clear-node-modules',
            title: '🧹 Clean install',
            description: 'Delete node_modules and reinstall',
            pattern: 'MODULE_NOT_FOUND',
            command: 'amplify-monitor.applyQuickFix',
            requiresConfirmation: true,
            terminalCommand: 'rm -rf node_modules && npm install'
        },
        {
            id: 'open-package-json',
            title: '📋 Open package.json',
            description: 'Check if missing module is listed in dependencies',
            pattern: 'MODULE_NOT_FOUND',
            command: 'vscode.open',
            args: ['package.json']
        }
    ],
    'NEXTJS_ERROR': [
        {
            id: 'set-next-artifacts',
            title: '📁 Set .next as artifact dir',
            description: 'Configure amplify.yml to use .next as baseDirectory',
            pattern: 'NEXTJS_ERROR',
            command: 'amplify-monitor.applyQuickFix',
            fileModification: {
                relativePath: 'amplify.yml',
                action: 'modify',
                content: (existing) => {
                    return existing.replace(
                        /baseDirectory:\s*\S+/,
                        'baseDirectory: .next'
                    );
                }
            }
        },
        {
            id: 'open-next-config',
            title: '📋 Open next.config.js',
            description: 'Review Next.js configuration',
            pattern: 'NEXTJS_ERROR',
            command: 'vscode.open',
            args: ['next.config.js']
        },
        {
            id: 'add-next-env-vars',
            title: '🔐 Add NEXT_PUBLIC_ env vars',
            description: 'Create .env.local template for Next.js environment variables',
            pattern: 'NEXTJS_ERROR',
            command: 'amplify-monitor.applyQuickFix',
            fileModification: {
                relativePath: '.env.local.example',
                action: 'create',
                content: `# Next.js Environment Variables
# Copy this to .env.local for local development
# Add these to Amplify Console for production

# Public variables (exposed to browser)
NEXT_PUBLIC_API_URL=
NEXT_PUBLIC_APP_NAME=

# Server-side only variables
DATABASE_URL=
API_SECRET_KEY=
`
            }
        }
    ],
    'VITE_ERROR': [
        {
            id: 'set-vite-artifacts',
            title: '📁 Set dist as artifact dir',
            description: 'Configure amplify.yml to use dist as baseDirectory',
            pattern: 'VITE_ERROR',
            command: 'amplify-monitor.applyQuickFix',
            fileModification: {
                relativePath: 'amplify.yml',
                action: 'modify',
                content: (existing) => {
                    return existing.replace(
                        /baseDirectory:\s*\S+/,
                        'baseDirectory: dist'
                    );
                }
            }
        },
        {
            id: 'open-vite-config',
            title: '📋 Open vite.config.ts',
            description: 'Review Vite configuration',
            pattern: 'VITE_ERROR',
            command: 'vscode.open',
            args: ['vite.config.ts']
        },
        {
            id: 'add-vite-env-vars',
            title: '🔐 Add VITE_ env vars',
            description: 'Create .env template for Vite environment variables',
            pattern: 'VITE_ERROR',
            command: 'amplify-monitor.applyQuickFix',
            fileModification: {
                relativePath: '.env.example',
                action: 'create',
                content: `# Vite Environment Variables
# Copy this to .env.local for local development
# Add these to Amplify Console for production (with VITE_ prefix)

VITE_API_URL=
VITE_APP_TITLE=
VITE_PUBLIC_KEY=
`
            }
        }
    ],
    'YARN_INSTALL_FAILURE': [
        {
            id: 'switch-to-npm-from-yarn',
            title: '🔧 Switch to npm',
            description: 'Update amplify.yml to use npm instead of yarn',
            pattern: 'YARN_INSTALL_FAILURE',
            command: 'amplify-monitor.applyQuickFix',
            fileModification: {
                relativePath: 'amplify.yml',
                action: 'modify',
                content: (existing) => existing.replace(/yarn install/g, 'npm ci').replace(/yarn build/g, 'npm run build')
            }
        },
        {
            id: 'install-yarn',
            title: '📦 Install Yarn in preBuild',
            description: 'Add yarn installation to preBuild phase',
            pattern: 'YARN_INSTALL_FAILURE',
            command: 'amplify-monitor.applyQuickFix',
            fileModification: {
                relativePath: 'amplify.yml',
                action: 'modify',
                content: (existing) => {
                    if (existing.includes('npm install -g yarn')) {
                        return existing;
                    }
                    return existing.replace(
                        /(preBuild:\s*commands:\s*\n)/,
                        '$1        - npm install -g yarn\n'
                    );
                }
            }
        },
        {
            id: 'delete-yarn-lock',
            title: '🗑️ Delete yarn.lock',
            description: 'Remove yarn.lock and switch to npm',
            pattern: 'YARN_INSTALL_FAILURE',
            command: 'amplify-monitor.applyQuickFix',
            requiresConfirmation: true,
            fileModification: {
                relativePath: 'yarn.lock',
                action: 'delete'
            }
        }
    ],
    'TIMEOUT': [
        {
            id: 'add-cache',
            title: '⚡ Enable node_modules caching',
            description: 'Add cache configuration to amplify.yml',
            pattern: 'TIMEOUT',
            command: 'amplify-monitor.applyQuickFix',
            fileModification: {
                relativePath: 'amplify.yml',
                action: 'modify',
                content: (existing) => {
                    if (existing.includes('cache:')) {
                        return existing;
                    }
                    return existing + `
  cache:
    paths:
      - node_modules/**/*
`;
                }
            }
        },
        {
            id: 'parallel-builds',
            title: '🚀 Enable parallel builds',
            description: 'Add parallelism flags to build commands',
            pattern: 'TIMEOUT',
            command: 'amplify-monitor.applyQuickFix',
            fileModification: {
                relativePath: 'amplify.yml',
                action: 'modify',
                content: (existing) => {
                    return existing.replace(
                        /npm run build/g,
                        'npm run build -- --parallel'
                    );
                }
            }
        }
    ],
    'ARTIFACT_PATH_ERROR': [
        {
            id: 'check-build-output',
            title: '🔍 Check build output directory',
            description: 'Run build locally to see actual output path',
            pattern: 'ARTIFACT_PATH_ERROR',
            command: 'amplify-monitor.applyQuickFix',
            terminalCommand: 'npm run build && ls -la'
        },
        {
            id: 'set-dist-artifacts',
            title: '📁 Set dist as artifact dir',
            description: 'Change baseDirectory to dist (Vite default)',
            pattern: 'ARTIFACT_PATH_ERROR',
            command: 'amplify-monitor.applyQuickFix',
            fileModification: {
                relativePath: 'amplify.yml',
                action: 'modify',
                content: (existing) => existing.replace(/baseDirectory:\s*\S+/, 'baseDirectory: dist')
            }
        },
        {
            id: 'set-build-artifacts',
            title: '📁 Set build as artifact dir',
            description: 'Change baseDirectory to build (CRA default)',
            pattern: 'ARTIFACT_PATH_ERROR',
            command: 'amplify-monitor.applyQuickFix',
            fileModification: {
                relativePath: 'amplify.yml',
                action: 'modify',
                content: (existing) => existing.replace(/baseDirectory:\s*\S+/, 'baseDirectory: build')
            }
        },
        {
            id: 'set-out-artifacts',
            title: '📁 Set out as artifact dir',
            description: 'Change baseDirectory to out (Next.js export)',
            pattern: 'ARTIFACT_PATH_ERROR',
            command: 'amplify-monitor.applyQuickFix',
            fileModification: {
                relativePath: 'amplify.yml',
                action: 'modify',
                content: (existing) => existing.replace(/baseDirectory:\s*\S+/, 'baseDirectory: out')
            }
        }
    ],
    'NETWORK_ERROR': [
        {
            id: 'retry-build',
            title: '🔄 Retry Build',
            description: 'Transient network error - try rebuilding',
            pattern: 'NETWORK_ERROR',
            command: 'amplify-monitor.startBuild'
        },
        {
            id: 'use-npm-registry-mirror',
            title: '🌐 Use npm registry mirror',
            description: 'Add registry configuration for reliability',
            pattern: 'NETWORK_ERROR',
            command: 'amplify-monitor.applyQuickFix',
            fileModification: {
                relativePath: '.npmrc',
                action: 'create',
                content: `registry=https://registry.npmjs.org/
fetch-retries=5
fetch-retry-mintimeout=20000
fetch-retry-maxtimeout=120000
`
            }
        }
    ],
    'PERMISSION_DENIED': [
        {
            id: 'use-tmp-dir',
            title: '📁 Use /tmp for temp files',
            description: 'Add TMPDIR export to use writable directory',
            pattern: 'PERMISSION_DENIED',
            command: 'amplify-monitor.applyQuickFix',
            fileModification: {
                relativePath: 'amplify.yml',
                action: 'modify',
                content: (existing) => {
                    if (existing.includes('TMPDIR=/tmp')) {
                        return existing;
                    }
                    return existing.replace(
                        /(preBuild:\s*commands:\s*\n)/,
                        '$1        - export TMPDIR=/tmp\n'
                    );
                }
            }
        },
        {
            id: 'fix-npm-permissions',
            title: '🔧 Fix npm permissions',
            description: 'Configure npm to use user directory',
            pattern: 'PERMISSION_DENIED',
            command: 'amplify-monitor.applyQuickFix',
            fileModification: {
                relativePath: '.npmrc',
                action: 'create',
                content: `prefix=~/.npm-global
cache=~/.npm-cache
`
            }
        }
    ],
    'NPM_CI_FAILURE': [
        {
            id: 'regenerate-lock',
            title: '🔄 Regenerate package-lock.json',
            description: 'Delete and recreate package-lock.json',
            pattern: 'NPM_CI_FAILURE',
            command: 'amplify-monitor.applyQuickFix',
            terminalCommand: 'rm package-lock.json && npm install'
        },
        {
            id: 'use-npm-install',
            title: '🔧 Use npm install instead of npm ci',
            description: 'Change to npm install for more flexibility',
            pattern: 'NPM_CI_FAILURE',
            command: 'amplify-monitor.applyQuickFix',
            fileModification: {
                relativePath: 'amplify.yml',
                action: 'modify',
                content: (existing) => existing.replace(/npm ci/g, 'npm install')
            }
        }
    ],
    'PACKAGE_MANAGER_CONFLICT': [
        {
            id: 'standardize-npm',
            title: '🔧 Standardize on npm',
            description: 'Update amplify.yml to use only npm',
            pattern: 'PACKAGE_MANAGER_CONFLICT',
            command: 'amplify-monitor.applyQuickFix',
            fileModification: {
                relativePath: 'amplify.yml',
                action: 'modify',
                content: (existing) => existing
                    .replace(/pnpm install/g, 'npm ci')
                    .replace(/yarn install/g, 'npm ci')
                    .replace(/pnpm run build/g, 'npm run build')
                    .replace(/yarn build/g, 'npm run build')
            }
        },
        {
            id: 'remove-extra-locks',
            title: '🗑️ Remove extra lock files',
            description: 'Keep only package-lock.json',
            pattern: 'PACKAGE_MANAGER_CONFLICT',
            command: 'amplify-monitor.applyQuickFix',
            requiresConfirmation: true,
            terminalCommand: 'rm -f pnpm-lock.yaml yarn.lock'
        }
    ],
    'LOCKFILE_MISMATCH': [
        {
            id: 'switch-to-npm-lock',
            title: '🔧 Switch to npm',
            description: 'Update amplify.yml to use npm install',
            pattern: 'LOCKFILE_MISMATCH',
            command: 'amplify-monitor.applyQuickFix',
            fileModification: {
                relativePath: 'amplify.yml',
                action: 'modify',
                content: (existing) => existing.replace(/pnpm install|yarn install/g, 'npm ci')
            }
        },
        {
            id: 'switch-to-pnpm-lock',
            title: '🔧 Switch to pnpm',
            description: 'Update amplify.yml to use pnpm install',
            pattern: 'LOCKFILE_MISMATCH',
            command: 'amplify-monitor.applyQuickFix',
            fileModification: {
                relativePath: 'amplify.yml',
                action: 'modify',
                content: (existing) => existing.replace(/npm ci|npm install|yarn install/g, 'pnpm install')
            }
        },
        {
            id: 'delete-package-lock-mismatch',
            title: '🗑️ Delete package-lock.json',
            description: 'Remove package-lock.json (use with pnpm)',
            pattern: 'LOCKFILE_MISMATCH',
            command: 'amplify-monitor.applyQuickFix',
            requiresConfirmation: true,
            fileModification: {
                relativePath: 'package-lock.json',
                action: 'delete'
            }
        }
    ]
};

export class QuickFixService {
    constructor(private workspaceRoot: string) {}

    getFixesForIssue(pattern: string): QuickFix[] {
        return QUICK_FIXES[pattern] || [];
    }

    async applyFix(fix: QuickFix): Promise<boolean> {
        if (fix.requiresConfirmation) {
            const confirm = await vscode.window.showWarningMessage(
                `Are you sure you want to ${fix.description}?`,
                'Yes', 'No'
            );
            if (confirm !== 'Yes') {
                return false;
            }
        }

        if (fix.fileModification) {
            return this.applyFileModification(fix.fileModification);
        }

        if (fix.terminalCommand) {
            const terminal = vscode.window.createTerminal('Amplify Quick Fix');
            terminal.sendText(fix.terminalCommand);
            terminal.show();
            return true;
        }

        return true;
    }

    private async applyFileModification(mod: QuickFix['fileModification']): Promise<boolean> {
        if (!mod) return false;

        const filePath = path.join(this.workspaceRoot, mod.relativePath);

        try {
            switch (mod.action) {
                case 'create': {
                    if (fs.existsSync(filePath)) {
                        const overwrite = await vscode.window.showWarningMessage(
                            `${mod.relativePath} already exists. Overwrite?`,
                            'Yes', 'No'
                        );
                        if (overwrite !== 'Yes') return false;
                    }
                    const content = typeof mod.content === 'function' ? mod.content('') : mod.content || '';
                    fs.writeFileSync(filePath, content, 'utf8');
                    vscode.window.showInformationMessage(`Created ${mod.relativePath}`);
                    
                    // Open the created file
                    const doc = await vscode.workspace.openTextDocument(filePath);
                    await vscode.window.showTextDocument(doc);
                    return true;
                }

                case 'modify': {
                    if (!fs.existsSync(filePath)) {
                        vscode.window.showErrorMessage(`${mod.relativePath} not found`);
                        return false;
                    }
                    const existing = fs.readFileSync(filePath, 'utf8');
                    const newContent = typeof mod.content === 'function' 
                        ? mod.content(existing) 
                        : mod.content || existing;
                    
                    if (newContent === existing) {
                        vscode.window.showInformationMessage(`No changes needed in ${mod.relativePath}`);
                        return true;
                    }
                    
                    fs.writeFileSync(filePath, newContent, 'utf8');
                    vscode.window.showInformationMessage(`Updated ${mod.relativePath}`);
                    
                    // Open the modified file
                    const doc = await vscode.workspace.openTextDocument(filePath);
                    await vscode.window.showTextDocument(doc);
                    return true;
                }

                case 'delete': {
                    if (!fs.existsSync(filePath)) {
                        vscode.window.showInformationMessage(`${mod.relativePath} doesn't exist`);
                        return true;
                    }
                    fs.unlinkSync(filePath);
                    vscode.window.showInformationMessage(`Deleted ${mod.relativePath}`);
                    return true;
                }
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to ${mod.action} ${mod.relativePath}: ${error}`);
            return false;
        }

        return false;
    }
}

export function createQuickFixItems(pattern: string): vscode.QuickPickItem[] {
    const fixes = QUICK_FIXES[pattern] || [];
    return fixes.map(fix => ({
        label: fix.title,
        description: fix.description,
        detail: fix.id
    }));
}
