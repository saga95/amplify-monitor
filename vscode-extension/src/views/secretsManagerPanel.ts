import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

interface SSMParameter {
    name: string;
    value?: string;
    type: 'String' | 'SecureString' | 'StringList';
    lastModified?: string;
    description?: string;
}

interface SecretsManagerSecret {
    name: string;
    arn: string;
    description?: string;
    lastChanged?: string;
    tags?: Record<string, string>;
}

interface SyncResult {
    synced: string[];
    skipped: string[];
    errors: string[];
}

export class SecretsManagerPanel {
    public static currentPanel: SecretsManagerPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _workspaceRoot: string;
    private _awsProfile: string | undefined;
    private _awsRegion: string = 'us-east-1';
    private _ssmParameters: SSMParameter[] = [];
    private _secrets: SecretsManagerSecret[] = [];
    private _amplifyEnvVars: Map<string, string> = new Map();
    private _selectedAppId: string | undefined;
    private _selectedBranch: string | undefined;

    public static createOrShow(workspaceRoot: string, appId?: string, branch?: string) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (SecretsManagerPanel.currentPanel) {
            SecretsManagerPanel.currentPanel._panel.reveal(column);
            if (appId) SecretsManagerPanel.currentPanel._selectedAppId = appId;
            if (branch) SecretsManagerPanel.currentPanel._selectedBranch = branch;
            SecretsManagerPanel.currentPanel.refresh();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'secretsManager',
            '🔐 Secrets Manager',
            column || vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        SecretsManagerPanel.currentPanel = new SecretsManagerPanel(panel, workspaceRoot, appId, branch);
    }

