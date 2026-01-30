import * as vscode from 'vscode';
import { MigrationAnalysis, MigrationFeature, MigrationCompatibility } from '../cli';

export class MigrationTreeProvider implements vscode.TreeDataProvider<MigrationTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<MigrationTreeItem | undefined | null | void> = new vscode.EventEmitter<MigrationTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<MigrationTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private analysis: MigrationAnalysis | undefined;

    constructor() {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    setAnalysis(analysis: MigrationAnalysis | undefined): void {
        this.analysis = analysis;
        this.refresh();
    }

    getTreeItem(element: MigrationTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: MigrationTreeItem): Thenable<MigrationTreeItem[]> {
        if (!this.analysis) {
            return Promise.resolve([]);
        }

        if (!element) {
            // Root level - show summary and categories
            return Promise.resolve(this.getRootItems());
        }

        // Children of categories
        if (element.contextValue === 'migration-category') {
            return Promise.resolve(this.getCategoryFeatures(element.category!));
        }

        return Promise.resolve([]);
    }

    private getRootItems(): MigrationTreeItem[] {
        if (!this.analysis) {
            return [];
        }

        const items: MigrationTreeItem[] = [];

        // Generation info
        const genIcon = this.analysis.generation === 'Gen1' ? '$(warning)' : 
                       this.analysis.generation === 'Gen2' ? '$(check)' : '$(question)';
        items.push(new MigrationTreeItem(
            `${genIcon} ${this.analysis.generation} Project`,
            vscode.TreeItemCollapsibleState.None,
            'migration-info'
        ));

        // Readiness status
        if (this.analysis.generation === 'Gen1') {
            const readyIcon = this.analysis.readyForMigration ? '$(check)' : '$(error)';
            const readyText = this.analysis.readyForMigration ? 'Ready for Migration' : 'Blocking Issues Found';
            items.push(new MigrationTreeItem(
                `${readyIcon} ${readyText}`,
                vscode.TreeItemCollapsibleState.None,
                this.analysis.readyForMigration ? 'migration-ready' : 'migration-blocked'
            ));

            // Summary
            items.push(new MigrationTreeItem(
                `$(checklist) Summary: ${this.analysis.summary.fullySupported}/${this.analysis.summary.totalFeatures} fully supported`,
                vscode.TreeItemCollapsibleState.None,
                'migration-summary'
            ));

            // Add categories
            for (const category of this.analysis.categoriesDetected) {
                const categoryFeatures = this.analysis.features.filter(f => f.category === category);
                const supportedCount = categoryFeatures.filter(f => {
                    const compat = f.compatibility as any;
                    return compat?.type === 'Supported' || compat === 'Supported' || (compat && 'Supported' in compat);
                }).length;
                
                const item = new MigrationTreeItem(
                    `${this.getCategoryIcon(category)} ${category.toUpperCase()} (${supportedCount}/${categoryFeatures.length})`,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'migration-category'
                );
                item.category = category;
                items.push(item);
            }
        }

        return items;
    }

    private getCategoryFeatures(category: string): MigrationTreeItem[] {
        if (!this.analysis) {
            return [];
        }

        return this.analysis.features
            .filter(f => f.category === category)
            .map(feature => {
                const { icon, status } = this.getCompatibilityInfo(feature.compatibility);
                const item = new MigrationTreeItem(
                    `${icon} ${feature.feature}`,
                    vscode.TreeItemCollapsibleState.None,
                    'migration-feature'
                );
                item.feature = feature;
                item.tooltip = new vscode.MarkdownString(`**${feature.feature}**\n\n${status}\n\n${feature.migrationHint}`);
                item.description = status;
                
                // Add file link if available
                if (feature.filePath) {
                    item.command = {
                        command: 'vscode.open',
                        title: 'Open File',
                        arguments: [
                            vscode.Uri.file(feature.filePath),
                            feature.lineNumber ? { selection: new vscode.Range(feature.lineNumber - 1, 0, feature.lineNumber - 1, 0) } : undefined
                        ]
                    };
                }
                
                return item;
            });
    }

    private getCategoryIcon(category: string): string {
        const icons: Record<string, string> = {
            'api': '$(symbol-interface)',
            'auth': '$(shield)',
            'storage': '$(database)',
            'function': '$(symbol-function)',
            'geo': '$(globe)',
            'analytics': '$(graph)',
            'interactions': '$(comment-discussion)',
        };
        return icons[category] || '$(folder)';
    }

    private getCompatibilityInfo(compatibility: MigrationCompatibility | string): { icon: string; status: string } {
        // Handle both object and string formats from JSON
        const compat = typeof compatibility === 'string' ? compatibility : (compatibility as any).type || compatibility;
        
        if (compat === 'Supported' || (typeof compat === 'object' && 'Supported' in compat)) {
            return { icon: '$(check)', status: 'Fully Supported' };
        }
        if (compat === 'SupportedWithCdk' || (typeof compat === 'object' && 'SupportedWithCdk' in compat)) {
            return { icon: '$(tools)', status: 'Requires CDK' };
        }
        if (compat === 'NotSupported' || (typeof compat === 'object' && 'NotSupported' in compat)) {
            return { icon: '$(error)', status: 'Not Supported' };
        }
        if (compat === 'ManualMigration' || (typeof compat === 'object' && 'ManualMigration' in compat)) {
            return { icon: '$(warning)', status: 'Manual Migration' };
        }
        return { icon: '$(circle-outline)', status: 'Unknown' };
    }
}

export class MigrationTreeItem extends vscode.TreeItem {
    category?: string;
    feature?: MigrationFeature;

    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly contextValue?: string
    ) {
        super(label, collapsibleState);
    }
}
