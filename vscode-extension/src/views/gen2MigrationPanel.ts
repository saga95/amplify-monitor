import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AmplifyMonitorCli, MigrationAnalysis, MigrationFeature, MigrationCompatibility } from '../cli';

interface MigrationStep {
    id: string;
    title: string;
    description: string;
    status: 'pending' | 'in-progress' | 'completed' | 'skipped' | 'blocked';
    actions?: { label: string; command: string; args?: any[] }[];
    codeSnippet?: string;
    documentation?: string;
}

export class Gen2MigrationPanel {
    public static currentPanel: Gen2MigrationPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _cli: AmplifyMonitorCli;
    private _disposables: vscode.Disposable[] = [];
    private _analysis: MigrationAnalysis | undefined;
    private _projectPath: string | undefined;
    private _currentStep: number = 0;

    public static createOrShow(extensionUri: vscode.Uri, cli: AmplifyMonitorCli) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (Gen2MigrationPanel.currentPanel) {
            Gen2MigrationPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'gen2Migration',
            'Gen1 → Gen2 Migration Helper',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        Gen2MigrationPanel.currentPanel = new Gen2MigrationPanel(panel, extensionUri, cli);
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
                    case 'selectProject':
                        await this._selectProject();
                        break;
                    case 'analyzeProject':
                        await this._analyzeProject();
                        break;
                    case 'generateGen2Code':
                        await this._generateGen2Code(message.category);
                        break;
                    case 'openDocumentation':
                        vscode.env.openExternal(vscode.Uri.parse(message.url));
                        break;
                    case 'runCommand':
                        await this._runCommand(message.cmd, message.args);
                        break;
                    case 'copyCode':
                        await vscode.env.clipboard.writeText(message.code);
                        vscode.window.showInformationMessage('Code copied to clipboard!');
                        break;
                    case 'createFile':
                        await this._createFile(message.filePath, message.content);
                        break;
                    case 'nextStep':
                        this._currentStep++;
                        this._update();
                        break;
                    case 'prevStep':
                        this._currentStep = Math.max(0, this._currentStep - 1);
                        this._update();
                        break;
                    case 'goToStep':
                        this._currentStep = message.step;
                        this._update();
                        break;
                    case 'initGen2Project':
                        await this._initGen2Project();
                        break;
                    case 'showFeatureDetails':
                        await this._showFeatureDetails(message.feature);
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    private async _selectProject() {
        const folders = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            title: 'Select Amplify Gen1 Project'
        });

