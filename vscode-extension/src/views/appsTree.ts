import * as vscode from 'vscode';
import { AmplifyMonitorCli, AmplifyApp } from '../cli';

interface AppWithProfile {
    app: AmplifyApp;
    profile: string;
}

export class AppsTreeProvider implements vscode.TreeDataProvider<AppTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<AppTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private apps: AppWithProfile[] = [];
    private isMultiAccountMode: boolean = false;

    constructor(private cli: AmplifyMonitorCli) {}

    async refresh(): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('amplifyMonitor');
            this.isMultiAccountMode = config.get<boolean>('multiAccount.enabled', false);
            const configuredProfiles = config.get<string[]>('multiAccount.profiles', []);
            const defaultProfile = this.cli.getAwsProfile() || 'default';

            if (this.isMultiAccountMode && configuredProfiles.length > 0) {
                // Multi-account mode: fetch apps from all configured profiles
                // Also include default profile if not already in the list
                const profilesToFetch = [...new Set([...configuredProfiles, defaultProfile])];
                const allApps: AppWithProfile[] = [];
                const profilePromises = profilesToFetch.map(async (profile) => {
                    try {
                        const apps = await this.cli.listAppsForProfile(profile, true);
                        return apps.map(app => ({ app, profile }));
                    } catch (error) {
                        console.warn(`Failed to fetch apps for profile ${profile}:`, error);
                        return [];
                    }
                });
                
                const results = await Promise.all(profilePromises);
                this.apps = results.flat();
            } else {
                // Single account mode: use default/configured profile
                const apps = await this.cli.listApps(true);
                this.apps = apps.map(app => ({ app, profile: defaultProfile }));
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to load apps: ${error}`);
            this.apps = [];
        }
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: AppTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: AppTreeItem): Promise<AppTreeItem[]> {
        if (!element) {
            // Root level - show apps
            if (this.apps.length === 0) {
                await this.refresh();
            }
            
            // Sort by profile (if multi-account) then by name
            const sortedApps = [...this.apps].sort((a, b) => {
                if (this.isMultiAccountMode && a.profile !== b.profile) {
                    return a.profile.localeCompare(b.profile);
                }
                return a.app.name.localeCompare(b.app.name);
            });

            return sortedApps.map(({ app, profile }) => new AppTreeItem(
                app.name,
                app.appId,
                'app',
                vscode.TreeItemCollapsibleState.Collapsed,
                undefined,
                app.region,
                profile  // Always pass profile
            ));
        }

        if (element.type === 'app') {
            // App level - show branches
            try {
                const branches = await this.cli.listBranches(element.appId, element.region, element.profile);
                return branches.map(branch => new AppTreeItem(
                    branch.branchName,
                    element.appId,
                    'branch',
                    vscode.TreeItemCollapsibleState.None,
                    branch.branchName,
                    element.region,
                    element.profile
                ));
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to load branches: ${error}`);
                return [];
            }
        }

        return [];
    }
}

export class AppTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly appId: string,
        public readonly type: 'app' | 'branch',
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly branchName?: string,
        public readonly region?: string,
        public readonly profile?: string
    ) {
        super(label, collapsibleState);

        if (type === 'app') {
            this.contextValue = 'amplifyApp';
            this.iconPath = new vscode.ThemeIcon('cloud');
            // Show region and profile in description
            const descParts = [];
            if (region) descParts.push(region);
            if (profile) descParts.push(`👤 ${profile}`);
            this.description = descParts.join(' · ');
            this.tooltip = `App: ${label}\nApp ID: ${appId}\nRegion: ${region || 'unknown'}${profile ? `\nProfile: ${profile}` : ''}`;
            this.command = {
                command: 'amplify-monitor.selectApp',
                title: 'Select App',
                arguments: [appId, region, profile]
            };
        } else {
            this.contextValue = 'amplifyBranch';
            this.iconPath = new vscode.ThemeIcon('git-branch');
            this.tooltip = `Branch: ${branchName}`;
            this.command = {
                command: 'amplify-monitor.selectBranch',
                title: 'Select Branch',
                arguments: [branchName]
            };
        }
    }
}
