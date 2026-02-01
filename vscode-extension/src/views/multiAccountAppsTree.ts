import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AmplifyMonitorCli, AmplifyApp } from '../cli';

interface AwsProfileInfo {
    name: string;
    region?: string;
    accountId?: string;
}

interface ProfileApps {
    profile: AwsProfileInfo;
    apps: AmplifyApp[];
    error?: string;
    loading?: boolean;
}

type TreeItemType = 'profile' | 'app' | 'branch' | 'loading' | 'error' | 'noApps';

export class MultiAccountAppsTreeProvider implements vscode.TreeDataProvider<MultiAccountTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<MultiAccountTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private profileApps: Map<string, ProfileApps> = new Map();
    private enabledProfiles: Set<string> = new Set();
    private isMultiAccountMode: boolean = false;

    constructor(private cli: AmplifyMonitorCli) {
        this._loadSettings();
    }

    private _loadSettings() {
        const config = vscode.workspace.getConfiguration('amplifyMonitor');
        this.isMultiAccountMode = config.get<boolean>('multiAccount.enabled', false);
        const savedProfiles = config.get<string[]>('multiAccount.profiles', []);
        this.enabledProfiles = new Set(savedProfiles);
    }

    async toggleMultiAccountMode(): Promise<void> {
        this.isMultiAccountMode = !this.isMultiAccountMode;
        const config = vscode.workspace.getConfiguration('amplifyMonitor');
        await config.update('multiAccount.enabled', this.isMultiAccountMode, vscode.ConfigurationTarget.Global);
        
        if (this.isMultiAccountMode) {
            vscode.window.showInformationMessage('Multi-account mode enabled. Select profiles to view.');
        } else {
            vscode.window.showInformationMessage('Multi-account mode disabled. Showing apps from active profile only.');
        }
        
        this._onDidChangeTreeData.fire();
    }

    isMultiAccount(): boolean {
        return this.isMultiAccountMode;
    }

    async selectProfiles(): Promise<void> {
        const allProfiles = await this._getAvailableProfiles();
        
        const items = allProfiles.map(p => ({
            label: p.name,
            description: p.region ? `Region: ${p.region}` : '',
            picked: this.enabledProfiles.has(p.name)
        }));

        const selected = await vscode.window.showQuickPick(items, {
            canPickMany: true,
            title: 'Select AWS Profiles',
            placeHolder: 'Select profiles to show apps from'
        });

        if (selected) {
            this.enabledProfiles = new Set(selected.map(s => s.label));
            const config = vscode.workspace.getConfiguration('amplifyMonitor');
            await config.update('multiAccount.profiles', Array.from(this.enabledProfiles), vscode.ConfigurationTarget.Global);
            await this.refresh();
        }
    }

    async refresh(): Promise<void> {
        this._loadSettings();
        this.profileApps.clear();

        if (!this.isMultiAccountMode) {
            // Single profile mode - use current profile
            try {
                const apps = await this.cli.listApps(true);
                const currentProfile = this.cli.getAwsProfile() || 'default';
                this.profileApps.set(currentProfile, {
                    profile: { name: currentProfile },
                    apps
                });
            } catch (error) {
                const currentProfile = this.cli.getAwsProfile() || 'default';
                this.profileApps.set(currentProfile, {
                    profile: { name: currentProfile },
                    apps: [],
                    error: error instanceof Error ? error.message : 'Unknown error'
                });
            }
        } else {
            // Multi-account mode - load from all enabled profiles
            const profiles = this.enabledProfiles.size > 0 
                ? Array.from(this.enabledProfiles)
                : await this._getAvailableProfiles().then(p => p.map(x => x.name));

            // Load apps in parallel for all profiles
            const loadPromises = profiles.map(async (profileName) => {
                try {
                    const apps = await this.cli.listAppsForProfile(profileName, true);
                    this.profileApps.set(profileName, {
                        profile: { name: profileName },
                        apps
                    });
                } catch (error) {
                    this.profileApps.set(profileName, {
                        profile: { name: profileName },
                        apps: [],
                        error: error instanceof Error ? error.message : 'Unknown error'
                    });
                }
            });

            await Promise.allSettled(loadPromises);
        }

        this._onDidChangeTreeData.fire();
    }

    private async _getAvailableProfiles(): Promise<AwsProfileInfo[]> {
        const profiles: AwsProfileInfo[] = [];
        const credentialsPath = process.env.AWS_SHARED_CREDENTIALS_FILE || 
            path.join(os.homedir(), '.aws', 'credentials');
        const configPath = process.env.AWS_CONFIG_FILE || 
            path.join(os.homedir(), '.aws', 'config');

        const profileNames = new Set<string>();

        // Parse credentials file
        if (fs.existsSync(credentialsPath)) {
            const content = fs.readFileSync(credentialsPath, 'utf-8');
            const matches = content.match(/\[([^\]]+)\]/g);
            if (matches) {
                matches.forEach(m => profileNames.add(m.slice(1, -1)));
            }
        }

        // Parse config file
        if (fs.existsSync(configPath)) {
            const content = fs.readFileSync(configPath, 'utf-8');
            const matches = content.match(/\[(?:profile )?([^\]]+)\]/g);
            if (matches) {
                matches.forEach(m => {
                    const name = m.replace(/\[(?:profile )?/, '').replace(']', '');
                    profileNames.add(name);
                });
            }
        }

        for (const name of profileNames) {
            profiles.push({ name });
        }

        return profiles.sort((a, b) => {
            if (a.name === 'default') return -1;
            if (b.name === 'default') return 1;
            return a.name.localeCompare(b.name);
        });
    }

    getTreeItem(element: MultiAccountTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: MultiAccountTreeItem): Promise<MultiAccountTreeItem[]> {
        if (!element) {
            // Root level
            if (this.profileApps.size === 0) {
                await this.refresh();
            }

            if (!this.isMultiAccountMode) {
                // Single profile mode - show apps directly
                const entry = Array.from(this.profileApps.values())[0];
                if (!entry) {
                    return [new MultiAccountTreeItem(
                        'No apps found',
                        'noApps',
                        vscode.TreeItemCollapsibleState.None
                    )];
                }

                if (entry.error) {
                    return [new MultiAccountTreeItem(
                        `Error: ${entry.error}`,
                        'error',
                        vscode.TreeItemCollapsibleState.None
                    )];
                }

                if (entry.apps.length === 0) {
                    return [new MultiAccountTreeItem(
                        'No Amplify apps found',
                        'noApps',
                        vscode.TreeItemCollapsibleState.None
                    )];
                }

                return entry.apps.map(app => new MultiAccountTreeItem(
                    app.name,
                    'app',
                    vscode.TreeItemCollapsibleState.Collapsed,
                    { app, profile: entry.profile.name }
                ));
            }

            // Multi-account mode - show profiles at root
            const items: MultiAccountTreeItem[] = [];
            
            for (const [profileName, data] of this.profileApps) {
                const appCount = data.apps.length;
                const hasError = !!data.error;
                
                items.push(new MultiAccountTreeItem(
                    profileName,
                    'profile',
                    appCount > 0 || hasError ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
                    { profile: profileName, appCount, error: data.error }
                ));
            }

            if (items.length === 0) {
                items.push(new MultiAccountTreeItem(
                    'Select profiles to view apps',
                    'noApps',
                    vscode.TreeItemCollapsibleState.None
                ));
            }

            return items;
        }

        // Children of elements
        if (element.type === 'profile') {
            const data = this.profileApps.get(element.data?.profile || '');
            if (!data) return [];

            if (data.error) {
                return [new MultiAccountTreeItem(
                    `⚠️ ${data.error}`,
                    'error',
                    vscode.TreeItemCollapsibleState.None
                )];
            }

            if (data.apps.length === 0) {
                return [new MultiAccountTreeItem(
                    'No Amplify apps',
                    'noApps',
                    vscode.TreeItemCollapsibleState.None
                )];
            }

            return data.apps.map(app => new MultiAccountTreeItem(
                app.name,
                'app',
                vscode.TreeItemCollapsibleState.Collapsed,
                { app, profile: element.data?.profile }
            ));
        }

        if (element.type === 'app') {
            // App level - show branches
            const app = element.data?.app;
            const profile = element.data?.profile;
            
            if (!app) return [];

            try {
                const branches = await this.cli.listBranches(app.appId, app.region);
                return branches.map(branch => new MultiAccountTreeItem(
                    branch.branchName,
                    'branch',
                    vscode.TreeItemCollapsibleState.None,
                    { app, branch: branch.branchName, profile }
                ));
            } catch (error) {
                return [new MultiAccountTreeItem(
                    `Failed to load branches`,
                    'error',
                    vscode.TreeItemCollapsibleState.None
                )];
            }
        }

        return [];
    }

    getTotalAppCount(): number {
        let total = 0;
        for (const data of this.profileApps.values()) {
            total += data.apps.length;
        }
        return total;
    }

    getProfileCount(): number {
        return this.profileApps.size;
    }
}

