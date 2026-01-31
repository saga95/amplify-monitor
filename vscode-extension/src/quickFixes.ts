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
