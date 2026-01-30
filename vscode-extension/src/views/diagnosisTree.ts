import * as vscode from 'vscode';
import { AmplifyMonitorCli, DiagnosisResult, DiagnosisIssue } from '../cli';

export class DiagnosisTreeProvider implements vscode.TreeDataProvider<DiagnosisTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<DiagnosisTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private result: DiagnosisResult | null = null;

    constructor(private cli: AmplifyMonitorCli) {}

    async runDiagnosis(appId: string, branch: string, jobId?: string): Promise<void> {
        try {
            this.result = await this.cli.diagnose(appId, branch, jobId);
            this._onDidChangeTreeData.fire();

            if (this.result.issues.length === 0) {
                vscode.window.showInformationMessage('No issues detected in the build logs.');
            } else {
                vscode.window.showWarningMessage(
                    `Found ${this.result.issues.length} issue(s) in job ${this.result.jobId}`
                );
            }
        } catch (error) {
            this.result = null;
            this._onDidChangeTreeData.fire();
            throw error;
        }
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: DiagnosisTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: DiagnosisTreeItem): DiagnosisTreeItem[] {
        if (!this.result) {
            return [new DiagnosisTreeItem(
                'Run diagnosis to see results',
                'info',
                vscode.TreeItemCollapsibleState.None
            )];
        }

        if (!element) {
            // Root level - show summary and issues
            const items: DiagnosisTreeItem[] = [];

            // Summary header
            items.push(new DiagnosisTreeItem(
                `Job ${this.result.jobId} - ${this.result.status}`,
                'header',
                vscode.TreeItemCollapsibleState.None,
                undefined,
                `App: ${this.result.appId} | Branch: ${this.result.branch}`
            ));

            if (this.result.issues.length === 0) {
                items.push(new DiagnosisTreeItem(
                    'No issues detected',
                    'success',
                    vscode.TreeItemCollapsibleState.None
                ));
            } else {
                // Each issue as a collapsible item
                for (const issue of this.result.issues) {
                    items.push(new DiagnosisTreeItem(
                        issue.pattern.replace(/_/g, ' '),
                        'issue',
                        vscode.TreeItemCollapsibleState.Collapsed,
                        issue
                    ));
                }
            }

            return items;
        }

        // Issue children - show root cause and fixes
        if (element.issue) {
            const items: DiagnosisTreeItem[] = [];

            items.push(new DiagnosisTreeItem(
                `Cause: ${element.issue.rootCause}`,
                'cause',
                vscode.TreeItemCollapsibleState.None
            ));

            if (element.issue.suggestedFixes.length > 0) {
                items.push(new DiagnosisTreeItem(
                    'Suggested Fixes',
                    'fixes-header',
                    vscode.TreeItemCollapsibleState.Expanded,
                    undefined,
                    undefined,
                    element.issue.suggestedFixes
                ));
            }

            return items;
        }

        // Fixes list
        if (element.fixes) {
            return element.fixes.map((fix, index) => new DiagnosisTreeItem(
                `${index + 1}. ${fix}`,
                'fix',
                vscode.TreeItemCollapsibleState.None
            ));
        }

        return [];
    }
}

export class DiagnosisTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly type: 'header' | 'issue' | 'cause' | 'fixes-header' | 'fix' | 'success' | 'info',
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly issue?: DiagnosisIssue,
        public readonly description?: string,
        public readonly fixes?: string[]
    ) {
        super(label, collapsibleState);

        this.contextValue = `diagnosis-${type}`;

        switch (type) {
            case 'header':
                this.iconPath = new vscode.ThemeIcon('info');
                break;
            case 'issue':
                this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
                this.tooltip = issue?.rootCause;
                break;
            case 'cause':
                this.iconPath = new vscode.ThemeIcon('lightbulb');
                break;
            case 'fixes-header':
                this.iconPath = new vscode.ThemeIcon('tools');
                break;
            case 'fix':
                this.iconPath = new vscode.ThemeIcon('arrow-right');
                break;
            case 'success':
                this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
                break;
            case 'info':
                this.iconPath = new vscode.ThemeIcon('info');
                break;
        }
    }
}