    private constructor(panel: vscode.WebviewPanel, workspaceRoot: string, appId?: string, branch?: string) {
        this._panel = panel;
        this._workspaceRoot = workspaceRoot;
        this._selectedAppId = appId;
        this._selectedBranch = branch;
        
        // Get AWS profile from settings
        const config = vscode.workspace.getConfiguration('amplifyMonitor');
        this._awsProfile = config.get<string>('awsProfile');
        
        this._panel.webview.html = this._getLoadingHtml();

        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'refresh':
                        await this.refresh();
                        break;
                    case 'fetchSSM':
                        await this.fetchSSMParameters(message.prefix);
                        break;
                    case 'fetchSecrets':
                        await this.fetchSecrets(message.prefix);
                        break;
                    case 'syncToAmplify':
                        await this.syncToAmplify(message.items, message.appId, message.branch);
                        break;
                    case 'syncFromAmplify':
                        await this.syncFromAmplify(message.items, message.prefix);
                        break;
                    case 'createEnvExample':
                        await this.createEnvExample(message.items);
                        break;
                    case 'setRegion':
                        this._awsRegion = message.region;
                        await this.refresh();
                        break;
                    case 'revealValue':
                        await this.revealParameterValue(message.name);
                        break;
                }
            },
            null,
            this._disposables
        );

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this.refresh();
    }

    public async refresh() {
        this._panel.webview.html = this._getLoadingHtml();
        
        // Fetch data in parallel
        await Promise.all([
            this.fetchSSMParameters('/amplify/'),
            this.fetchSecrets('amplify'),
            this.fetchAmplifyEnvVars()
        ]);

        this._panel.webview.html = this._getResultsHtml();
    }

    private async fetchSSMParameters(prefix: string = '/') {
        try {
            const profileArg = this._awsProfile ? `--profile ${this._awsProfile}` : '';
            const cmd = `aws ssm get-parameters-by-path --path "${prefix}" --recursive --with-decryption --region ${this._awsRegion} ${profileArg} --output json 2>&1`;
            
            const result = cp.execSync(cmd, {
                encoding: 'utf-8',
                maxBuffer: 10 * 1024 * 1024,
                timeout: 30000
            });

            const data = JSON.parse(result);
            this._ssmParameters = (data.Parameters || []).map((p: any) => ({
                name: p.Name,
                value: p.Value,
                type: p.Type,
                lastModified: p.LastModifiedDate,
                description: p.Description
            }));
        } catch (e: any) {
            console.error('Failed to fetch SSM parameters:', e.message);
            this._ssmParameters = [];
        }
    }

    private async fetchSecrets(prefix: string = '') {
        try {
            const profileArg = this._awsProfile ? `--profile ${this._awsProfile}` : '';
            const filterArg = prefix ? `--filters Key=name,Values=${prefix}` : '';
            const cmd = `aws secretsmanager list-secrets ${filterArg} --region ${this._awsRegion} ${profileArg} --output json 2>&1`;
            
            const result = cp.execSync(cmd, {
                encoding: 'utf-8',
                maxBuffer: 10 * 1024 * 1024,
                timeout: 30000
            });

            const data = JSON.parse(result);
            this._secrets = (data.SecretList || []).map((s: any) => ({
                name: s.Name,
                arn: s.ARN,
                description: s.Description,
                lastChanged: s.LastChangedDate,
                tags: s.Tags?.reduce((acc: any, t: any) => ({ ...acc, [t.Key]: t.Value }), {})
            }));
        } catch (e: any) {
            console.error('Failed to fetch secrets:', e.message);
            this._secrets = [];
        }
    }

    private async fetchAmplifyEnvVars() {
        if (!this._selectedAppId || !this._selectedBranch) {
            this._amplifyEnvVars = new Map();
            return;
        }

        try {
            const profileArg = this._awsProfile ? `--profile ${this._awsProfile}` : '';
            const cmd = `aws amplify get-branch --app-id ${this._selectedAppId} --branch-name ${this._selectedBranch} --region ${this._awsRegion} ${profileArg} --output json 2>&1`;
            
            const result = cp.execSync(cmd, {
                encoding: 'utf-8',
                maxBuffer: 10 * 1024 * 1024,
                timeout: 30000
            });

            const data = JSON.parse(result);
            this._amplifyEnvVars = new Map(Object.entries(data.branch?.environmentVariables || {}));
        } catch (e: any) {
            console.error('Failed to fetch Amplify env vars:', e.message);
            this._amplifyEnvVars = new Map();
        }
    }

    private async revealParameterValue(name: string) {
        try {
            const profileArg = this._awsProfile ? `--profile ${this._awsProfile}` : '';
            const cmd = `aws ssm get-parameter --name "${name}" --with-decryption --region ${this._awsRegion} ${profileArg} --output json 2>&1`;
            
            const result = cp.execSync(cmd, {
                encoding: 'utf-8',
                timeout: 10000
            });

            const data = JSON.parse(result);
            const value = data.Parameter?.Value || '(empty)';
            
            const action = await vscode.window.showInformationMessage(
                `Value: ${value.substring(0, 50)}${value.length > 50 ? '...' : ''}`,
                'Copy to Clipboard'
            );

            if (action === 'Copy to Clipboard') {
                await vscode.env.clipboard.writeText(value);
                vscode.window.showInformationMessage('Value copied to clipboard');
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to get parameter value: ${e.message}`);
        }
    }

    private async syncToAmplify(items: string[], appId: string, branch: string): Promise<SyncResult> {
        const result: SyncResult = { synced: [], skipped: [], errors: [] };

        if (!appId || !branch) {
            vscode.window.showErrorMessage('Please select an Amplify app and branch first');
            return result;
        }

        const envVars: Record<string, string> = {};
        
        // Build env vars object from selected items
        for (const itemName of items) {
            // Check SSM parameters
            const ssmParam = this._ssmParameters.find(p => p.name === itemName);
            if (ssmParam && ssmParam.value) {
                // Convert SSM path to env var name: /amplify/prod/API_KEY -> API_KEY
                const envName = itemName.split('/').pop() || itemName;
                envVars[envName] = ssmParam.value;
                result.synced.push(envName);
                continue;
            }

            // Check Secrets Manager
            const secret = this._secrets.find(s => s.name === itemName);
            if (secret) {
                try {
                    const profileArg = this._awsProfile ? `--profile ${this._awsProfile}` : '';
                    const cmd = `aws secretsmanager get-secret-value --secret-id "${secret.arn}" --region ${this._awsRegion} ${profileArg} --output json`;
                    const secretResult = cp.execSync(cmd, { encoding: 'utf-8', timeout: 10000 });
                    const secretData = JSON.parse(secretResult);
                    
                    // Handle JSON secrets (key-value pairs)
                    try {
                        const secretValues = JSON.parse(secretData.SecretString);
                        for (const [key, value] of Object.entries(secretValues)) {
                            envVars[key] = String(value);
                            result.synced.push(key);
                        }
                    } catch {
                        // Plain string secret
                        const envName = itemName.split('/').pop() || itemName;
                        envVars[envName] = secretData.SecretString;
                        result.synced.push(envName);
                    }
                } catch (e: any) {
                    result.errors.push(`${itemName}: ${e.message}`);
                }
            }
        }

        // Update Amplify branch with new env vars
        if (Object.keys(envVars).length > 0) {
            try {
                // Merge with existing env vars
                const existingVars = Object.fromEntries(this._amplifyEnvVars);
                const mergedVars = { ...existingVars, ...envVars };
                const envVarsJson = JSON.stringify(mergedVars).replace(/"/g, '\\"');
                
                const profileArg = this._awsProfile ? `--profile ${this._awsProfile}` : '';
                const cmd = `aws amplify update-branch --app-id ${appId} --branch-name ${branch} --environment-variables "${envVarsJson}" --region ${this._awsRegion} ${profileArg}`;
                
                cp.execSync(cmd, { encoding: 'utf-8', timeout: 30000 });
                
                vscode.window.showInformationMessage(`Synced ${result.synced.length} variable(s) to Amplify`);
            } catch (e: any) {
                vscode.window.showErrorMessage(`Failed to update Amplify: ${e.message}`);
                result.errors.push(e.message);
            }
        }

        await this.refresh();
        return result;
    }

    private async syncFromAmplify(items: string[], prefix: string): Promise<SyncResult> {
        const result: SyncResult = { synced: [], skipped: [], errors: [] };

        if (this._amplifyEnvVars.size === 0) {
            vscode.window.showWarningMessage('No Amplify environment variables to sync');
            return result;
        }

        const ssmPrefix = prefix || '/amplify/';
        
        for (const [name, value] of this._amplifyEnvVars.entries()) {
            if (items.length > 0 && !items.includes(name)) {
                result.skipped.push(name);
                continue;
            }

            try {
                const paramName = `${ssmPrefix}${name}`;
                const profileArg = this._awsProfile ? `--profile ${this._awsProfile}` : '';
                const cmd = `aws ssm put-parameter --name "${paramName}" --value "${value}" --type SecureString --overwrite --region ${this._awsRegion} ${profileArg}`;
                
                cp.execSync(cmd, { encoding: 'utf-8', timeout: 10000 });
                result.synced.push(name);
            } catch (e: any) {
                result.errors.push(`${name}: ${e.message}`);
            }
        }

        if (result.synced.length > 0) {
            vscode.window.showInformationMessage(`Synced ${result.synced.length} variable(s) to SSM Parameter Store`);
        }

        await this.refresh();
        return result;
    }

    private async createEnvExample(items: string[]) {
        const envExamplePath = path.join(this._workspaceRoot, '.env.example');
        
        let content = '# Environment variables required for this project\n';
        content += '# Copy to .env.local and fill in values\n\n';

        // Add SSM parameters
        for (const param of this._ssmParameters) {
            if (items.length > 0 && !items.includes(param.name)) continue;
            const envName = param.name.split('/').pop() || param.name;
            content += `${envName}=\n`;
        }

        // Add Amplify env vars
        for (const [name] of this._amplifyEnvVars.entries()) {
            if (items.length > 0 && !items.includes(name)) continue;
            if (!content.includes(`${name}=`)) {
                content += `${name}=\n`;
            }
        }

        fs.writeFileSync(envExamplePath, content);
        
        const doc = await vscode.workspace.openTextDocument(envExamplePath);
        await vscode.window.showTextDocument(doc);
        
        vscode.window.showInformationMessage('Created .env.example file');
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
        <p>Fetching secrets from AWS...</p>
    </div>
</body>
</html>`;
    }

    private _getResultsHtml(): string {
        const regions = ['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'eu-west-1', 'eu-west-2', 'eu-central-1', 'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1'];

        return `<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); max-width: 1000px; margin: 0 auto; }
        h1 { display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--vscode-input-border); padding-bottom: 15px; }
        h2 { display: flex; align-items: center; gap: 8px; font-size: 16px; margin-top: 25px; }
        
        .controls { display: flex; gap: 10px; margin: 15px 0; flex-wrap: wrap; align-items: center; }
        select, input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 8px 12px; border-radius: 4px; font-size: 13px; }
        select { min-width: 150px; }
        input { flex: 1; min-width: 200px; }
        
        button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 13px; display: flex; align-items: center; gap: 6px; }
        button:hover { background: var(--vscode-button-hoverBackground); }
        button.secondary { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); }
        button:disabled { opacity: 0.5; cursor: not-allowed; }
        
        .section { background: var(--vscode-input-background); border-radius: 8px; padding: 15px; margin: 15px 0; }
        .section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .section-title { font-weight: 600; display: flex; align-items: center; gap: 8px; }
        .badge { padding: 2px 8px; border-radius: 10px; font-size: 11px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
        
        .item-list { max-height: 300px; overflow-y: auto; }
        .item { display: flex; align-items: center; padding: 8px; border-radius: 4px; margin: 4px 0; background: rgba(0,0,0,0.1); }
        .item:hover { background: rgba(0,0,0,0.2); }
        .item input[type="checkbox"] { margin-right: 10px; }
        .item-name { font-family: monospace; font-size: 12px; flex: 1; word-break: break-all; }
        .item-type { font-size: 10px; padding: 2px 6px; border-radius: 3px; margin-left: 8px; }
        .item-type.secure { background: rgba(244,67,54,0.2); color: #f44336; }
        .item-type.string { background: rgba(33,150,243,0.2); color: #2196f3; }
        .item-actions { display: flex; gap: 5px; margin-left: 10px; }
        .item-actions button { padding: 4px 8px; font-size: 11px; }
        
        .empty { text-align: center; padding: 30px; opacity: 0.6; }
        .empty-icon { font-size: 32px; margin-bottom: 10px; }
        
        .sync-actions { display: flex; gap: 10px; margin-top: 20px; padding-top: 20px; border-top: 1px solid var(--vscode-input-border); justify-content: center; flex-wrap: wrap; }
        .sync-actions button { padding: 10px 20px; }
        
        .info-box { background: rgba(33,150,243,0.1); border: 1px solid rgba(33,150,243,0.3); border-radius: 8px; padding: 15px; margin: 15px 0; }
        .info-box h3 { margin: 0 0 10px 0; font-size: 14px; color: #2196f3; }
        .info-box p { margin: 5px 0; font-size: 13px; opacity: 0.9; }
        
        .amplify-target { background: rgba(255,152,0,0.1); border: 1px solid rgba(255,152,0,0.3); border-radius: 8px; padding: 15px; margin: 15px 0; }
        .amplify-target h3 { margin: 0 0 10px 0; font-size: 14px; color: #ff9800; display: flex; align-items: center; gap: 8px; }
    </style>
</head>
<body>
    <h1>🔐 Secrets Manager Integration</h1>
    
    <div class="controls">
        <select id="region" onchange="setRegion(this.value)">
            ${regions.map(r => `<option value="${r}" ${r === this._awsRegion ? 'selected' : ''}>${r}</option>`).join('')}
        </select>
        <input type="text" id="ssmPrefix" placeholder="SSM prefix (e.g., /amplify/prod/)" value="/amplify/">
        <button onclick="fetchSSM()">🔍 Search SSM</button>
        <button class="secondary" onclick="refresh()">🔄 Refresh</button>
    </div>
    
    ${this._selectedAppId && this._selectedBranch ? `
    <div class="amplify-target">
        <h3>🎯 Target: ${this._selectedAppId} / ${this._selectedBranch}</h3>
        <p>Selected secrets will be synced to this Amplify branch's environment variables.</p>
    </div>
    ` : `
    <div class="info-box">
        <h3>💡 Tip: Select an Amplify app first</h3>
        <p>To sync secrets to Amplify, select an app and branch from the Apps panel first, then open this view.</p>
    </div>
    `}
    
    <!-- SSM Parameters Section -->
    <div class="section">
        <div class="section-header">
            <div class="section-title">
                📋 SSM Parameter Store
                <span class="badge">${this._ssmParameters.length}</span>
            </div>
            <button class="secondary" onclick="selectAllSSM()">Select All</button>
        </div>
        
        ${this._ssmParameters.length > 0 ? `
        <div class="item-list">
            ${this._ssmParameters.map(p => `
                <div class="item">
                    <input type="checkbox" class="ssm-checkbox" value="${this.escapeHtml(p.name)}">
                    <span class="item-name">${this.escapeHtml(p.name)}</span>
                    <span class="item-type ${p.type === 'SecureString' ? 'secure' : 'string'}">${p.type}</span>
                    <div class="item-actions">
                        <button onclick="revealValue('${this.escapeHtml(p.name)}')">👁</button>
                    </div>
                </div>
            `).join('')}
        </div>
        ` : `
        <div class="empty">
            <div class="empty-icon">📭</div>
            <p>No SSM parameters found with prefix "/amplify/"</p>
            <p style="font-size: 12px;">Try searching with a different prefix</p>
        </div>
        `}
    </div>
    
    <!-- Secrets Manager Section -->
    <div class="section">
        <div class="section-header">
            <div class="section-title">
                🔒 Secrets Manager
                <span class="badge">${this._secrets.length}</span>
            </div>
            <button class="secondary" onclick="selectAllSecrets()">Select All</button>
        </div>
        
        ${this._secrets.length > 0 ? `
        <div class="item-list">
            ${this._secrets.map(s => `
                <div class="item">
                    <input type="checkbox" class="secret-checkbox" value="${this.escapeHtml(s.name)}">
                    <span class="item-name">${this.escapeHtml(s.name)}</span>
                    <span class="item-type secure">Secret</span>
                </div>
            `).join('')}
        </div>
        ` : `
        <div class="empty">
            <div class="empty-icon">🔐</div>
            <p>No secrets found matching "amplify"</p>
        </div>
        `}
    </div>
    
    <!-- Current Amplify Env Vars -->
    <div class="section">
        <div class="section-header">
            <div class="section-title">
                ⚡ Current Amplify Env Vars
                <span class="badge">${this._amplifyEnvVars.size}</span>
            </div>
            <button class="secondary" onclick="selectAllAmplify()">Select All</button>
        </div>
        
        ${this._amplifyEnvVars.size > 0 ? `
        <div class="item-list">
            ${Array.from(this._amplifyEnvVars.entries()).map(([name, value]) => `
                <div class="item">
                    <input type="checkbox" class="amplify-checkbox" value="${this.escapeHtml(name)}">
                    <span class="item-name">${this.escapeHtml(name)}</span>
                    <span class="item-type string">${value.length > 20 ? value.substring(0, 20) + '...' : '•'.repeat(Math.min(value.length, 10))}</span>
                </div>
            `).join('')}
        </div>
        ` : `
        <div class="empty">
            <div class="empty-icon">📭</div>
            <p>${this._selectedAppId ? 'No environment variables set' : 'Select an app to view env vars'}</p>
        </div>
        `}
    </div>
    
    <!-- Sync Actions -->
    <div class="sync-actions">
        <button onclick="syncToAmplify()" ${!this._selectedAppId ? 'disabled' : ''}>
            ⬆️ Sync Selected → Amplify
        </button>
        <button onclick="syncFromAmplify()" ${this._amplifyEnvVars.size === 0 ? 'disabled' : ''}>
            ⬇️ Backup Amplify → SSM
        </button>
        <button class="secondary" onclick="createEnvExample()">
            📝 Create .env.example
        </button>
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        
        function setRegion(region) {
            vscode.postMessage({ command: 'setRegion', region });
        }
        
        function fetchSSM() {
            const prefix = document.getElementById('ssmPrefix').value || '/';
            vscode.postMessage({ command: 'fetchSSM', prefix });
        }
        
        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }
        
        function revealValue(name) {
            vscode.postMessage({ command: 'revealValue', name });
        }
        
        function getSelectedItems(className) {
            return Array.from(document.querySelectorAll('.' + className + ':checked'))
                .map(cb => cb.value);
        }
        
        function selectAllSSM() {
            document.querySelectorAll('.ssm-checkbox').forEach(cb => cb.checked = true);
        }
        
        function selectAllSecrets() {
            document.querySelectorAll('.secret-checkbox').forEach(cb => cb.checked = true);
        }
        
        function selectAllAmplify() {
            document.querySelectorAll('.amplify-checkbox').forEach(cb => cb.checked = true);
        }
        
        function syncToAmplify() {
            const ssmItems = getSelectedItems('ssm-checkbox');
            const secretItems = getSelectedItems('secret-checkbox');
            const items = [...ssmItems, ...secretItems];
            
            if (items.length === 0) {
                alert('Please select at least one parameter or secret to sync');
                return;
            }
            
            vscode.postMessage({ 
                command: 'syncToAmplify', 
                items,
                appId: '${this._selectedAppId || ''}',
                branch: '${this._selectedBranch || ''}'
            });
        }
        
        function syncFromAmplify() {
            const items = getSelectedItems('amplify-checkbox');
            const prefix = document.getElementById('ssmPrefix').value || '/amplify/';
            
            vscode.postMessage({ 
                command: 'syncFromAmplify', 
                items,
                prefix
            });
        }
        
        function createEnvExample() {
            const ssmItems = getSelectedItems('ssm-checkbox');
            const amplifyItems = getSelectedItems('amplify-checkbox');
            const items = [...ssmItems, ...amplifyItems];
            
            vscode.postMessage({ command: 'createEnvExample', items });
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
        SecretsManagerPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) x.dispose();
        }
    }
}
