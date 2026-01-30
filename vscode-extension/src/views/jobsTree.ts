import * as vscode from 'vscode';
import { AmplifyMonitorCli, AmplifyJob } from '../cli';

export class JobsTreeProvider implements vscode.TreeDataProvider<JobTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<JobTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private jobs: AmplifyJob[] = [];

    constructor(private cli: AmplifyMonitorCli) {}

    async refresh(): Promise<void> {
        const appId = this.cli.getSelectedApp();
        const branch = this.cli.getSelectedBranch();
        const region = this.cli.getSelectedRegion();

        if (!appId || !branch) {
            this.jobs = [];
            this._onDidChangeTreeData.fire();
            return;
        }

        try {
            this.jobs = await this.cli.listJobs(appId, branch, region);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to load jobs: ${error}`);
            this.jobs = [];
        }
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: JobTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: JobTreeItem): Promise<JobTreeItem[]> {
        if (element) {
            return [];
        }

        const appId = this.cli.getSelectedApp();
        const branch = this.cli.getSelectedBranch();

        if (!appId || !branch) {
            return [new JobTreeItem(
                'Select an app and branch',
                '',
                'NONE',
                '',
                ''
            )];
        }

        if (this.jobs.length === 0) {
            return [new JobTreeItem(
                'No jobs found',
                '',
                'NONE',
                appId,
                branch
            )];
        }

        return this.jobs.map(job => new JobTreeItem(
            `#${job.jobId} - ${job.status}`,
            job.jobId,
            job.status,
            appId,
            branch,
            job.startTime
        ));
    }
}

export class JobTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly jobId: string,
        public readonly status: string,
        public readonly appId: string,
        public readonly branch: string,
        public readonly startTime?: string
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);

        this.contextValue = 'amplifyJob';
        this.iconPath = this.getStatusIcon(status);
        
        if (startTime) {
            this.description = new Date(startTime).toLocaleString();
        }

        if (jobId && status === 'FAILED') {
            this.command = {
                command: 'amplify-monitor.diagnoseJob',
                title: 'Diagnose Job',
                arguments: [appId, branch, jobId]
            };
            this.tooltip = 'Click to diagnose this failed job';
        }
    }

    private getStatusIcon(status: string): vscode.ThemeIcon {
        switch (status) {
            case 'SUCCEED':
                return new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
            case 'FAILED':
                return new vscode.ThemeIcon('x', new vscode.ThemeColor('testing.iconFailed'));
            case 'RUNNING':
                return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('progressBar.background'));
            case 'PENDING':
                return new vscode.ThemeIcon('clock');
            case 'CANCELLED':
                return new vscode.ThemeIcon('circle-slash');
            default:
                return new vscode.ThemeIcon('question');
        }
    }
}
