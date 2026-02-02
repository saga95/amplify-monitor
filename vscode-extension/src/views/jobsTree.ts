import * as vscode from 'vscode';
import { AmplifyMonitorCli, AmplifyJob } from '../cli';

export class JobsTreeProvider implements vscode.TreeDataProvider<JobTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<JobTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private jobs: AmplifyJob[] = [];
    private previousJobStatuses: Map<string, string> = new Map(); // Track job status changes
    private notifiedJobs: Set<string> = new Set(); // Avoid duplicate notifications

    constructor(private cli: AmplifyMonitorCli) {}

    async refresh(): Promise<void> {
        const appId = this.cli.getSelectedApp();
        const branch = this.cli.getSelectedBranch();
        const region = this.cli.getSelectedRegion();
        const profile = this.cli.getSelectedProfile();

        if (!appId || !branch) {
            this.jobs = [];
            this._onDidChangeTreeData.fire();
            return;
        }

        try {
            const newJobs = await this.cli.listJobs(appId, branch, region, profile);
            
            // Check for status changes and notify
            await this.checkForStatusChanges(newJobs, appId, branch);
            
            this.jobs = newJobs;
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to load jobs: ${error}`);
            this.jobs = [];
        }
        this._onDidChangeTreeData.fire();
    }

    private async checkForStatusChanges(newJobs: AmplifyJob[], appId: string, branch: string): Promise<void> {
        const config = vscode.workspace.getConfiguration('amplifyMonitor');
        const notifyOnFailure = config.get<boolean>('notifications.buildFailed', true);
        const notifyOnSuccess = config.get<boolean>('notifications.buildSucceeded', false);
        
        for (const job of newJobs) {
            const jobKey = `${appId}:${branch}:${job.jobId}`;
            const previousStatus = this.previousJobStatuses.get(jobKey);
            
            // Update status tracking
            this.previousJobStatuses.set(jobKey, job.status);
            
            // Skip if already notified for this job's final state
            if (this.notifiedJobs.has(jobKey) && (job.status === 'FAILED' || job.status === 'SUCCEED')) {
                continue;
            }
            
            // Only notify on status transitions to terminal states
            if (previousStatus && previousStatus !== job.status) {
                if (job.status === 'FAILED' && notifyOnFailure) {
                    this.notifiedJobs.add(jobKey);
                    this.showFailedBuildNotification(appId, branch, job);
                } else if (job.status === 'SUCCEED' && notifyOnSuccess) {
                    this.notifiedJobs.add(jobKey);
                    this.showSuccessfulBuildNotification(appId, branch, job);
                }
            }
            
            // Also notify if this is a new job we haven't seen before and it's failed
            if (!previousStatus && job.status === 'FAILED' && notifyOnFailure && !this.notifiedJobs.has(jobKey)) {
                this.notifiedJobs.add(jobKey);
                this.showFailedBuildNotification(appId, branch, job);
            }
        }
        
        // Cleanup old entries (keep last 50)
        if (this.previousJobStatuses.size > 100) {
            const keys = Array.from(this.previousJobStatuses.keys());
            keys.slice(0, keys.length - 50).forEach(k => {
                this.previousJobStatuses.delete(k);
                this.notifiedJobs.delete(k);
            });
        }
    }

    private showFailedBuildNotification(appId: string, branch: string, job: AmplifyJob): void {
        const appName = this.cli.getSelectedAppName() || appId;
        vscode.window.showWarningMessage(
            `❌ Build failed: ${appName}/${branch} #${job.jobId}`,
            'Diagnose',
            'View Logs'
        ).then(action => {
            if (action === 'Diagnose') {
                vscode.commands.executeCommand('amplify-monitor.diagnoseJob', appId, branch, job.jobId);
            } else if (action === 'View Logs') {
                vscode.commands.executeCommand('amplify-monitor.viewJobLogs', appId, branch, job.jobId);
            }
        });
    }

    private showSuccessfulBuildNotification(appId: string, branch: string, job: AmplifyJob): void {
        const appName = this.cli.getSelectedAppName() || appId;
        vscode.window.showInformationMessage(
            `✅ Build succeeded: ${appName}/${branch} #${job.jobId}`
        );
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
