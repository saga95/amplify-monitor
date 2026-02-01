import * as vscode from 'vscode';

interface CustomPattern {
    id: string;
    name: string;
    pattern: string;
    isRegex: boolean;
    caseSensitive: boolean;
    category: 'error' | 'warning' | 'info';
    rootCause: string;
    suggestedFixes: string[];
    enabled: boolean;
    matchCount?: number;
    lastMatched?: string;
}

interface PatternTestResult {
    matched: boolean;
    matches: string[];
    groups: Record<string, string>[];
    error?: string;
}

export class CustomPatternsPanel {
    public static currentPanel: CustomPatternsPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _context: vscode.ExtensionContext;

    public static createOrShow(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (CustomPatternsPanel.currentPanel) {
            CustomPatternsPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'customPatterns',
            'Custom Failure Patterns',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        CustomPatternsPanel.currentPanel = new CustomPatternsPanel(panel, extensionUri, context);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._context = context;

        this._update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'loadPatterns':
                        await this._loadPatterns();
                        break;
                    case 'savePattern':
                        await this._savePattern(message.pattern);
                        break;
                    case 'deletePattern':
                        await this._deletePattern(message.id);
                        break;
                    case 'togglePattern':
                        await this._togglePattern(message.id);
                        break;
                    case 'testPattern':
                        this._testPattern(message.pattern, message.testText);
                        break;
                    case 'importPatterns':
                        await this._importPatterns();
                        break;
                    case 'exportPatterns':
                        await this._exportPatterns();
                        break;
                    case 'loadPresets':
                        this._loadPresets();
                        break;
                    case 'addPreset':
                        await this._addPreset(message.presetId);
                        break;
                    case 'duplicatePattern':
                        await this._duplicatePattern(message.id);
                        break;
                }
            },
            null,
            this._disposables
        );

        this._loadPatterns();
    }

    public dispose() {
        CustomPatternsPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private async _update() {
        this._panel.webview.html = this._getHtmlContent();
    }

    private async _loadPatterns() {
        const patterns = this._context.globalState.get<CustomPattern[]>('customFailurePatterns', []);
        this._panel.webview.postMessage({ command: 'patternsLoaded', patterns });
    }

    private async _savePattern(pattern: CustomPattern) {
        const patterns = this._context.globalState.get<CustomPattern[]>('customFailurePatterns', []);
        
        const existingIndex = patterns.findIndex(p => p.id === pattern.id);
        if (existingIndex >= 0) {
            patterns[existingIndex] = pattern;
        } else {
            pattern.id = `custom-${Date.now()}`;
            patterns.push(pattern);
        }

        await this._context.globalState.update('customFailurePatterns', patterns);
        vscode.window.showInformationMessage(`Pattern "${pattern.name}" saved successfully`);
        await this._loadPatterns();
    }

    private async _deletePattern(id: string) {
        const patterns = this._context.globalState.get<CustomPattern[]>('customFailurePatterns', []);
        const filtered = patterns.filter(p => p.id !== id);
        await this._context.globalState.update('customFailurePatterns', filtered);
        vscode.window.showInformationMessage('Pattern deleted');
        await this._loadPatterns();
    }

    private async _togglePattern(id: string) {
        const patterns = this._context.globalState.get<CustomPattern[]>('customFailurePatterns', []);
        const pattern = patterns.find(p => p.id === id);
        if (pattern) {
            pattern.enabled = !pattern.enabled;
            await this._context.globalState.update('customFailurePatterns', patterns);
            await this._loadPatterns();
        }
    }

    private async _duplicatePattern(id: string) {
        const patterns = this._context.globalState.get<CustomPattern[]>('customFailurePatterns', []);
        const pattern = patterns.find(p => p.id === id);
        if (pattern) {
            const newPattern: CustomPattern = {
                ...pattern,
                id: `custom-${Date.now()}`,
                name: `${pattern.name} (Copy)`,
                matchCount: 0,
                lastMatched: undefined
            };
            patterns.push(newPattern);
            await this._context.globalState.update('customFailurePatterns', patterns);
            vscode.window.showInformationMessage(`Duplicated pattern as "${newPattern.name}"`);
            await this._loadPatterns();
        }
    }

    private _testPattern(pattern: Partial<CustomPattern>, testText: string) {
        const result: PatternTestResult = {
            matched: false,
            matches: [],
            groups: []
        };

        try {
            if (pattern.isRegex) {
                const flags = pattern.caseSensitive ? 'g' : 'gi';
                const regex = new RegExp(pattern.pattern || '', flags);
                let match;
                while ((match = regex.exec(testText)) !== null) {
                    result.matched = true;
                    result.matches.push(match[0]);
                    if (match.groups) {
                        result.groups.push(match.groups);
                    }
                    // Prevent infinite loops for zero-length matches
                    if (match.index === regex.lastIndex) {
                        regex.lastIndex++;
                    }
                }
            } else {
                const searchText = pattern.caseSensitive ? testText : testText.toLowerCase();
                const searchPattern = pattern.caseSensitive ? (pattern.pattern || '') : (pattern.pattern || '').toLowerCase();
                let index = 0;
                while ((index = searchText.indexOf(searchPattern, index)) !== -1) {
                    result.matched = true;
                    result.matches.push(testText.substring(index, index + searchPattern.length));
                    index += searchPattern.length;
                }
            }
        } catch (error) {
            result.error = `Invalid pattern: ${error}`;
        }

        this._panel.webview.postMessage({ command: 'testResult', result });
    }

    private async _importPatterns() {
        const uri = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'JSON': ['json'] },
            title: 'Import Custom Patterns'
        });

        if (uri && uri[0]) {
            try {
                const content = await vscode.workspace.fs.readFile(uri[0]);
                const imported = JSON.parse(Buffer.from(content).toString('utf-8'));
                
                if (!Array.isArray(imported)) {
                    throw new Error('Invalid format: expected array of patterns');
                }

                const patterns = this._context.globalState.get<CustomPattern[]>('customFailurePatterns', []);
                
                for (const p of imported) {
                    p.id = `custom-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
                    patterns.push(p);
                }

                await this._context.globalState.update('customFailurePatterns', patterns);
                vscode.window.showInformationMessage(`Imported ${imported.length} patterns`);
                await this._loadPatterns();
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to import: ${error}`);
            }
        }
    }

    private async _exportPatterns() {
        const patterns = this._context.globalState.get<CustomPattern[]>('customFailurePatterns', []);
        
        if (patterns.length === 0) {
            vscode.window.showWarningMessage('No patterns to export');
            return;
        }

        const uri = await vscode.window.showSaveDialog({
            filters: { 'JSON': ['json'] },
            defaultUri: vscode.Uri.file('amplify-custom-patterns.json'),
            title: 'Export Custom Patterns'
        });

        if (uri) {
            const content = JSON.stringify(patterns, null, 2);
            await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
            vscode.window.showInformationMessage(`Exported ${patterns.length} patterns to ${uri.fsPath}`);
        }
    }

    private _loadPresets() {
        const presets = [
            {
                id: 'eslint-errors',
                name: 'ESLint Errors',
                description: 'Catches ESLint rule violations',
                pattern: '\\d+:\\d+\\s+error\\s+(.+?)\\s+(@?[\\w/-]+)',
                category: 'error',
                rootCause: 'ESLint rule violation',
                suggestedFixes: ['Fix the ESLint errors in your code', 'Add // eslint-disable-next-line for specific cases', 'Update .eslintrc to modify rules']
            },
            {
                id: 'typescript-errors',
                name: 'TypeScript Errors',
                description: 'Catches TypeScript compilation errors (TS####)',
                pattern: 'error TS(\\d+):\\s*(.+)',
                category: 'error',
                rootCause: 'TypeScript compilation error',
                suggestedFixes: ['Fix the TypeScript type errors', 'Add proper type annotations', 'Use type assertions where appropriate']
            },
            {
                id: 'webpack-errors',
                name: 'Webpack Errors',
                description: 'Catches Webpack module resolution failures',
                pattern: "Module not found:\\s*Error:\\s*Can't resolve '([^']+)'",
                category: 'error',
                rootCause: 'Missing module or incorrect import path',
                suggestedFixes: ['Install the missing package', 'Fix the import path', 'Check for typos in module name']
            },
            {
                id: 'npm-peer-deps',
                name: 'NPM Peer Dependencies',
                description: 'Catches peer dependency conflicts',
                pattern: 'npm ERR! peer dep missing:\\s*(.+)',
                category: 'error',
                rootCause: 'Peer dependency not satisfied',
                suggestedFixes: ['Install the required peer dependency', 'Use --legacy-peer-deps flag', 'Update package versions for compatibility']
            },
            {
                id: 'memory-heap',
                name: 'JavaScript Heap OOM',
                description: 'Detects JavaScript heap out of memory',
                pattern: 'FATAL ERROR: (CALL_AND_RETRY_LAST|Reached heap limit) Allocation failed - JavaScript heap out of memory',
                category: 'error',
                rootCause: 'Build process ran out of memory',
                suggestedFixes: ['Increase Node.js heap size: NODE_OPTIONS=--max-old-space-size=8192', 'Optimize build to reduce memory usage', 'Split builds into smaller chunks']
            },
            {
                id: 'next-build-error',
                name: 'Next.js Build Error',
                description: 'Catches Next.js specific build failures',
                pattern: 'Error: Build optimization failed',
                category: 'error',
                rootCause: 'Next.js build optimization failure',
                suggestedFixes: ['Check for circular dependencies', 'Review dynamic imports', 'Ensure all pages export valid components']
            },
            {
                id: 'amplify-timeout',
                name: 'Amplify Build Timeout',
                description: 'Detects when builds exceed time limit',
                pattern: 'Build timeout|exceeded the maximum allowed build duration',
                category: 'error',
                rootCause: 'Build exceeded the maximum allowed time',
                suggestedFixes: ['Optimize build process for speed', 'Enable build caching', 'Consider splitting into smaller builds']
            },
            {
                id: 'env-undefined',
                name: 'Undefined Environment Variable',
                description: 'Catches usage of undefined env vars at runtime',
                pattern: "TypeError: Cannot read propert(y|ies) of undefined \\(reading '([^']+)'\\)|process\\.env\\.(\\w+) is undefined",
                category: 'error',
                rootCause: 'Environment variable not defined',
                suggestedFixes: ['Add the missing environment variable in Amplify Console', 'Provide a fallback value in code', 'Check variable name spelling']
            },
            {
                id: 'deprecation-warning',
                name: 'Deprecation Warnings',
                description: 'Captures deprecation notices',
                pattern: '\\(node:\\d+\\) \\[DEP\\d+\\] DeprecationWarning: (.+)',
                category: 'warning',
                rootCause: 'Using deprecated Node.js or package features',
                suggestedFixes: ['Update code to use non-deprecated APIs', 'Upgrade affected packages', 'Check migration guides']
            },
            {
                id: 'vite-errors',
                name: 'Vite Build Errors',
                description: 'Catches Vite-specific build issues',
                pattern: '\\[vite\\]:\\s*(Internal server error|Build failed)',
                category: 'error',
                rootCause: 'Vite build or server error',
                suggestedFixes: ['Check Vite configuration', 'Ensure dependencies are compatible', 'Review import statements for errors']
            }
        ];

        this._panel.webview.postMessage({ command: 'presetsLoaded', presets });
    }

    private async _addPreset(presetId: string) {
        const presets: Record<string, Omit<CustomPattern, 'id' | 'enabled' | 'matchCount' | 'lastMatched'>> = {
            'eslint-errors': {
                name: 'ESLint Errors',
                pattern: '\\d+:\\d+\\s+error\\s+(.+?)\\s+(@?[\\w/-]+)',
                isRegex: true,
                caseSensitive: false,
                category: 'error',
                rootCause: 'ESLint rule violation in source code',
                suggestedFixes: ['Fix the ESLint errors in your code', 'Add // eslint-disable-next-line for specific cases', 'Update .eslintrc to modify rules']
            },
            'typescript-errors': {
                name: 'TypeScript Errors',
                pattern: 'error TS(\\d+):\\s*(.+)',
                isRegex: true,
                caseSensitive: false,
                category: 'error',
                rootCause: 'TypeScript compilation error',
                suggestedFixes: ['Fix the TypeScript type errors', 'Add proper type annotations', 'Use type assertions where appropriate']
            },
            'webpack-errors': {
                name: 'Webpack Module Not Found',
                pattern: "Module not found:\\s*Error:\\s*Can't resolve '([^']+)'",
                isRegex: true,
                caseSensitive: false,
                category: 'error',
                rootCause: 'Missing module or incorrect import path',
                suggestedFixes: ['Install the missing package: npm install <package>', 'Fix the import path', 'Check for typos in module name']
            },
            'npm-peer-deps': {
                name: 'NPM Peer Dependencies',
                pattern: 'npm ERR! peer dep missing:\\s*(.+)',
                isRegex: true,
                caseSensitive: false,
                category: 'error',
                rootCause: 'Peer dependency not satisfied',
                suggestedFixes: ['Install the required peer dependency', 'Use --legacy-peer-deps flag', 'Update package versions for compatibility']
            },
            'memory-heap': {
                name: 'JavaScript Heap Out of Memory',
                pattern: 'FATAL ERROR: (CALL_AND_RETRY_LAST|Reached heap limit) Allocation failed - JavaScript heap out of memory',
                isRegex: true,
                caseSensitive: false,
                category: 'error',
                rootCause: 'Build process ran out of memory',
                suggestedFixes: ['Add NODE_OPTIONS=--max-old-space-size=8192 to environment', 'Optimize build to reduce memory usage', 'Split builds into smaller chunks']
            },
            'next-build-error': {
                name: 'Next.js Build Error',
                pattern: 'Error: Build optimization failed',
                isRegex: false,
                caseSensitive: false,
                category: 'error',
                rootCause: 'Next.js build optimization failure',
                suggestedFixes: ['Check for circular dependencies', 'Review dynamic imports', 'Ensure all pages export valid components']
            },
            'amplify-timeout': {
                name: 'Amplify Build Timeout',
                pattern: 'Build timeout|exceeded the maximum allowed build duration',
                isRegex: true,
                caseSensitive: false,
                category: 'error',
                rootCause: 'Build exceeded the maximum allowed time',
                suggestedFixes: ['Optimize build process for speed', 'Enable build caching', 'Consider splitting into smaller builds']
            },
            'env-undefined': {
                name: 'Undefined Environment Variable',
                pattern: "TypeError: Cannot read propert(y|ies) of undefined|process\\.env\\.(\\w+) is undefined",
                isRegex: true,
                caseSensitive: false,
                category: 'error',
                rootCause: 'Environment variable accessed but not defined',
                suggestedFixes: ['Add the missing environment variable in Amplify Console', 'Provide a fallback value in code', 'Check variable name spelling']
            },
            'deprecation-warning': {
                name: 'Node.js Deprecation Warning',
                pattern: '\\(node:\\d+\\) \\[DEP\\d+\\] DeprecationWarning: (.+)',
                isRegex: true,
                caseSensitive: false,
                category: 'warning',
                rootCause: 'Using deprecated Node.js or package features',
                suggestedFixes: ['Update code to use non-deprecated APIs', 'Upgrade affected packages', 'Check migration guides']
            },
            'vite-errors': {
                name: 'Vite Build Error',
                pattern: '\\[vite\\]:\\s*(Internal server error|Build failed)',
                isRegex: true,
                caseSensitive: false,
                category: 'error',
                rootCause: 'Vite build or development server error',
                suggestedFixes: ['Check Vite configuration', 'Ensure dependencies are compatible', 'Review import statements for errors']
            }
        };

        const preset = presets[presetId];
        if (!preset) {
            vscode.window.showErrorMessage('Unknown preset');
            return;
        }

        const patterns = this._context.globalState.get<CustomPattern[]>('customFailurePatterns', []);
        
        // Check if already exists
        const exists = patterns.some(p => p.name === preset.name);
        if (exists) {
            vscode.window.showWarningMessage(`Pattern "${preset.name}" already exists`);
            return;
        }

        const newPattern: CustomPattern = {
            ...preset,
            id: `preset-${presetId}-${Date.now()}`,
            enabled: true
        };

        patterns.push(newPattern);
        await this._context.globalState.update('customFailurePatterns', patterns);
        vscode.window.showInformationMessage(`Added preset pattern: ${preset.name}`);
        await this._loadPatterns();
    }

    // Public method to get patterns for use in diagnosis
    public static getPatterns(context: vscode.ExtensionContext): CustomPattern[] {
        return context.globalState.get<CustomPattern[]>('customFailurePatterns', [])
            .filter(p => p.enabled);
    }

    // Public method to match patterns against log text
    public static matchPatterns(context: vscode.ExtensionContext, logText: string): Array<{
        pattern: CustomPattern;
        matches: string[];
    }> {
        const patterns = CustomPatternsPanel.getPatterns(context);
        const results: Array<{ pattern: CustomPattern; matches: string[] }> = [];

        for (const pattern of patterns) {
            try {
                const matches: string[] = [];
                
                if (pattern.isRegex) {
                    const flags = pattern.caseSensitive ? 'g' : 'gi';
                    const regex = new RegExp(pattern.pattern, flags);
                    let match;
                    while ((match = regex.exec(logText)) !== null) {
                        matches.push(match[0]);
                        if (match.index === regex.lastIndex) {
                            regex.lastIndex++;
                        }
                    }
                } else {
                    const searchText = pattern.caseSensitive ? logText : logText.toLowerCase();
                    const searchPattern = pattern.caseSensitive ? pattern.pattern : pattern.pattern.toLowerCase();
                    let index = 0;
                    while ((index = searchText.indexOf(searchPattern, index)) !== -1) {
                        matches.push(logText.substring(index, index + searchPattern.length));
                        index += searchPattern.length;
                    }
                }

                if (matches.length > 0) {
                    results.push({ pattern, matches });
                }
            } catch {
                // Skip invalid patterns
            }
        }

        return results;
    }

    private _getHtmlContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Custom Failure Patterns</title>
    <style>
        :root {
            --bg-color: var(--vscode-editor-background);
            --text-color: var(--vscode-editor-foreground);
            --border-color: var(--vscode-panel-border);
            --card-bg: var(--vscode-editorWidget-background);
            --input-bg: var(--vscode-input-background);
            --input-fg: var(--vscode-input-foreground);
            --btn-bg: var(--vscode-button-background);
            --btn-fg: var(--vscode-button-foreground);
            --success: #4caf50;
            --warning: #ff9800;
            --error: #f44336;
            --info: #2196f3;
        }
        
        * { box-sizing: border-box; }
        
        body {
            font-family: var(--vscode-font-family);
            color: var(--text-color);
            background: var(--bg-color);
            padding: 20px;
            margin: 0;
        }
        
        h1, h2, h3 { margin-top: 0; }
        
        .header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 24px;
        }
        
        .header-text h1 { margin-bottom: 8px; }
        .subtitle { color: var(--vscode-descriptionForeground); margin: 0; }
        
        .toolbar {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
        }
        
        button {
            background: var(--btn-bg);
            color: var(--btn-fg);
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            display: inline-flex;
            align-items: center;
            gap: 6px;
        }
        
        button:hover { opacity: 0.9; }
        button:disabled { opacity: 0.5; cursor: not-allowed; }
        button.secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        button.small { padding: 4px 8px; font-size: 11px; }
        button.danger { background: var(--error); }
        
        .tabs {
            display: flex;
            gap: 0;
            border-bottom: 1px solid var(--border-color);
            margin-bottom: 24px;
        }
        
        .tab {
            padding: 12px 24px;
            cursor: pointer;
            border: none;
            background: none;
            color: var(--vscode-descriptionForeground);
            border-bottom: 2px solid transparent;
            margin-bottom: -1px;
        }
        
        .tab.active {
            color: var(--text-color);
            border-bottom-color: var(--btn-bg);
        }
        
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        
        .patterns-list {
            display: flex;
            flex-direction: column;
            gap: 16px;
        }
        
        .pattern-card {
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 16px;
        }
        
        .pattern-card.disabled { opacity: 0.6; }
        
        .pattern-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
        }
        
        .pattern-title {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .pattern-name { font-weight: 600; font-size: 14px; }
        
        .badge {
            padding: 2px 8px;
            border-radius: 10px;
            font-size: 10px;
            font-weight: 500;
        }
        
        .badge.error { background: var(--error); color: white; }
        .badge.warning { background: var(--warning); color: black; }
        .badge.info { background: var(--info); color: white; }
        .badge.regex { background: #9c27b0; color: white; }
        
        .pattern-actions {
            display: flex;
            gap: 8px;
        }
        
        .pattern-details {
            font-size: 12px;
            margin-bottom: 12px;
        }
        
        .pattern-code {
            background: var(--input-bg);
            padding: 8px 12px;
            border-radius: 4px;
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
            overflow-x: auto;
            margin: 8px 0;
        }
        
        .pattern-meta {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 8px;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }
        
        .form-section {
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 24px;
        }
        
        .form-section h3 { margin-bottom: 16px; }
        
        .form-row {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 16px;
            margin-bottom: 16px;
        }
        
        .form-group { margin-bottom: 16px; }
        .form-group:last-child { margin-bottom: 0; }
        
        .form-group label {
            display: block;
            margin-bottom: 6px;
            font-size: 13px;
            font-weight: 500;
        }
        
        .form-group input, .form-group select, .form-group textarea {
            width: 100%;
            padding: 8px 12px;
            border: 1px solid var(--border-color);
            border-radius: 4px;
            background: var(--input-bg);
            color: var(--input-fg);
            font-size: 13px;
            font-family: inherit;
        }
        
        .form-group textarea {
            min-height: 80px;
            resize: vertical;
            font-family: var(--vscode-editor-font-family);
        }
        
        .form-group input:focus, .form-group select:focus, .form-group textarea:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
        }
        
        .checkbox-group {
            display: flex;
            gap: 16px;
        }
        
        .checkbox-label {
            display: flex;
            align-items: center;
            gap: 6px;
            cursor: pointer;
            font-size: 13px;
        }
        
        .checkbox-label input {
            width: auto;
            margin: 0;
        }
        
        .hint {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
        }
        
        .test-section {
            margin-top: 20px;
            padding-top: 20px;
            border-top: 1px solid var(--border-color);
        }
        
        .test-result {
            margin-top: 12px;
            padding: 12px;
            border-radius: 4px;
        }
        
        .test-result.success {
            background: rgba(76, 175, 80, 0.1);
            border: 1px solid var(--success);
        }
        
        .test-result.fail {
            background: rgba(244, 67, 54, 0.1);
            border: 1px solid var(--error);
        }
        
        .test-result.error {
            background: rgba(244, 67, 54, 0.2);
            border: 1px solid var(--error);
        }
        
        .match-highlight {
            background: rgba(255, 235, 59, 0.3);
            padding: 2px 4px;
            border-radius: 2px;
            font-family: var(--vscode-editor-font-family);
        }
        
        .presets-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
            gap: 12px;
        }
        
        .preset-card {
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 16px;
        }
        
        .preset-card h4 { margin: 0 0 8px 0; font-size: 14px; }
        .preset-card p { margin: 0 0 12px 0; font-size: 12px; color: var(--vscode-descriptionForeground); }
        
        .empty-state {
            text-align: center;
            padding: 60px 20px;
            color: var(--vscode-descriptionForeground);
        }
        
        .empty-state-icon { font-size: 48px; margin-bottom: 16px; }
        
        .toggle-switch {
            position: relative;
            width: 40px;
            height: 20px;
        }
        
        .toggle-switch input {
            opacity: 0;
            width: 0;
            height: 0;
        }
        
        .toggle-slider {
            position: absolute;
            cursor: pointer;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: var(--border-color);
            transition: .3s;
            border-radius: 20px;
        }
        
        .toggle-slider:before {
            position: absolute;
            content: "";
            height: 16px;
            width: 16px;
            left: 2px;
            bottom: 2px;
            background-color: white;
            transition: .3s;
            border-radius: 50%;
        }
        
        .toggle-switch input:checked + .toggle-slider {
            background-color: var(--success);
        }
        
        .toggle-switch input:checked + .toggle-slider:before {
            transform: translateX(20px);
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="header-text">
            <h1>🎯 Custom Failure Patterns</h1>
            <p class="subtitle">Define custom patterns to detect specific errors in your build logs</p>
        </div>
        <div class="toolbar">
            <button onclick="showTab('create')">➕ New Pattern</button>
            <button class="secondary" onclick="importPatterns()">📥 Import</button>
            <button class="secondary" onclick="exportPatterns()">📤 Export</button>
        </div>
    </div>
    
    <div class="tabs">
        <button class="tab active" data-tab="patterns" onclick="showTab('patterns')">📋 My Patterns</button>
        <button class="tab" data-tab="create" onclick="showTab('create')">➕ Create/Edit</button>
        <button class="tab" data-tab="presets" onclick="showTab('presets')">📦 Presets</button>
    </div>
    
    <!-- Patterns List Tab -->
    <div id="patterns-tab" class="tab-content active">
        <div id="patterns-list" class="patterns-list">
            <div class="empty-state">
                <div class="empty-state-icon">🎯</div>
                <p>No custom patterns defined yet</p>
                <p style="margin-top: 8px;">Create your own or start with presets</p>
                <button onclick="showTab('presets')" style="margin-top: 16px;">📦 Browse Presets</button>
            </div>
        </div>
    </div>
    
    <!-- Create/Edit Tab -->
    <div id="create-tab" class="tab-content">
        <div class="form-section">
            <h3 id="form-title">Create New Pattern</h3>
            <input type="hidden" id="pattern-id" value="">
            
            <div class="form-row">
                <div class="form-group">
                    <label>Pattern Name *</label>
                    <input type="text" id="pattern-name" placeholder="e.g., Custom ESLint Error">
                </div>
                <div class="form-group">
                    <label>Category *</label>
                    <select id="pattern-category">
                        <option value="error">🔴 Error</option>
                        <option value="warning">🟡 Warning</option>
                        <option value="info">🔵 Info</option>
                    </select>
                </div>
            </div>
            
            <div class="form-group">
                <label>Pattern *</label>
                <input type="text" id="pattern-text" placeholder="Enter text or regex pattern to match">
                <div class="hint">Use capturing groups like (\\w+) to extract values</div>
            </div>
            
            <div class="form-group">
                <div class="checkbox-group">
                    <label class="checkbox-label">
                        <input type="checkbox" id="pattern-regex" checked>
                        Regular Expression
                    </label>
                    <label class="checkbox-label">
                        <input type="checkbox" id="pattern-case">
                        Case Sensitive
                    </label>
                </div>
            </div>
            
            <div class="form-group">
                <label>Root Cause Description *</label>
                <input type="text" id="pattern-cause" placeholder="What causes this error?">
            </div>
            
            <div class="form-group">
                <label>Suggested Fixes (one per line)</label>
                <textarea id="pattern-fixes" placeholder="Fix suggestion 1
Fix suggestion 2
Fix suggestion 3"></textarea>
            </div>
            
            <div style="display: flex; gap: 8px; margin-top: 20px;">
                <button onclick="savePattern()">💾 Save Pattern</button>
                <button class="secondary" onclick="clearForm()">🗑️ Clear</button>
            </div>
            
            <div class="test-section">
                <h3>🧪 Test Pattern</h3>
                <div class="form-group">
                    <label>Test Text</label>
                    <textarea id="test-text" placeholder="Paste sample log output here to test your pattern..."></textarea>
                </div>
                <button onclick="testPattern()">▶️ Test Pattern</button>
                <div id="test-result"></div>
            </div>
        </div>
    </div>
    
    <!-- Presets Tab -->
    <div id="presets-tab" class="tab-content">
        <p style="margin-bottom: 16px;">Pre-configured patterns for common build errors. Click to add to your patterns.</p>
        <div id="presets-grid" class="presets-grid"></div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let patterns = [];
        let currentEditId = null;
        
        // Tab switching
        function showTab(tabName) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
            
            document.querySelector(\`[data-tab="\${tabName}"]\`).classList.add('active');
            document.getElementById(\`\${tabName}-tab\`).classList.add('active');
            
            if (tabName === 'presets') {
                vscode.postMessage({ command: 'loadPresets' });
            }
            
            if (tabName === 'create' && !currentEditId) {
                clearForm();
            }
        }
        
        // Load patterns
        function loadPatterns() {
            vscode.postMessage({ command: 'loadPatterns' });
        }
        
        // Render patterns list
        function renderPatterns() {
            const container = document.getElementById('patterns-list');
            
            if (patterns.length === 0) {
                container.innerHTML = \`
                    <div class="empty-state">
                        <div class="empty-state-icon">🎯</div>
                        <p>No custom patterns defined yet</p>
                        <p style="margin-top: 8px;">Create your own or start with presets</p>
                        <button onclick="showTab('presets')" style="margin-top: 16px;">📦 Browse Presets</button>
                    </div>
                \`;
                return;
            }
            
            container.innerHTML = patterns.map(p => \`
                <div class="pattern-card \${p.enabled ? '' : 'disabled'}">
                    <div class="pattern-header">
                        <div class="pattern-title">
                            <label class="toggle-switch">
                                <input type="checkbox" \${p.enabled ? 'checked' : ''} onchange="togglePattern('\${p.id}')">
                                <span class="toggle-slider"></span>
                            </label>
                            <span class="pattern-name">\${escapeHtml(p.name)}</span>
                            <span class="badge \${p.category}">\${p.category.toUpperCase()}</span>
                            \${p.isRegex ? '<span class="badge regex">REGEX</span>' : ''}
                        </div>
                        <div class="pattern-actions">
                            <button class="small secondary" onclick="editPattern('\${p.id}')">✏️ Edit</button>
                            <button class="small secondary" onclick="duplicatePattern('\${p.id}')">📋 Copy</button>
                            <button class="small danger" onclick="deletePattern('\${p.id}')">🗑️</button>
                        </div>
                    </div>
                    <div class="pattern-details">
                        <div class="pattern-code">\${escapeHtml(p.pattern)}</div>
                        <strong>Root Cause:</strong> \${escapeHtml(p.rootCause)}
                        \${p.suggestedFixes && p.suggestedFixes.length > 0 ? \`
                            <br><strong>Fixes:</strong> \${p.suggestedFixes.map(f => escapeHtml(f)).join(' • ')}
                        \` : ''}
                    </div>
                    <div class="pattern-meta">
                        <span>\${p.caseSensitive ? '🔤 Case sensitive' : '🔡 Case insensitive'}</span>
                        \${p.matchCount ? \`<span>📊 Matched \${p.matchCount} times</span>\` : ''}
                    </div>
                </div>
            \`).join('');
        }
        
        // Edit pattern
        function editPattern(id) {
            const pattern = patterns.find(p => p.id === id);
            if (!pattern) return;
            
            currentEditId = id;
            document.getElementById('form-title').textContent = 'Edit Pattern';
            document.getElementById('pattern-id').value = id;
            document.getElementById('pattern-name').value = pattern.name;
            document.getElementById('pattern-category').value = pattern.category;
            document.getElementById('pattern-text').value = pattern.pattern;
            document.getElementById('pattern-regex').checked = pattern.isRegex;
            document.getElementById('pattern-case').checked = pattern.caseSensitive;
            document.getElementById('pattern-cause').value = pattern.rootCause;
            document.getElementById('pattern-fixes').value = (pattern.suggestedFixes || []).join('\\n');
            
            showTab('create');
        }
        
        // Save pattern
        function savePattern() {
            const name = document.getElementById('pattern-name').value.trim();
            const pattern = document.getElementById('pattern-text').value.trim();
            const cause = document.getElementById('pattern-cause').value.trim();
            
            if (!name || !pattern || !cause) {
                alert('Please fill in all required fields (Name, Pattern, Root Cause)');
                return;
            }
            
            const fixes = document.getElementById('pattern-fixes').value
                .split('\\n')
                .map(f => f.trim())
                .filter(f => f.length > 0);
            
            const patternData = {
                id: document.getElementById('pattern-id').value || null,
                name,
                pattern,
                isRegex: document.getElementById('pattern-regex').checked,
                caseSensitive: document.getElementById('pattern-case').checked,
                category: document.getElementById('pattern-category').value,
                rootCause: cause,
                suggestedFixes: fixes,
                enabled: true
            };
            
            vscode.postMessage({ command: 'savePattern', pattern: patternData });
            clearForm();
            showTab('patterns');
        }
        
        // Clear form
        function clearForm() {
            currentEditId = null;
            document.getElementById('form-title').textContent = 'Create New Pattern';
            document.getElementById('pattern-id').value = '';
            document.getElementById('pattern-name').value = '';
            document.getElementById('pattern-category').value = 'error';
            document.getElementById('pattern-text').value = '';
            document.getElementById('pattern-regex').checked = true;
            document.getElementById('pattern-case').checked = false;
            document.getElementById('pattern-cause').value = '';
            document.getElementById('pattern-fixes').value = '';
            document.getElementById('test-text').value = '';
            document.getElementById('test-result').innerHTML = '';
        }
        
        // Delete pattern
        function deletePattern(id) {
            if (confirm('Delete this pattern?')) {
                vscode.postMessage({ command: 'deletePattern', id });
            }
        }
        
        // Toggle pattern
        function togglePattern(id) {
            vscode.postMessage({ command: 'togglePattern', id });
        }
        
        // Duplicate pattern
        function duplicatePattern(id) {
            vscode.postMessage({ command: 'duplicatePattern', id });
        }
        
        // Test pattern
        function testPattern() {
            const pattern = {
                pattern: document.getElementById('pattern-text').value,
                isRegex: document.getElementById('pattern-regex').checked,
                caseSensitive: document.getElementById('pattern-case').checked
            };
            const testText = document.getElementById('test-text').value;
            
            if (!pattern.pattern || !testText) {
                alert('Please enter both a pattern and test text');
                return;
            }
            
            vscode.postMessage({ command: 'testPattern', pattern, testText });
        }
        
        // Import/Export
        function importPatterns() {
            vscode.postMessage({ command: 'importPatterns' });
        }
        
        function exportPatterns() {
            vscode.postMessage({ command: 'exportPatterns' });
        }
        
        // Add preset
        function addPreset(presetId) {
            vscode.postMessage({ command: 'addPreset', presetId });
        }
        
        // Render presets
        function renderPresets(presets) {
            const container = document.getElementById('presets-grid');
            container.innerHTML = presets.map(p => \`
                <div class="preset-card">
                    <h4>\${escapeHtml(p.name)}</h4>
                    <p>\${escapeHtml(p.description)}</p>
                    <span class="badge \${p.category}">\${p.category.toUpperCase()}</span>
                    <button class="small" style="margin-top: 12px;" onclick="addPreset('\${p.id}')">➕ Add</button>
                </div>
            \`).join('');
        }
        
        // Escape HTML
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text || '';
            return div.innerHTML;
        }
        
        // Message handler
        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.command) {
                case 'patternsLoaded':
                    patterns = message.patterns;
                    renderPatterns();
                    break;
                    
                case 'presetsLoaded':
                    renderPresets(message.presets);
                    break;
                    
                case 'testResult':
                    const result = message.result;
                    const resultDiv = document.getElementById('test-result');
                    
                    if (result.error) {
                        resultDiv.innerHTML = \`<div class="test-result error">❌ \${escapeHtml(result.error)}</div>\`;
                    } else if (result.matched) {
                        resultDiv.innerHTML = \`
                            <div class="test-result success">
                                ✅ Pattern matched <strong>\${result.matches.length}</strong> time(s)
                                <div style="margin-top: 8px;">
                                    <strong>Matches:</strong>
                                    \${result.matches.slice(0, 5).map(m => \`<span class="match-highlight">\${escapeHtml(m)}</span>\`).join(' ')}
                                    \${result.matches.length > 5 ? \`<em>... and \${result.matches.length - 5} more</em>\` : ''}
                                </div>
                            </div>
                        \`;
                    } else {
                        resultDiv.innerHTML = \`<div class="test-result fail">⚠️ No matches found</div>\`;
                    }
                    break;
            }
        });
        
        // Initial load
        loadPatterns();
    </script>
</body>
</html>`;
    }
}
