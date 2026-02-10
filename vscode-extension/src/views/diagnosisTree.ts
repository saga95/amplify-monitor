import * as vscode from 'vscode';
import { AmplifyMonitorCli, DiagnosisResult, DiagnosisIssue } from '../cli';
import { QUICK_FIXES } from '../quickFixes';
import { DiagnosisShareService } from '../diagnosisShare';

export class DiagnosisTreeProvider implements vscode.TreeDataProvider<DiagnosisTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<DiagnosisTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private result: (DiagnosisResult & { rawLogs?: string }) | null = null;

    constructor(private cli: AmplifyMonitorCli) {}

    /**
     * Get the raw logs from the last diagnosis (for viewing full logs)
     */
    getRawLogs(): string | null {
        return this.result?.rawLogs || null;
    }

    /**
     * Get the current diagnosis result (for sharing)
     */
    getResult(): DiagnosisResult | null {
        return this.result;
    }

    async runDiagnosis(appId: string, branch: string, jobId?: string): Promise<void> {
        try {
            // Use diagnoseWithLogs to get full build/deploy logs
            this.result = await this.cli.diagnoseWithLogs(appId, branch, jobId);
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

            // Add "View Full Logs" action if logs are available
            if (this.result.rawLogs) {
                const viewLogsItem = new DiagnosisTreeItem(
                    '📋 View Full Build Logs',
                    'view-logs',
                    vscode.TreeItemCollapsibleState.None
                );
                viewLogsItem.command = {
                    command: 'amplify-monitor.viewFullLogs',
                    title: 'View Full Logs'
                };
                items.push(viewLogsItem);
            }

            return items;
        }

        // Handle based on element type
        switch (element.type) {
            case 'issue': {
                // Issue children - show root cause and fixes
                if (!element.issue) return [];
                const issue = element.issue;
                const items: DiagnosisTreeItem[] = [];

                items.push(new DiagnosisTreeItem(
                    `Cause: ${issue.rootCause}`,
                    'cause',
                    vscode.TreeItemCollapsibleState.None
                ));

                // Add quick fixes if available
                const quickFixes = QUICK_FIXES[issue.pattern];
                if (quickFixes && quickFixes.length > 0) {
                    items.push(new DiagnosisTreeItem(
                        '⚡ Quick Fixes (click to apply)',
                        'fixes-header',
                        vscode.TreeItemCollapsibleState.Expanded,
                        issue,
                        undefined,
                        undefined
                    ));
                }

                if (issue.suggestedFixes.length > 0) {
                    items.push(new DiagnosisTreeItem(
                        'Manual Steps',
                        'fixes-header',
                        vscode.TreeItemCollapsibleState.Collapsed,
                        undefined,
                        undefined,
                        issue.suggestedFixes
                    ));
                }

                return items;
            }

            case 'fixes-header': {
                // Quick fixes list (when fixes-header has an associated issue)
                if (element.issue) {
                    const issue = element.issue;
                    const pattern = issue.pattern;
                    const quickFixes = QUICK_FIXES[pattern] || [];
                    return quickFixes.map(fix => {
                        const item = new DiagnosisTreeItem(
                            fix.title,
                            'quick-fix',
                            vscode.TreeItemCollapsibleState.None,
                            issue,
                            fix.description,
                            undefined,
                            fix.id
                        );
                        item.command = {
                            command: 'amplify-monitor.applyQuickFix',
                            title: 'Apply Quick Fix',
                            arguments: [pattern, fix.id]
                        };
                        return item;
                    });
                }

                // Fixes list (manual steps)
                if (element.fixes) {
                    return element.fixes.map((fix, index) => new DiagnosisTreeItem(
                        `${index + 1}. ${fix}`,
                        'fix',
                        vscode.TreeItemCollapsibleState.None
                    ));
                }
                return [];
            }

            default:
                return [];
        }
    }
}

export class DiagnosisTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly type: 'header' | 'issue' | 'cause' | 'fixes-header' | 'fix' | 'success' | 'info' | 'quick-fix' | 'view-logs',
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly issue?: DiagnosisIssue,
        public readonly description?: string,
        public readonly fixes?: string[],
        public readonly quickFixId?: string
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
                // Add quick fix button if available
                if (issue && QUICK_FIXES[issue.pattern]) {
                    this.contextValue = 'diagnosis-issue-fixable';
                }
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
            case 'quick-fix':
                this.iconPath = new vscode.ThemeIcon('wand', new vscode.ThemeColor('charts.green'));
                this.contextValue = 'diagnosis-quick-fix';
                break;
            case 'success':
                this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
                break;
            case 'info':
                this.iconPath = new vscode.ThemeIcon('info');
                break;
            case 'view-logs':
                this.iconPath = new vscode.ThemeIcon('file-text');
                this.tooltip = 'Click to view full build and deploy logs';
                break;
        }
    }
}
