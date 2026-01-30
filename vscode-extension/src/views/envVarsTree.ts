import * as vscode from 'vscode';
import { AmplifyMonitorCli, EnvVariable } from '../cli';

export class EnvVarsTreeProvider implements vscode.TreeDataProvider<EnvVarItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<EnvVarItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private envVars: EnvVariable[] = [];

    constructor(private cli: AmplifyMonitorCli) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: EnvVarItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: EnvVarItem): Promise<EnvVarItem[]> {
        if (element) {
            return [];
        }

        const appId = this.cli.getSelectedApp();
        const branch = this.cli.getSelectedBranch();

        if (!appId || !branch) {
            return [new EnvVarItem('Select an app and branch first', '', 'info')];
        }

        try {
            const region = this.cli.getSelectedRegion();
            this.envVars = await this.cli.getEnvVariables(appId, branch, region);

            if (this.envVars.length === 0) {
                return [new EnvVarItem('No environment variables', '', 'info')];
            }

            return this.envVars.map(env => new EnvVarItem(
                env.name,
                this.maskValue(env.value),
                'env',
                env
            ));
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            return [new EnvVarItem(`Error: ${message}`, '', 'error')];
        }
    }

    private maskValue(value: string): string {
        if (value.length <= 4) {
            return '****';
        }
        return value.substring(0, 4) + '****';
    }

    getEnvVars(): EnvVariable[] {
        return this.envVars;
    }
}

export class EnvVarItem extends vscode.TreeItem {
    constructor(
        public readonly name: string,
        public readonly value: string,
        public readonly type: 'env' | 'info' | 'error',
        public readonly envVar?: EnvVariable
    ) {
        super(name, vscode.TreeItemCollapsibleState.None);

        if (type === 'env') {
            this.description = value;
            this.tooltip = `${name}\nClick to reveal value`;
            this.contextValue = 'envVariable';
            this.iconPath = new vscode.ThemeIcon('key');
        } else if (type === 'error') {
            this.iconPath = new vscode.ThemeIcon('error');
        } else {
            this.iconPath = new vscode.ThemeIcon('info');
        }
    }
}
