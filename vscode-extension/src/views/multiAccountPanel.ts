import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AmplifyMonitorCli, AmplifyApp } from '../cli';

interface ProfileData {
    name: string;
    apps: AmplifyApp[];
    loading: boolean;
    error?: string;
}

export class MultiAccountPanel {
    public static currentPanel: MultiAccountPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _cli: AmplifyMonitorCli;
    private _profileData: Map<string, ProfileData> = new Map();

    public static createOrShow(extensionUri: vscode.Uri, cli: AmplifyMonitorCli) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (MultiAccountPanel.currentPanel) {
            MultiAccountPanel.currentPanel._panel.reveal(column);
            MultiAccountPanel.currentPanel._refresh();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'amplifyMultiAccount',
            'Multi-Account View',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            }
        );

        MultiAccountPanel.currentPanel = new MultiAccountPanel(panel, extensionUri, cli);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, cli: AmplifyMonitorCli) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._cli = cli;

        this._refresh();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'refresh':
                        await this._refresh();
                        break;
                    case 'selectApp':
                        await this._selectApp(message.appId, message.region, message.profile);
                        break;
                    case 'selectProfile':
                        await this._selectProfile(message.profile);
                        break;
                    case 'loadProfile':
                        await this._loadProfileApps(message.profile);
                        break;
                    case 'openConsole':
                        vscode.env.openExternal(vscode.Uri.parse(message.url));
                        break;
                    case 'configureProfile':
                        vscode.commands.executeCommand('amplify-monitor.configureProfile');
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    public dispose() {
        MultiAccountPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) {
                d.dispose();
            }
        }
    }

    private async _refresh() {
        this._panel.webview.html = this._getLoadingHtml();

        const profiles = await this._getAvailableProfiles();
        this._profileData.clear();

        // Initialize all profiles with loading state
        for (const profile of profiles) {
            this._profileData.set(profile, {
                name: profile,
                apps: [],
                loading: true
            });
        }

        // Update UI immediately with loading state
        this._updatePanel();

        // Load apps for all profiles in parallel
        const loadPromises = profiles.map(async (profile) => {
            try {
                const apps = await this._cli.listAppsForProfile(profile, true);
                this._profileData.set(profile, {
                    name: profile,
                    apps,
                    loading: false
                });
            } catch (error) {
                this._profileData.set(profile, {
                    name: profile,
                    apps: [],
                    loading: false,
                    error: error instanceof Error ? error.message : 'Unknown error'
                });
            }
            // Update panel after each profile loads
            this._updatePanel();
        });

        await Promise.allSettled(loadPromises);
    }

    private async _loadProfileApps(profileName: string) {
        const existing = this._profileData.get(profileName);
        if (existing) {
            existing.loading = true;
            this._updatePanel();
        }

        try {
            const apps = await this._cli.listAppsForProfile(profileName, true);
            this._profileData.set(profileName, {
                name: profileName,
                apps,
                loading: false
            });
        } catch (error) {
            this._profileData.set(profileName, {
                name: profileName,
                apps: [],
                loading: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            });
        }

        this._updatePanel();
    }

    private async _selectApp(appId: string, region: string, profile: string) {
        // Switch to the profile
        const config = vscode.workspace.getConfiguration('amplifyMonitor');
        await config.update('awsProfile', profile, vscode.ConfigurationTarget.Global);
        
        // Set the selected app
        this._cli.setSelectedApp(appId, region);
        
        vscode.window.showInformationMessage(`Selected app in profile "${profile}": ${appId}`);
        
        // Refresh the main views
        vscode.commands.executeCommand('amplify-monitor.listApps');
    }

    private async _selectProfile(profile: string) {
        const config = vscode.workspace.getConfiguration('amplifyMonitor');
        await config.update('awsProfile', profile, vscode.ConfigurationTarget.Global);
        
        vscode.window.showInformationMessage(`Switched to AWS profile: ${profile}`);
        
        // Refresh main views
        vscode.commands.executeCommand('amplify-monitor.listApps');
    }

    private async _getAvailableProfiles(): Promise<string[]> {
        const profiles = new Set<string>();
        const credentialsPath = process.env.AWS_SHARED_CREDENTIALS_FILE || 
            path.join(os.homedir(), '.aws', 'credentials');
        const configPath = process.env.AWS_CONFIG_FILE || 
            path.join(os.homedir(), '.aws', 'config');

        // Parse credentials file
        if (fs.existsSync(credentialsPath)) {
            const content = fs.readFileSync(credentialsPath, 'utf-8');
            const matches = content.match(/\[([^\]]+)\]/g);
            if (matches) {
                matches.forEach(m => profiles.add(m.slice(1, -1)));
            }
        }

        // Parse config file
        if (fs.existsSync(configPath)) {
            const content = fs.readFileSync(configPath, 'utf-8');
            const matches = content.match(/\[(?:profile )?([^\]]+)\]/g);
            if (matches) {
                matches.forEach(m => {
                    const name = m.replace(/\[(?:profile )?/, '').replace(']', '');
                    profiles.add(name);
                });
            }
        }

        return Array.from(profiles).sort((a, b) => {
            if (a === 'default') return -1;
            if (b === 'default') return 1;
            return a.localeCompare(b);
        });
    }

    private _updatePanel() {
        this._panel.webview.html = this._getHtmlForWebview();
    }

    private _getLoadingHtml(): string {
        return `<!DOCTYPE html>
        <html>
        <head>
            <style>
                body { 
                    font-family: var(--vscode-font-family); 
                    padding: 20px; 
                    display: flex; 
                    justify-content: center; 
                    align-items: center; 
                    height: 80vh;
                    flex-direction: column;
                    color: var(--vscode-foreground);
                }
                .spinner { 
                    width: 50px; 
                    height: 50px; 
                    border: 3px solid var(--vscode-foreground); 
                    border-top-color: transparent; 
                    border-radius: 50%; 
                    animation: spin 1s linear infinite; 
                }
                @keyframes spin { to { transform: rotate(360deg); } }
                p { margin-top: 15px; color: var(--vscode-descriptionForeground); }
            </style>
        </head>
        <body>
            <div class="spinner"></div>
            <p>Loading AWS profiles...</p>
        </body>
        </html>`;
    }

    private _getHtmlForWebview(): string {
        const currentProfile = this._cli.getAwsProfile() || 'default';
        const profiles = Array.from(this._profileData.values());
        
        const totalApps = profiles.reduce((sum, p) => sum + p.apps.length, 0);
        const loadingCount = profiles.filter(p => p.loading).length;
        const errorCount = profiles.filter(p => p.error).length;

        return `<!DOCTYPE html>
        <html>
        <head>
            <style>
                body { 
                    font-family: var(--vscode-font-family); 
                    padding: 20px; 
                    color: var(--vscode-foreground);
                    background: var(--vscode-editor-background);
                }
                h1 { 
                    font-size: 1.5em; 
                    margin-bottom: 5px; 
                    display: flex; 
                    align-items: center; 
                    gap: 10px; 
                }
                
                .header-actions {
                    display: flex;
                    gap: 10px;
                }
                .btn {
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    border: none;
                    padding: 6px 12px;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 0.9em;
                }
                .btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
                .btn-primary {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                }
                .btn-primary:hover { background: var(--vscode-button-hoverBackground); }

                .summary {
                    display: flex;
                    gap: 15px;
                    margin: 20px 0;
                }
                .summary-card {
                    background: var(--vscode-editor-inactiveSelectionBackground);
                    padding: 15px 25px;
                    border-radius: 8px;
                    text-align: center;
                }
                .summary-card .number { 
                    font-size: 2em; 
                    font-weight: bold;
                    color: var(--vscode-textLink-foreground);
                }
                .summary-card .label { 
                    font-size: 0.85em; 
                    color: var(--vscode-descriptionForeground);
                    margin-top: 5px;
                }

                .profile-section {
                    background: var(--vscode-editor-inactiveSelectionBackground);
                    border-radius: 8px;
                    margin-bottom: 15px;
                    overflow: hidden;
                }
                .profile-section.active {
                    border: 2px solid var(--vscode-focusBorder);
                }

                .profile-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 15px;
                    cursor: pointer;
                    transition: background 0.2s;
                }
                .profile-header:hover {
                    background: var(--vscode-list-hoverBackground);
                }
                .profile-name {
                    font-weight: 600;
                    font-size: 1.1em;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                .profile-name .icon { font-size: 1.2em; }
                .profile-badge {
                    background: var(--vscode-badge-background);
                    color: var(--vscode-badge-foreground);
                    padding: 2px 8px;
                    border-radius: 10px;
                    font-size: 0.75em;
                    font-weight: 600;
                }
                .profile-badge.active {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                }

                .profile-apps {
                    border-top: 1px solid var(--vscode-panel-border);
                    padding: 10px 15px;
                }

                .app-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
                    gap: 10px;
                }

                .app-card {
                    background: var(--vscode-editor-background);
                    border-radius: 6px;
                    padding: 12px;
                    cursor: pointer;
                    transition: transform 0.2s, box-shadow 0.2s;
                    border: 1px solid var(--vscode-panel-border);
                }
                .app-card:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                }
                .app-name {
                    font-weight: 600;
                    margin-bottom: 5px;
                }
                .app-meta {
                    font-size: 0.85em;
                    color: var(--vscode-descriptionForeground);
                }

                .loading-state {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    padding: 15px;
                    color: var(--vscode-descriptionForeground);
                }
                .loading-spinner {
                    width: 16px;
                    height: 16px;
                    border: 2px solid var(--vscode-foreground);
                    border-top-color: transparent;
                    border-radius: 50%;
                    animation: spin 1s linear infinite;
                }
                @keyframes spin { to { transform: rotate(360deg); } }

                .error-state {
                    padding: 15px;
                    color: var(--vscode-errorForeground);
                    background: var(--vscode-inputValidation-errorBackground);
                    border-radius: 4px;
                    margin: 10px 15px;
                }

                .empty-state {
                    padding: 15px;
                    text-align: center;
                    color: var(--vscode-descriptionForeground);
                }

                .profile-actions {
                    display: flex;
                    gap: 5px;
                }
            </style>
        </head>
        <body>
            <h1>
                <span>🔐 Multi-Account View</span>
                <div class="header-actions">
                    <button class="btn" onclick="refresh()">🔄 Refresh All</button>
                    <button class="btn" onclick="configureProfile()">➕ Add Profile</button>
                </div>
            </h1>

            <div class="summary">
                <div class="summary-card">
                    <div class="number">${profiles.length}</div>
                    <div class="label">Profiles</div>
                </div>
                <div class="summary-card">
                    <div class="number">${totalApps}</div>
                    <div class="label">Total Apps</div>
                </div>
                ${loadingCount > 0 ? `
                    <div class="summary-card">
                        <div class="number">${loadingCount}</div>
                        <div class="label">Loading...</div>
                    </div>
                ` : ''}
                ${errorCount > 0 ? `
                    <div class="summary-card">
                        <div class="number" style="color: var(--vscode-errorForeground)">${errorCount}</div>
                        <div class="label">Errors</div>
                    </div>
                ` : ''}
            </div>

            ${profiles.length === 0 ? `
                <div class="empty-state">
                    <p>No AWS profiles found.</p>
                    <p><button class="btn btn-primary" onclick="configureProfile()">Configure AWS Profile</button></p>
                </div>
            ` : profiles.map(profile => this._renderProfileSection(profile, currentProfile)).join('')}

            <script>
                const vscode = acquireVsCodeApi();
                
                function refresh() {
                    vscode.postMessage({ command: 'refresh' });
                }
                
                function selectApp(appId, region, profile) {
                    vscode.postMessage({ command: 'selectApp', appId, region, profile });
                }
                
                function selectProfile(profile) {
                    vscode.postMessage({ command: 'selectProfile', profile });
                }
                
                function loadProfile(profile) {
                    vscode.postMessage({ command: 'loadProfile', profile });
                }
                
                function openConsole(url) {
                    vscode.postMessage({ command: 'openConsole', url });
                }
                
                function configureProfile() {
                    vscode.postMessage({ command: 'configureProfile' });
                }
            </script>
        </body>
        </html>`;
    }

    private _renderProfileSection(profile: ProfileData, currentProfile: string): string {
        const isActive = profile.name === currentProfile;
        
        return `
            <div class="profile-section ${isActive ? 'active' : ''}">
                <div class="profile-header" onclick="selectProfile('${profile.name}')">
                    <div class="profile-name">
                        <span class="icon">👤</span>
                        ${profile.name}
                        ${isActive ? '<span class="profile-badge active">Active</span>' : ''}
                        ${!profile.loading && !profile.error ? `<span class="profile-badge">${profile.apps.length} apps</span>` : ''}
                    </div>
                    <div class="profile-actions">
                        <button class="btn" onclick="event.stopPropagation(); loadProfile('${profile.name}')">🔄</button>
                        <button class="btn btn-primary" onclick="event.stopPropagation(); selectProfile('${profile.name}')">
                            ${isActive ? '✓ Active' : 'Switch'}
                        </button>
                    </div>
                </div>
                
                <div class="profile-apps">
                    ${profile.loading ? `
                        <div class="loading-state">
                            <div class="loading-spinner"></div>
                            Loading apps...
                        </div>
                    ` : profile.error ? `
                        <div class="error-state">
                            ⚠️ ${profile.error}
                        </div>
                    ` : profile.apps.length === 0 ? `
                        <div class="empty-state">
                            No Amplify apps found in this account
                        </div>
                    ` : `
                        <div class="app-grid">
                            ${profile.apps.map(app => `
                                <div class="app-card" onclick="selectApp('${app.appId}', '${app.region || ''}', '${profile.name}')">
                                    <div class="app-name">☁️ ${app.name}</div>
                                    <div class="app-meta">
                                        ${app.region || 'unknown region'} • ${app.appId.substring(0, 10)}...
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    `}
                </div>
            </div>
        `;
    }
}