export class MultiAccountTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly type: TreeItemType,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly data?: {
            app?: AmplifyApp;
            branch?: string;
            profile?: string;
            appCount?: number;
            error?: string;
        }
    ) {
        super(label, collapsibleState);
        this._setupItem();
    }

    private _setupItem() {
        switch (this.type) {
            case 'profile':
                this.contextValue = 'awsProfile';
                this.iconPath = new vscode.ThemeIcon('account');
                if (this.data?.error) {
                    this.description = '⚠️ Error';
                    this.tooltip = this.data.error;
                } else {
                    this.description = `${this.data?.appCount || 0} apps`;
                    this.tooltip = `AWS Profile: ${this.label}\nApps: ${this.data?.appCount || 0}`;
                }
                break;

            case 'app':
                this.contextValue = 'amplifyApp';
                this.iconPath = new vscode.ThemeIcon('cloud');
                this.description = this.data?.app?.region || '';
                this.tooltip = `App: ${this.data?.app?.name}\nID: ${this.data?.app?.appId}\nRegion: ${this.data?.app?.region || 'unknown'}\nProfile: ${this.data?.profile || 'default'}`;
                this.command = {
                    command: 'amplify-monitor.selectAppMultiAccount',
                    title: 'Select App',
                    arguments: [this.data?.app?.appId, this.data?.app?.region, this.data?.profile]
                };
                break;

            case 'branch':
                this.contextValue = 'amplifyBranch';
                this.iconPath = new vscode.ThemeIcon('git-branch');
                this.tooltip = `Branch: ${this.data?.branch}\nProfile: ${this.data?.profile || 'default'}`;
                this.command = {
                    command: 'amplify-monitor.selectBranchMultiAccount',
                    title: 'Select Branch',
                    arguments: [this.data?.branch, this.data?.app?.appId, this.data?.app?.region, this.data?.profile]
                };
                break;

            case 'loading':
                this.iconPath = new vscode.ThemeIcon('sync~spin');
                this.description = 'Loading...';
                break;

            case 'error':
                this.iconPath = new vscode.ThemeIcon('warning');
                break;

            case 'noApps':
                this.iconPath = new vscode.ThemeIcon('info');
                break;
        }
    }
}
