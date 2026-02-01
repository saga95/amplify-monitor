import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';

interface AwsProfile {
    name: string;
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    roleArn?: string;
    sourceProfile?: string;
    mfaSerial?: string;
    ssoStartUrl?: string;
    ssoRegion?: string;
    ssoAccountId?: string;
    ssoRoleName?: string;
    isDefault: boolean;
    isActive: boolean;
    isValid?: boolean;
    accountId?: string;
    userName?: string;
    lastValidated?: string;
}

interface ProfileValidation {
    valid: boolean;
    accountId?: string;
    userName?: string;
    arn?: string;
    error?: string;
}

export class AwsProfileManagerPanel {
    public static currentPanel: AwsProfileManagerPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _profiles: AwsProfile[] = [];
    private _validationCache: Map<string, ProfileValidation> = new Map();

    public static createOrShow(extensionUri: vscode.Uri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (AwsProfileManagerPanel.currentPanel) {
            AwsProfileManagerPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'awsProfileManager',
            'AWS Profile Manager',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        AwsProfileManagerPanel.currentPanel = new AwsProfileManagerPanel(panel, extensionUri);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        this._update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'loadProfiles':
                        await this._loadProfiles();
                        break;
                    case 'switchProfile':
                        await this._switchProfile(message.profileName);
                        break;
                    case 'validateProfile':
                        await this._validateProfile(message.profileName);
                        break;
                    case 'validateAll':
                        await this._validateAllProfiles();
                        break;
                    case 'openCredentialsFile':
                        await this._openCredentialsFile();
                        break;
                    case 'openConfigFile':
                        await this._openConfigFile();
                        break;
                    case 'addProfile':
                        await this._addProfile(message.profile);
                        break;
                    case 'deleteProfile':
                        await this._deleteProfile(message.profileName);
                        break;
                    case 'copyProfileName':
                        await vscode.env.clipboard.writeText(message.profileName);
                        vscode.window.showInformationMessage(`Copied "${message.profileName}" to clipboard`);
                        break;
                    case 'openAwsConsole':
                        this._openAwsConsole(message.profileName);
                        break;
                    case 'runAwsConfigure':
                        await this._runAwsConfigure(message.profileName);
                        break;
                    case 'refresh':
                        this._validationCache.clear();
                        await this._loadProfiles();
                        break;
                }
            },
            null,
            this._disposables
        );

        // Initial load
        this._loadProfiles();
    }

    public dispose() {
        AwsProfileManagerPanel.currentPanel = undefined;
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
    }

    private _getAwsConfigPath(): string {
        return process.env.AWS_CONFIG_FILE || path.join(os.homedir(), '.aws', 'config');
    }

    private _getAwsCredentialsPath(): string {
        return process.env.AWS_SHARED_CREDENTIALS_FILE || path.join(os.homedir(), '.aws', 'credentials');
    }

    private async _loadProfiles() {
        this._panel.webview.postMessage({ command: 'loading' });

        try {
            const profiles: AwsProfile[] = [];
            const configPath = this._getAwsConfigPath();
            const credentialsPath = this._getAwsCredentialsPath();

            // Get current active profile from settings
            const currentProfile = vscode.workspace.getConfiguration('amplifyMonitor').get<string>('awsProfile') || 
                                   process.env.AWS_PROFILE || 
                                   'default';

            // Parse credentials file
            const credentialsProfiles = await this._parseIniFile(credentialsPath, false);
            
            // Parse config file
            const configProfiles = await this._parseIniFile(configPath, true);

            // Merge profiles
            const allProfileNames = new Set([
                ...Object.keys(credentialsProfiles),
                ...Object.keys(configProfiles)
            ]);

            for (const name of allProfileNames) {
                const credProfile = credentialsProfiles[name] || {};
                const confProfile = configProfiles[name] || {};
                
                const profile: AwsProfile = {
                    name,
                    region: confProfile.region || credProfile.region,
                    accessKeyId: credProfile.aws_access_key_id,
                    secretAccessKey: credProfile.aws_secret_access_key ? '••••••••' : undefined,
                    sessionToken: credProfile.aws_session_token ? '••••••••' : undefined,
                    roleArn: confProfile.role_arn,
                    sourceProfile: confProfile.source_profile,
                    mfaSerial: confProfile.mfa_serial,
                    ssoStartUrl: confProfile.sso_start_url,
                    ssoRegion: confProfile.sso_region,
                    ssoAccountId: confProfile.sso_account_id,
                    ssoRoleName: confProfile.sso_role_name,
                    isDefault: name === 'default',
                    isActive: name === currentProfile
                };

                // Check validation cache
                const cached = this._validationCache.get(name);
                if (cached) {
                    profile.isValid = cached.valid;
                    profile.accountId = cached.accountId;
                    profile.userName = cached.userName;
                    profile.lastValidated = new Date().toISOString();
                }

                profiles.push(profile);
            }

            // Sort: active first, then default, then alphabetically
            profiles.sort((a, b) => {
                if (a.isActive && !b.isActive) return -1;
                if (!a.isActive && b.isActive) return 1;
                if (a.isDefault && !b.isDefault) return -1;
                if (!a.isDefault && b.isDefault) return 1;
                return a.name.localeCompare(b.name);
            });

            this._profiles = profiles;

            this._panel.webview.postMessage({
                command: 'profilesLoaded',
                profiles,
                currentProfile,
                configPath,
                credentialsPath
            });
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'error',
                error: `Failed to load profiles: ${error}`
            });
        }
    }

    private async _parseIniFile(filePath: string, isConfig: boolean): Promise<Record<string, Record<string, string>>> {
        const profiles: Record<string, Record<string, string>> = {};

        try {
            if (!fs.existsSync(filePath)) {
                return profiles;
            }

            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');
            
            let currentProfile: string | null = null;

            for (const line of lines) {
                const trimmed = line.trim();
                
                // Skip empty lines and comments
                if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) {
                    continue;
                }

                // Check for section header
                const sectionMatch = trimmed.match(/^\[(.+)\]$/);
                if (sectionMatch) {
                    let profileName = sectionMatch[1];
                    
                    // Config file uses "profile xxx" format except for default
                    if (isConfig && profileName.startsWith('profile ')) {
                        profileName = profileName.substring(8);
                    }
                    
                    currentProfile = profileName;
                    if (!profiles[currentProfile]) {
                        profiles[currentProfile] = {};
                    }
                    continue;
                }

                // Parse key-value pairs
                if (currentProfile) {
                    const kvMatch = trimmed.match(/^([^=]+)\s*=\s*(.*)$/);
                    if (kvMatch) {
                        const key = kvMatch[1].trim();
                        const value = kvMatch[2].trim();
                        profiles[currentProfile][key] = value;
                    }
                }
            }
        } catch (error) {
            console.error(`Error parsing ${filePath}:`, error);
        }

        return profiles;
    }

    private async _switchProfile(profileName: string) {
        try {
            // Update VS Code settings
            await vscode.workspace.getConfiguration('amplifyMonitor').update(
                'awsProfile',
                profileName,
                vscode.ConfigurationTarget.Global
            );

            vscode.window.showInformationMessage(`Switched to AWS profile: ${profileName}`);
            
            // Reload profiles to update UI
            await this._loadProfiles();

            // Trigger refresh of other views
            vscode.commands.executeCommand('amplify-monitor.refreshApps');
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to switch profile: ${error}`);
        }
    }

    private async _validateProfile(profileName: string): Promise<ProfileValidation> {
        this._panel.webview.postMessage({ 
            command: 'validating', 
            profileName 
        });

        return new Promise((resolve) => {
            const args = ['sts', 'get-caller-identity', '--output', 'json'];
            if (profileName !== 'default') {
                args.push('--profile', profileName);
            }

            const aws = spawn('aws', args, {
                shell: true,
                env: { ...process.env }
            });

            let stdout = '';
            let stderr = '';

            aws.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            aws.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            aws.on('close', (code) => {
                let validation: ProfileValidation;

                if (code === 0) {
                    try {
                        const result = JSON.parse(stdout);
                        validation = {
                            valid: true,
                            accountId: result.Account,
                            userName: result.Arn?.split('/').pop() || result.UserId,
                            arn: result.Arn
                        };
                    } catch {
                        validation = { valid: true };
                    }
                } else {
                    validation = {
                        valid: false,
                        error: stderr.trim() || 'Credentials validation failed'
                    };
                }

                this._validationCache.set(profileName, validation);

                this._panel.webview.postMessage({
                    command: 'validated',
                    profileName,
                    validation
                });

                resolve(validation);
            });

            aws.on('error', (error) => {
                const validation: ProfileValidation = {
                    valid: false,
                    error: `AWS CLI not found or error: ${error.message}`
                };
                
                this._validationCache.set(profileName, validation);
                
                this._panel.webview.postMessage({
                    command: 'validated',
                    profileName,
                    validation
                });

                resolve(validation);
            });

            // Timeout after 30 seconds
            setTimeout(() => {
                aws.kill();
                const validation: ProfileValidation = {
                    valid: false,
                    error: 'Validation timed out'
                };
                
                this._panel.webview.postMessage({
                    command: 'validated',
                    profileName,
                    validation
                });

                resolve(validation);
            }, 30000);
        });
    }

    private async _validateAllProfiles() {
        for (const profile of this._profiles) {
            await this._validateProfile(profile.name);
        }
    }

    private async _openCredentialsFile() {
        const credentialsPath = this._getAwsCredentialsPath();
        
        // Create file if it doesn't exist
        if (!fs.existsSync(credentialsPath)) {
            const dir = path.dirname(credentialsPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(credentialsPath, '[default]\naws_access_key_id = \naws_secret_access_key = \n');
        }

        const doc = await vscode.workspace.openTextDocument(credentialsPath);
        await vscode.window.showTextDocument(doc);
    }

    private async _openConfigFile() {
        const configPath = this._getAwsConfigPath();
        
        // Create file if it doesn't exist
        if (!fs.existsSync(configPath)) {
            const dir = path.dirname(configPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(configPath, '[default]\nregion = us-east-1\n');
        }

        const doc = await vscode.workspace.openTextDocument(configPath);
        await vscode.window.showTextDocument(doc);
    }

    private async _addProfile(profile: { name: string; accessKeyId: string; secretAccessKey: string; region: string }) {
        try {
            const credentialsPath = this._getAwsCredentialsPath();
            const configPath = this._getAwsConfigPath();

            // Ensure directories exist
            const awsDir = path.dirname(credentialsPath);
            if (!fs.existsSync(awsDir)) {
                fs.mkdirSync(awsDir, { recursive: true });
            }

            // Add to credentials file
            let credContent = '';
            if (fs.existsSync(credentialsPath)) {
                credContent = fs.readFileSync(credentialsPath, 'utf-8');
                if (!credContent.endsWith('\n')) {
                    credContent += '\n';
                }
            }

            credContent += `\n[${profile.name}]\n`;
            credContent += `aws_access_key_id = ${profile.accessKeyId}\n`;
            credContent += `aws_secret_access_key = ${profile.secretAccessKey}\n`;

            fs.writeFileSync(credentialsPath, credContent);

            // Add to config file
            let configContent = '';
            if (fs.existsSync(configPath)) {
                configContent = fs.readFileSync(configPath, 'utf-8');
                if (!configContent.endsWith('\n')) {
                    configContent += '\n';
                }
            }

            const profileSection = profile.name === 'default' ? '[default]' : `[profile ${profile.name}]`;
            configContent += `\n${profileSection}\n`;
            configContent += `region = ${profile.region}\n`;

            fs.writeFileSync(configPath, configContent);

            vscode.window.showInformationMessage(`Profile "${profile.name}" added successfully`);
            
            // Reload profiles
            await this._loadProfiles();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to add profile: ${error}`);
        }
    }

    private async _deleteProfile(profileName: string) {
        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to delete the profile "${profileName}"? This cannot be undone.`,
            { modal: true },
            'Delete'
        );

        if (confirm !== 'Delete') {
            return;
        }

        try {
            const credentialsPath = this._getAwsCredentialsPath();
            const configPath = this._getAwsConfigPath();

            // Remove from credentials file
            await this._removeProfileFromFile(credentialsPath, profileName, false);
            
            // Remove from config file
            await this._removeProfileFromFile(configPath, profileName, true);

            vscode.window.showInformationMessage(`Profile "${profileName}" deleted`);
            
            // If this was the active profile, switch to default
            const currentProfile = vscode.workspace.getConfiguration('amplifyMonitor').get<string>('awsProfile');
            if (currentProfile === profileName) {
                await this._switchProfile('default');
            }

            await this._loadProfiles();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to delete profile: ${error}`);
        }
    }

    private async _removeProfileFromFile(filePath: string, profileName: string, isConfig: boolean) {
        if (!fs.existsSync(filePath)) {
            return;
        }

        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const newLines: string[] = [];
        
        let inTargetProfile = false;
        const targetSection = isConfig && profileName !== 'default' 
            ? `[profile ${profileName}]` 
            : `[${profileName}]`;

        for (const line of lines) {
            const trimmed = line.trim();
            
            if (trimmed.startsWith('[')) {
                inTargetProfile = trimmed === targetSection;
            }

            if (!inTargetProfile) {
                newLines.push(line);
            }
        }

        // Clean up extra blank lines
        const cleanedContent = newLines.join('\n').replace(/\n{3,}/g, '\n\n');
        fs.writeFileSync(filePath, cleanedContent);
    }

    private _openAwsConsole(profileName: string) {
        // Open AWS Console - user will need to sign in with appropriate credentials
        const profile = this._profiles.find(p => p.name === profileName);
        const region = profile?.region || 'us-east-1';
        
        vscode.env.openExternal(vscode.Uri.parse(
            `https://${region}.console.aws.amazon.com/amplify/home?region=${region}`
        ));
    }

    private async _runAwsConfigure(profileName: string) {
        const terminal = vscode.window.createTerminal('AWS Configure');
        terminal.show();
        
        if (profileName && profileName !== 'default') {
            terminal.sendText(`aws configure --profile ${profileName}`);
        } else {
            terminal.sendText('aws configure');
        }
    }

    private _getHtmlContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AWS Profile Manager</title>
    <style>
        :root {
            --bg-color: var(--vscode-editor-background);
            --text-color: var(--vscode-editor-foreground);
            --border-color: var(--vscode-panel-border);
            --card-bg: var(--vscode-editorWidget-background);
            --input-bg: var(--vscode-input-background);
            --input-fg: var(--vscode-input-foreground);
            --btn-bg: var(--vscode-button-background);
            --btn-fg: var(--vscode-button-foreground);
            --success: #4caf50;
            --warning: #ff9800;
            --error: #f44336;
            --info: #2196f3;
            --active: #ff9900;
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
        
        .toolbar {
            display: flex;
            gap: 8px;
            margin-bottom: 24px;
            flex-wrap: wrap;
        }
        
        button {
            background: var(--btn-bg);
            color: var(--btn-fg);
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            display: inline-flex;
            align-items: center;
            gap: 6px;
        }
        
        button:hover { opacity: 0.9; }
        button:disabled { opacity: 0.5; cursor: not-allowed; }
        
        button.secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        
        button.small {
            padding: 4px 8px;
            font-size: 11px;
        }
        
        .profiles-grid {
            display: grid;
            gap: 16px;
        }
        
        .profile-card {
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 16px;
            position: relative;
        }
        
        .profile-card.active {
            border-color: var(--active);
            border-width: 2px;
        }
        
        .profile-card.active::before {
            content: '✓ ACTIVE';
            position: absolute;
            top: -10px;
            right: 16px;
            background: var(--active);
            color: #000;
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 10px;
            font-weight: bold;
        }
        
        .profile-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 12px;
        }
        
        .profile-name {
            font-size: 16px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .profile-badges {
            display: flex;
            gap: 6px;
        }
        
        .badge {
            padding: 2px 8px;
            border-radius: 10px;
            font-size: 10px;
            font-weight: 500;
        }
        
        .badge.default { background: var(--info); color: white; }
        .badge.sso { background: #9c27b0; color: white; }
        .badge.role { background: #673ab7; color: white; }
        .badge.valid { background: var(--success); color: white; }
        .badge.invalid { background: var(--error); color: white; }
        .badge.unknown { background: var(--border-color); color: var(--text-color); }
        
        .profile-details {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 8px;
            margin-bottom: 12px;
            font-size: 12px;
        }
        
        .detail {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }
        
        .detail-label {
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
        }
        
        .detail-value {
            font-family: var(--vscode-editor-font-family);
        }
        
        .detail-value.masked {
            color: var(--vscode-descriptionForeground);
        }
        
        .profile-actions {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
            padding-top: 12px;
            border-top: 1px solid var(--border-color);
        }
        
        .validation-status {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 12px;
            margin-top: 8px;
        }
        
        .validation-status.valid { color: var(--success); }
        .validation-status.invalid { color: var(--error); }
        .validation-status.validating { color: var(--info); }
        
        .modal-overlay {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0,0,0,0.5);
            z-index: 100;
            align-items: center;
            justify-content: center;
        }
        
        .modal-overlay.show { display: flex; }
        
        .modal {
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 24px;
            min-width: 400px;
            max-width: 500px;
        }
        
        .modal h2 {
            margin: 0 0 20px 0;
        }
        
        .form-group {
            margin-bottom: 16px;
        }
        
        .form-group label {
            display: block;
            margin-bottom: 6px;
            font-size: 13px;
        }
        
        .form-group input, .form-group select {
            width: 100%;
            padding: 8px 12px;
            border: 1px solid var(--border-color);
            border-radius: 4px;
            background: var(--input-bg);
            color: var(--input-fg);
            font-size: 13px;
        }
        
        .form-group input:focus, .form-group select:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
        }
        
        .form-hint {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
        }
        
        .modal-actions {
            display: flex;
            gap: 8px;
            justify-content: flex-end;
            margin-top: 20px;
        }
        
        .file-paths {
            background: var(--input-bg);
            border-radius: 4px;
            padding: 12px;
            margin-bottom: 24px;
            font-size: 12px;
        }
        
        .file-path {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }
        
        .file-path:last-child { margin-bottom: 0; }
        
        .file-path-label {
            color: var(--vscode-descriptionForeground);
        }
        
        .file-path-value {
            font-family: var(--vscode-editor-font-family);
            font-size: 11px;
        }
        
        .loading {
            text-align: center;
            padding: 40px;
            color: var(--vscode-descriptionForeground);
        }
        
        .spinner {
            display: inline-block;
            width: 20px;
            height: 20px;
            border: 2px solid var(--border-color);
            border-top-color: var(--vscode-focusBorder);
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        
        @keyframes spin { to { transform: rotate(360deg); } }
        
        .empty-state {
            text-align: center;
            padding: 60px 20px;
            color: var(--vscode-descriptionForeground);
        }
        
        .empty-state-icon { font-size: 48px; margin-bottom: 16px; }
    </style>
</head>
<body>
    <h1>👥 AWS Profile Manager</h1>
    <p class="subtitle">Manage and switch between AWS profiles for multi-account access</p>
    
    <div class="toolbar">
        <button onclick="showAddModal()">➕ Add Profile</button>
        <button class="secondary" onclick="validateAll()">✓ Validate All</button>
        <button class="secondary" onclick="openCredentials()">📄 Edit Credentials</button>
        <button class="secondary" onclick="openConfig()">⚙️ Edit Config</button>
        <button class="secondary" onclick="refresh()">🔄 Refresh</button>
    </div>
    
    <div id="file-paths" class="file-paths" style="display: none;">
        <div class="file-path">
            <span class="file-path-label">Credentials:</span>
            <span class="file-path-value" id="credentials-path"></span>
        </div>
        <div class="file-path">
            <span class="file-path-label">Config:</span>
            <span class="file-path-value" id="config-path"></span>
        </div>
    </div>
    
    <div id="content">
        <div class="loading">
            <div class="spinner"></div>
            <p>Loading profiles...</p>
        </div>
    </div>
    
    <!-- Add Profile Modal -->
    <div class="modal-overlay" id="add-modal">
        <div class="modal">
            <h2>➕ Add New Profile</h2>
            <form id="add-form">
                <div class="form-group">
                    <label>Profile Name</label>
                    <input type="text" id="profile-name" placeholder="my-profile" required>
                    <div class="form-hint">Alphanumeric and hyphens only</div>
                </div>
                <div class="form-group">
                    <label>Access Key ID</label>
                    <input type="text" id="access-key" placeholder="AKIA..." required>
                </div>
                <div class="form-group">
                    <label>Secret Access Key</label>
                    <input type="password" id="secret-key" placeholder="••••••••" required>
                </div>
                <div class="form-group">
                    <label>Default Region</label>
                    <select id="region">
                        <option value="us-east-1">US East (N. Virginia)</option>
                        <option value="us-east-2">US East (Ohio)</option>
                        <option value="us-west-1">US West (N. California)</option>
                        <option value="us-west-2">US West (Oregon)</option>
                        <option value="eu-west-1">EU (Ireland)</option>
                        <option value="eu-west-2">EU (London)</option>
                        <option value="eu-central-1">EU (Frankfurt)</option>
                        <option value="ap-northeast-1">Asia Pacific (Tokyo)</option>
                        <option value="ap-southeast-1">Asia Pacific (Singapore)</option>
                        <option value="ap-southeast-2">Asia Pacific (Sydney)</option>
                        <option value="ap-south-1">Asia Pacific (Mumbai)</option>
                        <option value="sa-east-1">South America (São Paulo)</option>
                    </select>
                </div>
                <div class="modal-actions">
                    <button type="button" class="secondary" onclick="hideAddModal()">Cancel</button>
                    <button type="submit">Add Profile</button>
                </div>
            </form>
        </div>
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        let profiles = [];
        
        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.command) {
                case 'loading':
                    document.getElementById('content').innerHTML = \`
                        <div class="loading">
                            <div class="spinner"></div>
                            <p>Loading profiles...</p>
                        </div>
                    \`;
                    break;
                    
                case 'profilesLoaded':
                    profiles = message.profiles;
                    document.getElementById('credentials-path').textContent = message.credentialsPath;
                    document.getElementById('config-path').textContent = message.configPath;
                    document.getElementById('file-paths').style.display = 'block';
                    renderProfiles();
                    break;
                    
                case 'validating':
                    const validatingEl = document.getElementById(\`status-\${message.profileName}\`);
                    if (validatingEl) {
                        validatingEl.className = 'validation-status validating';
                        validatingEl.innerHTML = '<span class="spinner"></span> Validating...';
                    }
                    break;
                    
                case 'validated':
                    const profile = profiles.find(p => p.name === message.profileName);
                    if (profile) {
                        profile.isValid = message.validation.valid;
                        profile.accountId = message.validation.accountId;
                        profile.userName = message.validation.userName;
                        profile.validationError = message.validation.error;
                    }
                    renderProfiles();
                    break;
                    
                case 'error':
                    document.getElementById('content').innerHTML = \`
                        <div class="empty-state">
                            <div class="empty-state-icon">❌</div>
                            <p>\${message.error}</p>
                            <button onclick="refresh()">Try Again</button>
                        </div>
                    \`;
                    break;
            }
        });
        
        function renderProfiles() {
            if (profiles.length === 0) {
                document.getElementById('content').innerHTML = \`
                    <div class="empty-state">
                        <div class="empty-state-icon">👤</div>
                        <p>No AWS profiles found</p>
                        <p style="margin-top: 8px;">Add a profile to get started</p>
                        <button onclick="showAddModal()" style="margin-top: 16px;">➕ Add Profile</button>
                    </div>
                \`;
                return;
            }
            
            const html = profiles.map(p => \`
                <div class="profile-card \${p.isActive ? 'active' : ''}">
                    <div class="profile-header">
                        <div class="profile-name">
                            \${p.name}
                            <div class="profile-badges">
                                \${p.isDefault ? '<span class="badge default">DEFAULT</span>' : ''}
                                \${p.ssoStartUrl ? '<span class="badge sso">SSO</span>' : ''}
                                \${p.roleArn ? '<span class="badge role">ROLE</span>' : ''}
                                \${p.isValid === true ? '<span class="badge valid">✓ VALID</span>' : ''}
                                \${p.isValid === false ? '<span class="badge invalid">✗ INVALID</span>' : ''}
                                \${p.isValid === undefined ? '<span class="badge unknown">UNKNOWN</span>' : ''}
                            </div>
                        </div>
                    </div>
                    
                    <div class="profile-details">
                        \${p.region ? \`<div class="detail"><span class="detail-label">Region</span><span class="detail-value">\${p.region}</span></div>\` : ''}
                        \${p.accessKeyId ? \`<div class="detail"><span class="detail-label">Access Key</span><span class="detail-value">\${p.accessKeyId.substring(0, 8)}...</span></div>\` : ''}
                        \${p.accountId ? \`<div class="detail"><span class="detail-label">Account ID</span><span class="detail-value">\${p.accountId}</span></div>\` : ''}
                        \${p.userName ? \`<div class="detail"><span class="detail-label">User/Role</span><span class="detail-value">\${p.userName}</span></div>\` : ''}
                        \${p.roleArn ? \`<div class="detail"><span class="detail-label">Role ARN</span><span class="detail-value" style="font-size: 10px;">\${p.roleArn}</span></div>\` : ''}
                        \${p.sourceProfile ? \`<div class="detail"><span class="detail-label">Source Profile</span><span class="detail-value">\${p.sourceProfile}</span></div>\` : ''}
                        \${p.ssoStartUrl ? \`<div class="detail"><span class="detail-label">SSO URL</span><span class="detail-value" style="font-size: 10px;">\${p.ssoStartUrl}</span></div>\` : ''}
                    </div>
                    
                    \${p.validationError ? \`
                        <div class="validation-status invalid">
                            ❌ \${p.validationError}
                        </div>
                    \` : ''}
                    
                    <div id="status-\${p.name}"></div>
                    
                    <div class="profile-actions">
                        \${!p.isActive ? \`<button onclick="switchProfile('\${p.name}')">✓ Use This Profile</button>\` : '<button disabled>✓ Currently Active</button>'}
                        <button class="secondary small" onclick="validateProfile('\${p.name}')">🔍 Validate</button>
                        <button class="secondary small" onclick="copyName('\${p.name}')">📋 Copy Name</button>
                        <button class="secondary small" onclick="openConsole('\${p.name}')">🌐 Console</button>
                        <button class="secondary small" onclick="runConfigure('\${p.name}')">⚙️ Configure</button>
                        \${!p.isDefault ? \`<button class="secondary small" onclick="deleteProfile('\${p.name}')" style="color: var(--error);">🗑️ Delete</button>\` : ''}
                    </div>
                </div>
            \`).join('');
            
            document.getElementById('content').innerHTML = \`<div class="profiles-grid">\${html}</div>\`;
        }
        
        function switchProfile(name) {
            vscode.postMessage({ command: 'switchProfile', profileName: name });
        }
        
        function validateProfile(name) {
            vscode.postMessage({ command: 'validateProfile', profileName: name });
        }
        
        function validateAll() {
            vscode.postMessage({ command: 'validateAll' });
        }
        
        function copyName(name) {
            vscode.postMessage({ command: 'copyProfileName', profileName: name });
        }
        
        function openConsole(name) {
            vscode.postMessage({ command: 'openAwsConsole', profileName: name });
        }
        
        function runConfigure(name) {
            vscode.postMessage({ command: 'runAwsConfigure', profileName: name });
        }
        
        function deleteProfile(name) {
            vscode.postMessage({ command: 'deleteProfile', profileName: name });
        }
        
        function openCredentials() {
            vscode.postMessage({ command: 'openCredentialsFile' });
        }
        
        function openConfig() {
            vscode.postMessage({ command: 'openConfigFile' });
        }
        
        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }
        
        function showAddModal() {
            document.getElementById('add-modal').classList.add('show');
        }
        
        function hideAddModal() {
            document.getElementById('add-modal').classList.remove('show');
            document.getElementById('add-form').reset();
        }
        
        document.getElementById('add-form').addEventListener('submit', (e) => {
            e.preventDefault();
            
            const profile = {
                name: document.getElementById('profile-name').value.trim(),
                accessKeyId: document.getElementById('access-key').value.trim(),
                secretAccessKey: document.getElementById('secret-key').value.trim(),
                region: document.getElementById('region').value
            };
            
            vscode.postMessage({ command: 'addProfile', profile });
            hideAddModal();
        });
        
        // Initial load
        vscode.postMessage({ command: 'loadProfiles' });
    </script>
</body>
</html>`;
    }
}