        if (folders && folders[0]) {
            this._projectPath = folders[0].fsPath;
            await this._analyzeProject();
        }
    }

    private async _analyzeProject() {
        if (!this._projectPath) {
            // Try to use workspace folder
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders && workspaceFolders.length > 0) {
                this._projectPath = workspaceFolders[0].uri.fsPath;
            } else {
                vscode.window.showWarningMessage('Please select a project folder first');
                return;
            }
        }

        try {
            this._panel.webview.postMessage({ command: 'analyzing', status: true });
            this._analysis = await this._cli.analyzeMigration(this._projectPath);
            this._update();
        } catch (error: any) {
            vscode.window.showErrorMessage(`Analysis failed: ${error.message}`);
            this._panel.webview.postMessage({ command: 'analyzing', status: false });
        }
    }

    private async _generateGen2Code(category: string) {
        if (!this._analysis) return;

        const features = this._analysis.features.filter(f => f.category === category);
        const gen2Code = this._getGen2CodeForCategory(category, features);

        if (gen2Code) {
            // Show code in a new document
            const doc = await vscode.workspace.openTextDocument({
                content: gen2Code,
                language: 'typescript'
            });
            await vscode.window.showTextDocument(doc, { preview: true });
        }
    }

    private _getGen2CodeForCategory(category: string, features: MigrationFeature[]): string {
        switch (category.toLowerCase()) {
            case 'auth':
                return this._generateAuthCode(features);
            case 'api':
                return this._generateApiCode(features);
            case 'storage':
                return this._generateStorageCode(features);
            case 'function':
                return this._generateFunctionCode(features);
            default:
                return `// Gen2 code for ${category}\n// TODO: Manual migration required`;
        }
    }

    private _generateAuthCode(features: MigrationFeature[]): string {
        return `// amplify/auth/resource.ts
import { defineAuth } from '@aws-amplify/backend';

export const auth = defineAuth({
  loginWith: {
    email: true,
    // Add phone if used in Gen1
    // phone: true,
  },
  // Multi-factor authentication
  // multifactor: {
  //   mode: 'OPTIONAL',
  //   sms: true,
  //   totp: true,
  // },
  // User attributes
  userAttributes: {
    email: {
      required: true,
      mutable: true,
    },
    // Add other attributes from your Gen1 config
  },
  // Account recovery
  accountRecovery: 'EMAIL_ONLY',
});

// If you have user groups, add them:
// groups: ['Admin', 'Users'],

/*
Migration Notes:
${features.map(f => `- ${f.feature}: ${this._getCompatibilityText(f.compatibility)}`).join('\n')}

Next Steps:
1. Review and customize the auth configuration above
2. Update your frontend code to use the new auth imports
3. Test authentication flows thoroughly
*/
`;
    }

    private _generateApiCode(features: MigrationFeature[]): string {
        const hasGraphQL = features.some(f => f.feature.toLowerCase().includes('graphql'));
        const hasREST = features.some(f => f.feature.toLowerCase().includes('rest'));

        let code = `// amplify/data/resource.ts
import { defineData, a, type ClientSchema } from '@aws-amplify/backend';

`;

        if (hasGraphQL) {
            code += `const schema = a.schema({
  // Define your models here
  // Example Todo model (replace with your Gen1 schema):
  Todo: a.model({
    content: a.string().required(),
    isDone: a.boolean().default(false),
    priority: a.enum(['low', 'medium', 'high']),
    createdAt: a.datetime(),
  })
    .authorization(allow => [
      allow.owner(),
      allow.authenticated().to(['read']),
    ]),

  // Add more models from your Gen1 schema...
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'userPool',
    // apiKeyAuthorizationMode: { expiresInDays: 30 },
  },
});
`;
        }

        if (hasREST) {
            code += `
// For REST APIs, you'll need to create Lambda functions
// and define them in amplify/functions/

// Example API route definition:
// import { defineFunction } from '@aws-amplify/backend';
// 
// export const apiHandler = defineFunction({
//   name: 'api-handler',
//   entry: './handler.ts',
// });
`;
        }

        code += `
/*
Migration Notes:
${features.map(f => `- ${f.feature}: ${this._getCompatibilityText(f.compatibility)}`).join('\n')}

Schema Migration Steps:
1. Export your Gen1 schema: amplify api gql-compile
2. Review @model, @auth, @connection directives
3. Convert to Gen2 a.model() syntax above
4. Update authorization rules
*/
`;

        return code;
    }

    private _generateStorageCode(features: MigrationFeature[]): string {
        return `// amplify/storage/resource.ts
import { defineStorage } from '@aws-amplify/backend';

export const storage = defineStorage({
  name: 'myProjectStorage',
  access: (allow) => ({
    // Public read access
    'public/*': [
      allow.guest.to(['read']),
      allow.authenticated.to(['read', 'write', 'delete']),
    ],
    // Protected - owner can read/write, others can read
    'protected/{entity_id}/*': [
      allow.entity('identity').to(['read', 'write', 'delete']),
      allow.authenticated.to(['read']),
    ],
    // Private - only owner can access
    'private/{entity_id}/*': [
      allow.entity('identity').to(['read', 'write', 'delete']),
    ],
  }),
});

/*
Migration Notes:
${features.map(f => `- ${f.feature}: ${this._getCompatibilityText(f.compatibility)}`).join('\n')}

Storage Migration Steps:
1. Review your Gen1 storage configuration
2. Map access levels (public/protected/private)
3. Update S3 bucket policies if needed
4. Test file upload/download operations
*/
`;
    }

    private _generateFunctionCode(features: MigrationFeature[]): string {
        return `// amplify/functions/my-function/resource.ts
import { defineFunction } from '@aws-amplify/backend';

export const myFunction = defineFunction({
  name: 'my-function',
  entry: './handler.ts',
  // Environment variables
  environment: {
    // Add your environment variables
  },
  // Timeout in seconds (default: 3, max: 900)
  timeoutSeconds: 30,
  // Memory in MB (default: 512)
  memoryMB: 512,
  // Runtime (default: nodejs18.x)
  runtime: 18,
});

// amplify/functions/my-function/handler.ts
import type { Handler } from 'aws-lambda';

export const handler: Handler = async (event, context) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  // Your function logic here
  
  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Hello from Gen2!' }),
  };
};

/*
Migration Notes:
${features.map(f => `- ${f.feature}: ${this._getCompatibilityText(f.compatibility)}`).join('\n')}

Function Migration Steps:
1. Copy your Gen1 function code to amplify/functions/<name>/handler.ts
2. Update the resource.ts with correct config
3. Update any resource references (tables, storage, etc.)
4. Test function locally: npx ampx sandbox
*/
`;
    }

    private _getCompatibilityText(compat: MigrationCompatibility): string {
        if (typeof compat === 'string') {
            return compat;
        }
        if ('Supported' in compat) return '✅ Supported';
        if ('SupportedWithCDK' in compat) return `🔧 Requires CDK: ${compat.SupportedWithCDK}`;
        if ('NotSupported' in compat) return `❌ Not supported: ${compat.NotSupported}`;
        if ('ManualMigration' in compat) return `⚠️ Manual migration: ${compat.ManualMigration}`;
        return 'Unknown';
    }

    private async _runCommand(cmd: string, args?: any[]) {
        try {
            await vscode.commands.executeCommand(cmd, ...(args || []));
        } catch (error: any) {
            vscode.window.showErrorMessage(`Command failed: ${error.message}`);
        }
    }

    private async _createFile(filePath: string, content: string) {
        if (!this._projectPath) return;

        const fullPath = path.join(this._projectPath, filePath);
        const dir = path.dirname(fullPath);

        try {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(fullPath, content);
            
            // Open the created file
            const doc = await vscode.workspace.openTextDocument(fullPath);
            await vscode.window.showTextDocument(doc);
            
            vscode.window.showInformationMessage(`Created: ${filePath}`);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to create file: ${error.message}`);
        }
    }

    private async _initGen2Project() {
        if (!this._projectPath) {
            vscode.window.showWarningMessage('Please select a project folder first');
            return;
        }

        const terminal = vscode.window.createTerminal({
            name: 'Amplify Gen2 Init',
            cwd: this._projectPath
        });

        terminal.show();
        terminal.sendText('npm create amplify@latest');
        
        vscode.window.showInformationMessage(
            'Follow the prompts in the terminal to initialize your Gen2 project.',
            'View Documentation'
        ).then(action => {
            if (action === 'View Documentation') {
                vscode.env.openExternal(vscode.Uri.parse('https://docs.amplify.aws/react/start/quickstart/'));
            }
        });
    }

    private async _showFeatureDetails(feature: MigrationFeature) {
        const panel = vscode.window.createWebviewPanel(
            'featureDetails',
            `Migration: ${feature.feature}`,
            vscode.ViewColumn.Beside,
            { enableScripts: true }
        );

        const gen2Code = this._getFeatureGen2Code(feature);
        
        panel.webview.html = `<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: var(--vscode-font-family); padding: 20px; }
        h1 { color: var(--vscode-foreground); }
        .compat { padding: 8px 16px; border-radius: 4px; margin: 16px 0; }
        .supported { background: rgba(0, 200, 0, 0.1); border: 1px solid rgba(0, 200, 0, 0.3); }
        .cdk { background: rgba(255, 165, 0, 0.1); border: 1px solid rgba(255, 165, 0, 0.3); }
        .manual { background: rgba(255, 200, 0, 0.1); border: 1px solid rgba(255, 200, 0, 0.3); }
        .not-supported { background: rgba(255, 0, 0, 0.1); border: 1px solid rgba(255, 0, 0, 0.3); }
        pre { background: var(--vscode-editor-background); padding: 16px; border-radius: 4px; overflow-x: auto; }
        code { font-family: var(--vscode-editor-font-family); }
        .hint { background: var(--vscode-editor-inactiveSelectionBackground); padding: 12px; border-radius: 4px; margin: 16px 0; }
    </style>
</head>
<body>
    <h1>${feature.feature}</h1>
    <p><strong>Category:</strong> ${feature.category}</p>
    <div class="compat ${this._getCompatClass(feature.compatibility)}">
        ${this._getCompatibilityText(feature.compatibility)}
    </div>
    
    ${feature.migrationHint ? `<div class="hint"><strong>💡 Migration Hint:</strong> ${feature.migrationHint}</div>` : ''}
    
    <h2>Gen2 Equivalent</h2>
    <pre><code>${this._escapeHtml(gen2Code)}</code></pre>
    
    <h2>Documentation</h2>
    <p><a href="https://docs.amplify.aws/react/start/migrate-to-gen2/">Official Migration Guide</a></p>
</body>
</html>`;
    }

    private _getCompatClass(compat: MigrationCompatibility): string {
        if (typeof compat === 'string') return 'supported';
        if ('Supported' in compat) return 'supported';
        if ('SupportedWithCDK' in compat) return 'cdk';
        if ('NotSupported' in compat) return 'not-supported';
        if ('ManualMigration' in compat) return 'manual';
        return '';
    }

    private _getFeatureGen2Code(feature: MigrationFeature): string {
        const name = feature.feature.toLowerCase();
        
        if (name.includes('cognito') || name.includes('auth')) {
            return `// amplify/auth/resource.ts
import { defineAuth } from '@aws-amplify/backend';

export const auth = defineAuth({
  loginWith: { email: true },
});`;
        }
        
        if (name.includes('dynamodb') || name.includes('table')) {
            return `// In your schema definition
const schema = a.schema({
  ${feature.feature.replace(/[^a-zA-Z]/g, '')}: a.model({
    id: a.id(),
    // Add your fields here
  }).authorization(allow => [allow.owner()]),
});`;
        }

        if (name.includes('s3') || name.includes('storage')) {
            return `// amplify/storage/resource.ts
import { defineStorage } from '@aws-amplify/backend';

export const storage = defineStorage({
  name: 'myStorage',
});`;
        }

        if (name.includes('lambda') || name.includes('function')) {
            return `// amplify/functions/${feature.feature}/resource.ts
import { defineFunction } from '@aws-amplify/backend';

export const ${feature.feature.replace(/[^a-zA-Z]/g, '')} = defineFunction({
  name: '${feature.feature}',
});`;
        }

        return `// Migration required for: ${feature.feature}
// See documentation for manual steps`;
    }

    private _escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    private _update() {
        this._panel.webview.html = this._getHtmlForWebview();
    }

    private _getHtmlForWebview(): string {
        const nonce = this._getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>Gen1 → Gen2 Migration Helper</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            padding: 20px;
            line-height: 1.6;
        }
        .header {
            display: flex;
            align-items: center;
            gap: 16px;
            margin-bottom: 24px;
            padding-bottom: 16px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .header-icon {
            font-size: 48px;
        }
        .header-text h1 {
            font-size: 24px;
            margin-bottom: 4px;
        }
        .header-text p {
            color: var(--vscode-descriptionForeground);
        }
        
        .wizard-steps {
            display: flex;
            gap: 8px;
            margin-bottom: 32px;
            flex-wrap: wrap;
        }
        .wizard-step {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 16px;
            background: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 20px;
            cursor: pointer;
            opacity: 0.6;
            transition: all 0.2s;
        }
        .wizard-step.active {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            opacity: 1;
        }
        .wizard-step.completed {
            opacity: 1;
            background: rgba(0, 200, 0, 0.2);
        }
        .wizard-step:hover {
            opacity: 0.9;
        }
        .step-number {
            width: 24px;
            height: 24px;
            border-radius: 50%;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
            font-weight: bold;
        }
        .wizard-step.completed .step-number {
            background: rgba(0, 200, 0, 0.8);
        }

        .content {
            background: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 8px;
            padding: 24px;
            margin-bottom: 24px;
        }
        
        .btn {
            padding: 10px 20px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            display: inline-flex;
            align-items: center;
            gap: 8px;
            transition: opacity 0.2s;
        }
        .btn:hover { opacity: 0.9; }
        .btn-primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .btn-secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-success {
            background: rgba(0, 200, 0, 0.8);
            color: white;
        }
        .btn-outline {
            background: transparent;
            border: 1px solid var(--vscode-button-background);
            color: var(--vscode-button-background);
        }

        .analysis-section {
            margin-top: 24px;
        }
        .analysis-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 16px;
        }
        
        .summary-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 16px;
            margin-bottom: 24px;
        }
        .summary-card {
            background: var(--vscode-editor-background);
            border-radius: 8px;
            padding: 16px;
            text-align: center;
        }
        .summary-card .number {
            font-size: 32px;
            font-weight: bold;
            margin-bottom: 4px;
        }
        .summary-card.success .number { color: #4caf50; }
        .summary-card.warning .number { color: #ff9800; }
        .summary-card.error .number { color: #f44336; }
        .summary-card .label {
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
        }

        .category-section {
            margin-top: 24px;
        }
        .category-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 16px;
            background: var(--vscode-editor-background);
            border-radius: 8px;
            cursor: pointer;
            margin-bottom: 8px;
        }
        .category-header:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .category-title {
            display: flex;
            align-items: center;
            gap: 12px;
            font-weight: 600;
        }
        .category-icon {
            font-size: 20px;
        }
        .category-badge {
            padding: 2px 8px;
            border-radius: 10px;
            font-size: 12px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }

        .features-list {
            padding-left: 20px;
        }
        .feature-item {
            display: flex;
            align-items: flex-start;
            gap: 12px;
            padding: 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .feature-item:last-child {
            border-bottom: none;
        }
        .feature-status {
            font-size: 18px;
        }
        .feature-info {
            flex: 1;
        }
        .feature-name {
            font-weight: 500;
            margin-bottom: 4px;
        }
        .feature-compat {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        .feature-hint {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
            padding: 8px;
            background: var(--vscode-textBlockQuote-background);
            border-radius: 4px;
        }

        .code-block {
            background: var(--vscode-editor-background);
            border-radius: 4px;
            padding: 16px;
            margin: 16px 0;
            overflow-x: auto;
            position: relative;
        }
        .code-block pre {
            margin: 0;
            font-family: var(--vscode-editor-font-family);
            font-size: 13px;
        }
        .copy-btn {
            position: absolute;
            top: 8px;
            right: 8px;
            padding: 4px 8px;
            font-size: 12px;
        }

        .checklist {
            list-style: none;
        }
        .checklist li {
            display: flex;
            align-items: flex-start;
            gap: 12px;
            padding: 12px 0;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .checklist li:last-child {
            border-bottom: none;
        }
        .check-icon {
            width: 24px;
            height: 24px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            flex-shrink: 0;
        }
        .check-icon.pending {
            border: 2px solid var(--vscode-descriptionForeground);
        }
        .check-icon.done {
            background: #4caf50;
            color: white;
        }

        .nav-buttons {
            display: flex;
            justify-content: space-between;
            margin-top: 24px;
            padding-top: 24px;
            border-top: 1px solid var(--vscode-panel-border);
        }

        .loading {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 48px;
            color: var(--vscode-descriptionForeground);
        }
        .spinner {
            width: 32px;
            height: 32px;
            border: 3px solid var(--vscode-editor-inactiveSelectionBackground);
            border-top-color: var(--vscode-button-background);
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-bottom: 16px;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        .alert {
            padding: 16px;
            border-radius: 8px;
            margin-bottom: 16px;
        }
        .alert-success {
            background: rgba(76, 175, 80, 0.1);
            border: 1px solid rgba(76, 175, 80, 0.3);
        }
        .alert-warning {
            background: rgba(255, 152, 0, 0.1);
            border: 1px solid rgba(255, 152, 0, 0.3);
        }
        .alert-error {
            background: rgba(244, 67, 54, 0.1);
            border: 1px solid rgba(244, 67, 54, 0.3);
        }
        .alert-info {
            background: rgba(33, 150, 243, 0.1);
            border: 1px solid rgba(33, 150, 243, 0.3);
        }

        .empty-state {
            text-align: center;
            padding: 48px;
            color: var(--vscode-descriptionForeground);
        }
        .empty-state-icon {
            font-size: 64px;
            margin-bottom: 16px;
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="header-icon">🚀</div>
        <div class="header-text">
            <h1>Amplify Gen1 → Gen2 Migration</h1>
            <p>Step-by-step guide to migrate your Amplify project to the new Gen2 architecture</p>
        </div>
    </div>

    ${this._renderWizardSteps()}
    
    <div class="content">
        ${this._renderCurrentStep()}
    </div>

    ${this._renderNavigation()}

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        
        function selectProject() {
            vscode.postMessage({ command: 'selectProject' });
        }
        
        function analyzeProject() {
            vscode.postMessage({ command: 'analyzeProject' });
        }
        
        function generateCode(category) {
            vscode.postMessage({ command: 'generateGen2Code', category });
        }
        
        function openDocs(url) {
            vscode.postMessage({ command: 'openDocumentation', url });
        }
        
        function copyCode(code) {
            vscode.postMessage({ command: 'copyCode', code });
        }
        
        function createFile(filePath, content) {
            vscode.postMessage({ command: 'createFile', filePath, content });
        }
        
        function nextStep() {
            vscode.postMessage({ command: 'nextStep' });
        }
        
        function prevStep() {
            vscode.postMessage({ command: 'prevStep' });
        }
        
        function goToStep(step) {
            vscode.postMessage({ command: 'goToStep', step });
        }
        
        function initGen2() {
            vscode.postMessage({ command: 'initGen2Project' });
        }
        
        function showFeatureDetails(feature) {
            vscode.postMessage({ command: 'showFeatureDetails', feature });
        }
        
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'analyzing') {
                // Handle analyzing state
            }
        });
    </script>
</body>
</html>`;
    }

    private _renderWizardSteps(): string {
        const steps = [
            { title: 'Analyze', icon: '🔍' },
            { title: 'Review', icon: '📋' },
            { title: 'Initialize', icon: '🚀' },
            { title: 'Migrate', icon: '🔄' },
            { title: 'Verify', icon: '✅' }
        ];

        return `
        <div class="wizard-steps">
            ${steps.map((step, index) => `
                <div class="wizard-step ${index === this._currentStep ? 'active' : ''} ${index < this._currentStep ? 'completed' : ''}"
                     onclick="goToStep(${index})">
                    <span class="step-number">${index < this._currentStep ? '✓' : index + 1}</span>
                    <span>${step.title}</span>
                </div>
            `).join('')}
        </div>`;
    }

    private _renderCurrentStep(): string {
        switch (this._currentStep) {
            case 0: return this._renderStep0Analyze();
            case 1: return this._renderStep1Review();
            case 2: return this._renderStep2Initialize();
            case 3: return this._renderStep3Migrate();
            case 4: return this._renderStep4Verify();
            default: return this._renderStep0Analyze();
        }
    }

    private _renderStep0Analyze(): string {
        if (!this._analysis) {
            return `
            <h2>Step 1: Analyze Your Gen1 Project</h2>
            <p style="margin: 16px 0; color: var(--vscode-descriptionForeground);">
                First, let's analyze your existing Amplify Gen1 project to understand what needs to be migrated.
            </p>
            
            <div class="alert alert-info">
                <strong>💡 What we'll check:</strong>
                <ul style="margin: 8px 0 0 20px;">
                    <li>Authentication configuration (Cognito)</li>
                    <li>API definitions (GraphQL/REST)</li>
                    <li>Storage settings (S3)</li>
                    <li>Lambda functions</li>
                    <li>Custom resources and configurations</li>
                </ul>
            </div>

            ${this._projectPath ? `
                <p style="margin: 16px 0;"><strong>Project:</strong> ${this._projectPath}</p>
                <button class="btn btn-primary" onclick="analyzeProject()">
                    🔍 Analyze Project
                </button>
            ` : `
                <div class="empty-state">
                    <div class="empty-state-icon">📁</div>
                    <h3>Select Your Project</h3>
                    <p style="margin: 16px 0;">Choose the folder containing your Amplify Gen1 project</p>
                    <button class="btn btn-primary" onclick="selectProject()">
                        📂 Select Project Folder
                    </button>
                </div>
            `}
            `;
        }

        // Show analysis results
        return this._renderAnalysisResults();
    }

    private _renderAnalysisResults(): string {
        if (!this._analysis) return '';

        if (this._analysis.generation === 'Gen2') {
            return `
            <div class="alert alert-success">
                <h3>✅ Already Using Gen2!</h3>
                <p>This project is already using Amplify Gen2. No migration needed.</p>
            </div>`;
        }

        if (this._analysis.generation === 'Unknown') {
            return `
            <div class="alert alert-warning">
                <h3>⚠️ Not an Amplify Project</h3>
                <p>We couldn't detect an Amplify project in this directory.</p>
                <p>Make sure you have an <code>amplify/</code> folder in your project.</p>
            </div>
            <button class="btn btn-secondary" onclick="selectProject()">
                📂 Select Different Folder
            </button>`;
        }

        const { summary } = this._analysis;

        return `
        <h2>📊 Analysis Results</h2>
        <p style="margin: 8px 0 24px; color: var(--vscode-descriptionForeground);">
            Project: ${this._analysis.projectPath}
        </p>

        <div class="summary-grid">
            <div class="summary-card success">
                <div class="number">${summary.fullySupported}</div>
                <div class="label">Fully Supported</div>
            </div>
            <div class="summary-card warning">
                <div class="number">${summary.supportedWithCdk}</div>
                <div class="label">Needs CDK</div>
            </div>
            <div class="summary-card warning">
                <div class="number">${summary.manualMigration}</div>
                <div class="label">Manual Migration</div>
            </div>
            <div class="summary-card error">
                <div class="number">${summary.notSupported}</div>
                <div class="label">Not Supported</div>
            </div>
        </div>

        ${this._analysis.readyForMigration ? `
            <div class="alert alert-success">
                <strong>✅ Ready for Migration!</strong>
                <p>Your project can be migrated to Gen2. Click "Next" to continue.</p>
            </div>
        ` : `
            <div class="alert alert-error">
                <strong>❌ Blocking Issues Found</strong>
                <ul style="margin: 8px 0 0 20px;">
                    ${this._analysis.blockingIssues.map(issue => `<li>${issue}</li>`).join('')}
                </ul>
            </div>
        `}

        ${this._analysis.warnings.length > 0 ? `
            <div class="alert alert-warning">
                <strong>⚠️ Warnings</strong>
                <ul style="margin: 8px 0 0 20px;">
                    ${this._analysis.warnings.map(w => `<li>${w}</li>`).join('')}
                </ul>
            </div>
        ` : ''}

        <div class="category-section">
            <h3 style="margin-bottom: 16px;">Detected Features by Category</h3>
            ${this._analysis.categoriesDetected.map(category => this._renderCategory(category)).join('')}
        </div>
        `;
    }

    private _renderCategory(category: string): string {
        if (!this._analysis) return '';

        const features = this._analysis.features.filter(f => f.category === category);
        const supportedCount = features.filter(f => {
            const compat = f.compatibility as any;
            return compat?.type === 'Supported' || compat === 'Supported' || (compat && 'Supported' in compat);
        }).length;

        const icon = this._getCategoryIcon(category);

        return `
        <details class="category-section" style="margin-bottom: 8px;">
            <summary class="category-header">
                <div class="category-title">
                    <span class="category-icon">${icon}</span>
                    <span>${category.toUpperCase()}</span>
                </div>
                <div style="display: flex; gap: 8px; align-items: center;">
                    <span class="category-badge">${supportedCount}/${features.length}</span>
                    <button class="btn btn-outline" style="padding: 4px 8px; font-size: 12px;" 
                            onclick="event.stopPropagation(); generateCode('${category}')">
                        Generate Code
                    </button>
                </div>
            </summary>
            <div class="features-list">
                ${features.map(f => this._renderFeature(f)).join('')}
            </div>
        </details>`;
    }

    private _renderFeature(feature: MigrationFeature): string {
        const status = this._getFeatureStatus(feature.compatibility);
        
        return `
        <div class="feature-item">
            <span class="feature-status">${status.icon}</span>
            <div class="feature-info">
                <div class="feature-name">${feature.feature}</div>
                <div class="feature-compat">${status.text}</div>
                ${feature.migrationHint ? `
                    <div class="feature-hint">💡 ${feature.migrationHint}</div>
                ` : ''}
            </div>
        </div>`;
    }

    private _getFeatureStatus(compat: MigrationCompatibility): { icon: string; text: string } {
        if (typeof compat === 'string') {
            return { icon: '✅', text: 'Supported' };
        }
        if ('Supported' in compat) return { icon: '✅', text: 'Fully supported in Gen2' };
        if ('SupportedWithCDK' in compat) return { icon: '🔧', text: `Requires CDK: ${compat.SupportedWithCDK}` };
        if ('NotSupported' in compat) return { icon: '❌', text: `Not supported: ${compat.NotSupported}` };
        if ('ManualMigration' in compat) return { icon: '⚠️', text: `Manual migration: ${compat.ManualMigration}` };
        return { icon: '❓', text: 'Unknown' };
    }

    private _getCategoryIcon(category: string): string {
        const icons: Record<string, string> = {
            'auth': '🔐',
            'api': '🔌',
            'storage': '📦',
            'function': '⚡',
            'hosting': '🌐',
            'analytics': '📊',
            'predictions': '🤖',
            'interactions': '💬',
            'notifications': '🔔',
            'geo': '🗺️'
        };
        return icons[category.toLowerCase()] || '📁';
    }

    private _renderStep1Review(): string {
        if (!this._analysis || this._analysis.generation !== 'Gen1') {
            return `
            <div class="alert alert-warning">
                <h3>⚠️ Analysis Required</h3>
                <p>Please complete the analysis step first.</p>
            </div>
            <button class="btn btn-secondary" onclick="goToStep(0)">← Back to Analysis</button>`;
        }

        return `
        <h2>Step 2: Review Migration Plan</h2>
        <p style="margin: 16px 0; color: var(--vscode-descriptionForeground);">
            Review what will be migrated and the recommended approach for each feature.
        </p>

        <div class="alert alert-info">
            <strong>📋 Migration Checklist</strong>
            <p>Here's what we'll help you migrate:</p>
        </div>

        <ul class="checklist">
            ${this._analysis.categoriesDetected.map(cat => {
                const features = this._analysis!.features.filter(f => f.category === cat);
                const allSupported = features.every(f => {
                    const c = f.compatibility as any;
                    return c === 'Supported' || c?.type === 'Supported' || 'Supported' in c;
                });
                return `
                <li>
                    <span class="check-icon ${allSupported ? 'done' : 'pending'}">${allSupported ? '✓' : ''}</span>
                    <div>
                        <strong>${this._getCategoryIcon(cat)} ${cat.toUpperCase()}</strong>
                        <p style="color: var(--vscode-descriptionForeground); font-size: 13px;">
                            ${features.length} feature(s) to migrate
                        </p>
                    </div>
                </li>`;
            }).join('')}
        </ul>

        <h3 style="margin-top: 24px;">📚 Recommended Reading</h3>
        <div style="margin-top: 12px;">
            <button class="btn btn-outline" onclick="openDocs('https://docs.amplify.aws/react/start/migrate-to-gen2/')">
                📖 Official Migration Guide
            </button>
            <button class="btn btn-outline" onclick="openDocs('https://docs.amplify.aws/react/how-amplify-works/concepts/')">
                📖 Gen2 Concepts
            </button>
        </div>
        `;
    }

    private _renderStep2Initialize(): string {
        return `
        <h2>Step 3: Initialize Gen2 Project</h2>
        <p style="margin: 16px 0; color: var(--vscode-descriptionForeground);">
            Create the Gen2 project structure alongside your existing Gen1 code.
        </p>

        <div class="alert alert-info">
            <strong>💡 What This Does:</strong>
            <ul style="margin: 8px 0 0 20px;">
                <li>Creates <code>amplify/</code> folder with Gen2 structure</li>
                <li>Sets up TypeScript configuration</li>
                <li>Installs required dependencies</li>
                <li>Creates backend definition files</li>
            </ul>
        </div>

        <div style="margin: 24px 0;">
            <h3>Option 1: Automated Setup</h3>
            <button class="btn btn-primary" onclick="initGen2()" style="margin-top: 12px;">
                🚀 Initialize Gen2 Project
            </button>
            <p style="margin-top: 8px; font-size: 13px; color: var(--vscode-descriptionForeground);">
                Runs <code>npm create amplify@latest</code> in your project
            </p>
        </div>

        <div style="margin: 24px 0;">
            <h3>Option 2: Manual Setup</h3>
            <p style="margin: 8px 0; color: var(--vscode-descriptionForeground);">
                Run these commands in your terminal:
            </p>
            <div class="code-block">
                <button class="btn copy-btn" onclick="copyCode('npm create amplify@latest\\ncd amplify\\nnpm install')">📋</button>
                <pre>npm create amplify@latest
cd amplify
npm install</pre>
            </div>
        </div>

        <div class="alert alert-warning">
            <strong>⚠️ Important:</strong>
            <p>Keep your Gen1 <code>amplify/</code> folder until migration is complete and verified.</p>
        </div>
        `;
    }

    private _renderStep3Migrate(): string {
        if (!this._analysis || this._analysis.generation !== 'Gen1') {
            return `<div class="alert alert-warning">Please complete analysis first.</div>`;
        }

        return `
        <h2>Step 4: Migrate Features</h2>
        <p style="margin: 16px 0; color: var(--vscode-descriptionForeground);">
            Migrate each feature category to Gen2. Click "Generate Code" to get started code for each.
        </p>

        ${this._analysis.categoriesDetected.map(cat => `
            <div style="background: var(--vscode-editor-background); border-radius: 8px; padding: 16px; margin-bottom: 16px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                    <h3>${this._getCategoryIcon(cat)} ${cat.toUpperCase()}</h3>
                    <button class="btn btn-success" onclick="generateCode('${cat}')">
                        📝 Generate Code
                    </button>
                </div>
                ${this._getMigrationInstructions(cat)}
            </div>
        `).join('')}

        <div class="alert alert-info" style="margin-top: 24px;">
            <strong>💡 Testing Your Migration:</strong>
            <p>Use the Amplify Sandbox for local development:</p>
            <div class="code-block">
                <button class="btn copy-btn" onclick="copyCode('npx ampx sandbox')">📋</button>
                <pre>npx ampx sandbox</pre>
            </div>
        </div>
        `;
    }

    private _getMigrationInstructions(category: string): string {
        const instructions: Record<string, string> = {
            'auth': `
                <ol style="margin: 0; padding-left: 20px; color: var(--vscode-descriptionForeground);">
                    <li>Create <code>amplify/auth/resource.ts</code></li>
                    <li>Configure login methods (email, phone, social)</li>
                    <li>Set up user attributes and MFA</li>
                    <li>Update frontend auth imports</li>
                </ol>`,
            'api': `
                <ol style="margin: 0; padding-left: 20px; color: var(--vscode-descriptionForeground);">
                    <li>Create <code>amplify/data/resource.ts</code></li>
                    <li>Define schema using <code>a.model()</code></li>
                    <li>Set authorization rules</li>
                    <li>Update GraphQL client code</li>
                </ol>`,
            'storage': `
                <ol style="margin: 0; padding-left: 20px; color: var(--vscode-descriptionForeground);">
                    <li>Create <code>amplify/storage/resource.ts</code></li>
                    <li>Define access patterns</li>
                    <li>Migrate existing S3 buckets (optional)</li>
                    <li>Update storage client code</li>
                </ol>`,
            'function': `
                <ol style="margin: 0; padding-left: 20px; color: var(--vscode-descriptionForeground);">
                    <li>Create <code>amplify/functions/&lt;name&gt;/resource.ts</code></li>
                    <li>Copy function code to <code>handler.ts</code></li>
                    <li>Update environment variables</li>
                    <li>Configure triggers and permissions</li>
                </ol>`
        };

        return instructions[category.toLowerCase()] || `
            <p style="color: var(--vscode-descriptionForeground);">
                Follow the generated code template and official documentation for this category.
            </p>`;
    }

    private _renderStep4Verify(): string {
        return `
        <h2>Step 5: Verify & Deploy</h2>
        <p style="margin: 16px 0; color: var(--vscode-descriptionForeground);">
            Final steps to complete your migration.
        </p>

        <ul class="checklist">
            <li>
                <span class="check-icon pending"></span>
                <div>
                    <strong>Test Locally</strong>
                    <p style="color: var(--vscode-descriptionForeground); font-size: 13px;">
                        Run <code>npx ampx sandbox</code> to test your Gen2 backend
                    </p>
                </div>
            </li>
            <li>
                <span class="check-icon pending"></span>
                <div>
                    <strong>Update Frontend Code</strong>
                    <p style="color: var(--vscode-descriptionForeground); font-size: 13px;">
                        Update imports to use new Gen2 client libraries
                    </p>
                </div>
            </li>
            <li>
                <span class="check-icon pending"></span>
                <div>
                    <strong>Run Tests</strong>
                    <p style="color: var(--vscode-descriptionForeground); font-size: 13px;">
                        Verify all functionality works as expected
                    </p>
                </div>
            </li>
            <li>
                <span class="check-icon pending"></span>
                <div>
                    <strong>Deploy to Cloud</strong>
                    <p style="color: var(--vscode-descriptionForeground); font-size: 13px;">
                        Push to Git to trigger Amplify CI/CD deployment
                    </p>
                </div>
            </li>
            <li>
                <span class="check-icon pending"></span>
                <div>
                    <strong>Remove Gen1 Resources</strong>
                    <p style="color: var(--vscode-descriptionForeground); font-size: 13px;">
                        After verification, remove old Gen1 <code>amplify/</code> folder
                    </p>
                </div>
            </li>
        </ul>

        <div class="alert alert-success" style="margin-top: 24px;">
            <h3>🎉 Congratulations!</h3>
            <p>Once all steps are complete, your project will be running on Amplify Gen2!</p>
        </div>

        <div style="margin-top: 24px;">
            <h3>📚 Resources</h3>
            <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px;">
                <button class="btn btn-outline" onclick="openDocs('https://docs.amplify.aws/react/')">
                    Gen2 Documentation
                </button>
                <button class="btn btn-outline" onclick="openDocs('https://github.com/aws-amplify/amplify-backend')">
                    GitHub Repository
                </button>
                <button class="btn btn-outline" onclick="openDocs('https://discord.gg/amplify')">
                    Discord Community
                </button>
            </div>
        </div>
        `;
    }

    private _renderNavigation(): string {
        const isFirstStep = this._currentStep === 0;
        const isLastStep = this._currentStep === 4;
        const canProceed = this._currentStep === 0 ? !!this._analysis : true;

        return `
        <div class="nav-buttons">
            <button class="btn btn-secondary" onclick="prevStep()" ${isFirstStep ? 'disabled style="opacity: 0.5;"' : ''}>
                ← Previous
            </button>
            <button class="btn btn-primary" onclick="nextStep()" ${isLastStep || !canProceed ? 'disabled style="opacity: 0.5;"' : ''}>
                ${isLastStep ? 'Complete' : 'Next →'}
            </button>
        </div>`;
    }

    private _getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    public dispose() {
        Gen2MigrationPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}
