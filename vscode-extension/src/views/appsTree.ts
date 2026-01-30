import * as vscode from 'vscode';
import { AmplifyMonitorCli, AmplifyApp } from '../cli';

export class AppsTreeProvider implements vscode.TreeDataProvider<AppTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<AppTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private apps: AmplifyApp[] = [];

    constructor(private cli: AmplifyMonitorCli) {}

    async refresh(): Promise<void> {
        try {
            // Load apps from all regions
            this.apps = await this.cli.listApps(true);
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
            return this.apps.map(app => new AppTreeItem(
                app.name,
                app.appId,
                'app',
                vscode.TreeItemCollapsibleState.Collapsed,
                undefined,
                app.region
            ));
        }

        if (element.type === 'app') {
            // App level - show branches
            try {
                const branches = await this.cli.listBranches(element.appId, element.region);
                return branches.map(branch => new AppTreeItem(
                    branch.branchName,
                    element.appId,
                    'branch',
                    vscode.TreeItemCollapsibleState.None,
                    branch.branchName,
                    element.region
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
        public readonly region?: string
    ) {
        super(label, collapsibleState);

        if (type === 'app') {
            this.contextValue = 'amplifyApp';
            this.iconPath = new vscode.ThemeIcon('cloud');
            this.description = region || '';
            this.tooltip = `App ID: ${appId}\nRegion: ${region || 'unknown'}`;
            this.command = {
                command: 'amplify-monitor.selectApp',
                title: 'Select App',
                arguments: [appId, region]
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
