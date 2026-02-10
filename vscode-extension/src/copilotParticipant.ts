import * as vscode from 'vscode';
import { AmplifyMonitorCli } from './cli';

interface BuildLogContext {
    appId: string;
    appName: string;
    branch: string;
    jobId: string;
    status: string;
    startTime?: string;
    endTime?: string;
    logs: string;
    issues: Array<{
        pattern: string;
        rootCause: string;
        suggestedFixes: string[];
    }>;
}

export class AmplifyCopilotParticipant {
    private static readonly PARTICIPANT_ID = 'amplify-monitor.amplify';
    private cli: AmplifyMonitorCli;
    private lastBuildContext: BuildLogContext | null = null;

    constructor(cli: AmplifyMonitorCli) {
        this.cli = cli;
    }

    register(context: vscode.ExtensionContext): vscode.Disposable[] {
        const disposables: vscode.Disposable[] = [];

        // Register the chat participant
        const participant = vscode.chat.createChatParticipant(
            AmplifyCopilotParticipant.PARTICIPANT_ID,
            this.handleChatRequest.bind(this)
        );

        participant.iconPath = new vscode.ThemeIcon('cloud');
        
        // Add follow-up provider
        participant.followupProvider = {
            provideFollowups: this.provideFollowups.bind(this)
        };

        disposables.push(participant);

        // Register commands for chat integration
        disposables.push(
            vscode.commands.registerCommand('amplify-monitor.fetchLogsForChat', async () => {
                return this.fetchLatestFailedBuildLogs();
            }),
            vscode.commands.registerCommand('amplify-monitor.getLastBuildContext', () => {
                return this.lastBuildContext;
            })
        );

        return disposables;
    }

    private async handleChatRequest(
        request: vscode.ChatRequest,
        context: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> {
        const query = request.prompt.toLowerCase();

        try {
            // Handle different intents
            if (query.includes('diagnose') || query.includes('what failed') || query.includes('build error') || query.includes('why did') || query.includes('analyze')) {
                return await this.handleDiagnoseRequest(request, stream, token);
            } else if (query.includes('fix') || query.includes('resolve') || query.includes('solve')) {
                return await this.handleFixRequest(request, stream, token);
            } else if (query.includes('logs') || query.includes('show log') || query.includes('get log')) {
                return await this.handleLogsRequest(request, stream, token);
            } else if (query.includes('status') || query.includes('builds') || query.includes('jobs')) {
                return await this.handleStatusRequest(request, stream, token);
            } else {
                // Default: try to be helpful with context
                return await this.handleGeneralRequest(request, stream, token);
            }
        } catch (error) {
            stream.markdown(`❌ Error: ${error instanceof Error ? error.message : 'Unknown error occurred'}`);
            return { metadata: { error: true } };
        }
    }

    private async handleDiagnoseRequest(
        request: vscode.ChatRequest,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> {
        stream.progress('Fetching latest failed build...');

        const buildContext = await this.fetchLatestFailedBuildLogs();
        
        if (!buildContext) {
            stream.markdown('No failed builds found. Your Amplify apps are healthy! ✅');
            return { metadata: { success: true, noFailures: true } };
        }

        this.lastBuildContext = buildContext;

        stream.markdown(`## 🔴 Build Failure Analysis\n\n`);
        stream.markdown(`**App:** ${buildContext.appName} (\`${buildContext.appId}\`)\n`);
        stream.markdown(`**Branch:** \`${buildContext.branch}\`\n`);
        stream.markdown(`**Job:** #${buildContext.jobId}\n`);
        if (buildContext.startTime) {
            stream.markdown(`**Time:** ${buildContext.startTime}\n`);
        }
        stream.markdown(`\n---\n\n`);

        if (buildContext.issues.length > 0) {
            stream.markdown(`### Issues Detected (${buildContext.issues.length})\n\n`);
            
            for (let i = 0; i < buildContext.issues.length; i++) {
                const issue = buildContext.issues[i];
                stream.markdown(`#### ${i + 1}. ${issue.pattern.replace(/_/g, ' ')}\n\n`);
                stream.markdown(`**Root Cause:** ${issue.rootCause}\n\n`);
                stream.markdown(`**Suggested Fixes:**\n`);
                for (const fix of issue.suggestedFixes) {
                    stream.markdown(`- ${fix}\n`);
                }
                stream.markdown(`\n`);
            }
        }

        // Include relevant log excerpt
        stream.markdown(`### Build Log Excerpt\n\n`);
        stream.markdown('```\n');
        
        // Extract the most relevant part of the logs (around errors)
        const relevantLogs = this.extractRelevantLogSection(buildContext.logs);
        stream.markdown(relevantLogs);
        stream.markdown('\n```\n\n');

        // Provide the full context for Copilot to work with
        stream.markdown(`*I've analyzed the build logs. Ask me to "fix this" and I'll help you resolve the issues.*`);

        return { 
            metadata: { 
                success: true, 
                buildContext: {
                    appId: buildContext.appId,
                    branch: buildContext.branch,
                    jobId: buildContext.jobId,
                    issueCount: buildContext.issues.length
                }
            } 
        };
    }

    private async handleLogsRequest(
        request: vscode.ChatRequest,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> {
        stream.progress('Fetching build logs...');

        const buildContext = await this.fetchLatestFailedBuildLogs();
        
        if (!buildContext) {
            stream.markdown('No recent failed builds found.');
            return { metadata: { success: true } };
        }

        this.lastBuildContext = buildContext;

        stream.markdown(`## 📋 Build Logs - Job #${buildContext.jobId}\n\n`);
        stream.markdown(`**App:** ${buildContext.appName} | **Branch:** ${buildContext.branch}\n\n`);
        stream.markdown('```\n');
        // Show full logs - no truncation for explicit log requests
        stream.markdown(buildContext.logs);
        stream.markdown('\n```\n');

        return { metadata: { success: true } };
    }

    private async handleFixRequest(
        request: vscode.ChatRequest,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> {
        // Use existing context or fetch new
        if (!this.lastBuildContext) {
            stream.progress('Fetching build context...');
            this.lastBuildContext = await this.fetchLatestFailedBuildLogs();
        }

        if (!this.lastBuildContext) {
            stream.markdown('No build failure context available. Use `@amplify diagnose` first.');
            return { metadata: { success: false } };
        }

        const buildContext = this.lastBuildContext;
        const query = request.prompt.toLowerCase();
        const wantsAutoFix = query.includes('auto') || query.includes('apply');

        // Extract file paths from error logs
        const errorFiles = this.extractErrorFilePaths(buildContext.logs);
        const workspaceFolders = vscode.workspace.workspaceFolders;
        
        // Reference the problematic files so Copilot can access them
        const referencedFiles: vscode.Uri[] = [];
        if (workspaceFolders && errorFiles.length > 0) {
            for (const filePath of errorFiles.slice(0, 5)) { // Limit to 5 files
                try {
                    const fullPath = vscode.Uri.joinPath(workspaceFolders[0].uri, filePath);
                    const doc = await vscode.workspace.openTextDocument(fullPath);
                    stream.reference(doc.uri);
                    referencedFiles.push(doc.uri);
                } catch (e) {
                    // File might not exist locally
                }
            }
        }

        // Provide specific instructions based on detected issues
        const hasCodeError = buildContext.issues.some(i => 
            ['typescript_error', 'eslint_error', 'nextjs_error', 'syntax_error', 'build_command_failed'].includes(i.pattern)
        );

        // For config issues (lock files, node version, etc.), provide buttons
        const hasConfigIssue = buildContext.issues.some(i => 
            ['lock_file_mismatch', 'node_version_mismatch', 'missing_env_var', 'amplify_yml_missing', 'npm_ci_failure', 'eslint_error'].includes(i.pattern)
        );

        if (hasConfigIssue && !wantsAutoFix) {
            stream.markdown(`## 🔧 Fixing Build Issues\n\n`);
            stream.markdown(`Based on the build failure for **${buildContext.appName}** on branch **${buildContext.branch}**:\n\n`);
            
            for (const issue of buildContext.issues) {
                stream.markdown(`### ${issue.pattern.replace(/_/g, ' ')}\n\n`);
                
                // Show buttons for quick actions
                const autoFixResult = await this.attemptAutoFix(issue.pattern, buildContext.logs, stream);
                
                // Also show the detailed fix suggestion
                const codeFixSuggestion = this.getCodeFixForPattern(issue.pattern, buildContext.logs);
                if (codeFixSuggestion) {
                    stream.markdown(codeFixSuggestion);
                }
            }
            
            // Show error context
            stream.markdown(`\n### Error Context from Logs\n\`\`\`\n${this.extractErrorContext(buildContext.logs)}\n\`\`\`\n\n`);
            
            return { metadata: { success: true, errorFiles, hasCodeError, hasConfigIssue } };
        }

        // For code errors OR auto fix mode, provide context that instructs the agent to fix
        if (hasCodeError || wantsAutoFix) {
            const specificError = this.extractSpecificError(buildContext.logs);
            
            // Open the first file with an error so Copilot can see it
            if (referencedFiles.length > 0) {
                try {
                    const doc = await vscode.workspace.openTextDocument(referencedFiles[0]);
                    await vscode.window.showTextDocument(doc, { preview: true });
                } catch (e) {
                    // Ignore
                }
            }
            
            stream.markdown(`## 🔧 Code Fix Required\n\n`);
            stream.markdown(`The build for **${buildContext.appName}** failed with a code error.\n\n`);
            
            if (errorFiles.length > 0) {
                stream.markdown(`**File:** \`${errorFiles[0]}\`\n\n`);
            }
            
            stream.markdown(`**Error:**\n\`\`\`\n${specificError}\n\`\`\`\n\n`);
            
            // Provide the fix instruction that the LLM should follow
            stream.markdown(`---\n\n`);
            stream.markdown(`**Fix this error by correcting the syntax issue in the file above.**\n\n`);
            stream.markdown(`Based on the error message:\n`);
            stream.markdown(`- The error shows \`Expected '{', got ')'\` which indicates a syntax error\n`);
            stream.markdown(`- Check for missing or mismatched braces, parentheses, or brackets\n`);
            stream.markdown(`- Look at the line numbers mentioned in the error\n\n`);
            
            // If in agent mode, the LLM should pick up the referenced file and make edits
            return { 
                metadata: { 
                    success: true, 
                    errorFiles, 
                    hasCodeError: true,
                    needsCodeFix: true,
                    specificError
                } 
            };
        }

        // Fallback - just show the error context
        stream.markdown(`## 🔧 Build Failure Analysis\n\n`);
        stream.markdown(`**App:** ${buildContext.appName} | **Branch:** ${buildContext.branch}\n\n`);
        stream.markdown(`### Error Context\n\`\`\`\n${this.extractErrorContext(buildContext.logs)}\n\`\`\`\n\n`);

        return { metadata: { success: true, errorFiles, hasCodeError, hasConfigIssue } };
    }

    /**
     * Extract file paths from error logs
     */
    private extractErrorFilePaths(logs: string): string[] {
        const filePaths = new Set<string>();
        
        // Common patterns for file paths in error messages
        const patterns = [
            // ./src/path/to/file.tsx
            /\.\/([^\s:]+\.[tj]sx?)/g,
            // src/path/to/file.tsx:line:col
            /(?:^|\s)(src\/[^\s:]+\.[tj]sx?)(?::\d+)?/gm,
            // /codebuild/.../src/path/file.tsx
            /\/(?:codebuild|build)[^\s]*\/(src\/[^\s:]+\.[tj]sx?)/g,
            // Module not found: './path/file'
            /(?:Cannot find|Module not found)[^']*'([^']+)'/g,
            // in ./pages/file.tsx
            /in\s+\.\/([^\s:]+\.[tj]sx?)/g,
            // at path/file.tsx:line
            /at\s+([^\s:]+\.[tj]sx?):\d+/g,
        ];

        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(logs)) !== null) {
                let path = match[1];
                // Clean up the path
                path = path.replace(/^\.\//, '');
                // Skip node_modules
                if (!path.includes('node_modules') && !path.startsWith('/')) {
                    filePaths.add(path);
                }
            }
        }

        return Array.from(filePaths);
    }

    /**
     * Extract the specific error message from logs
     */
    private extractSpecificError(logs: string): string {
        const lines = logs.split('\n');
        const errorLines: string[] = [];
        let capturing = false;
        let captureCount = 0;

        for (const line of lines) {
            // Start capturing at error indicators
            if (/Error:|SyntaxError|TypeError|Expected|Unexpected|Failed to compile/i.test(line)) {
                capturing = true;
                captureCount = 0;
            }

            if (capturing) {
                errorLines.push(line);
                captureCount++;
                
                // Stop after capturing enough context
                if (captureCount > 15) {
                    capturing = false;
                }
            }
        }

        // Return unique error blocks
        return errorLines.slice(0, 20).join('\n');
    }

    private async attemptAutoFix(
        pattern: string,
        logs: string,
        stream: vscode.ChatResponseStream
    ): Promise<{ fixed: boolean; message: string }> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return { fixed: false, message: 'No workspace folder open' };
        }

        const rootPath = workspaceFolders[0].uri.fsPath;

        switch (pattern) {
            case 'lock_file_mismatch':
            case 'multiple_lock_files':
                return await this.fixLockFileMismatch(rootPath, logs, stream);
            
            case 'node_version_mismatch':
                return await this.fixNodeVersionMismatch(rootPath, logs, stream);
            
            case 'missing_env_var':
                return await this.fixMissingEnvVar(rootPath, logs, stream);
            
            case 'eslint_error':
                return await this.fixEslintError(rootPath, logs, stream);
            
            case 'amplify_yml_missing':
                return await this.fixMissingAmplifyYml(rootPath, stream);
            
            default:
                return { fixed: false, message: 'No auto-fix available for this issue' };
        }
    }

    private async fixLockFileMismatch(
        rootPath: string,
        logs: string,
        stream: vscode.ChatResponseStream
    ): Promise<{ fixed: boolean; message: string }> {
        const fs = await import('fs');
        const path = await import('path');

        const pnpmLock = path.join(rootPath, 'pnpm-lock.yaml');
        const yarnLock = path.join(rootPath, 'yarn.lock');
        const npmLock = path.join(rootPath, 'package-lock.json');

        const hasPnpm = fs.existsSync(pnpmLock);
        const hasYarn = fs.existsSync(yarnLock);
        const hasNpm = fs.existsSync(npmLock);

        const lockCount = [hasPnpm, hasYarn, hasNpm].filter(Boolean).length;

        if (lockCount <= 1) {
            return { fixed: false, message: 'No conflicting lock files found' };
        }

        stream.progress('Detecting lock file conflict...');

        // Prefer npm if package-lock.json exists, otherwise keep the first one found
        let toDelete: string[] = [];
        let keeping = '';

        if (hasNpm) {
            keeping = 'package-lock.json (npm)';
            if (hasPnpm) toDelete.push(pnpmLock);
            if (hasYarn) toDelete.push(yarnLock);
        } else if (hasYarn) {
            keeping = 'yarn.lock';
            if (hasPnpm) toDelete.push(pnpmLock);
        }

        if (toDelete.length === 0) {
            return { fixed: false, message: 'Could not determine which lock file to remove' };
        }

        // Ask for confirmation via button
        stream.button({
            command: 'amplify-monitor.deleteLockFiles',
            title: `🗑️ Delete conflicting lock files`,
            arguments: [toDelete]
        });

        return { 
            fixed: false, 
            message: `Found ${lockCount} lock files. Click the button above to delete conflicting files (keeping ${keeping}).` 
        };
    }

    private async fixNodeVersionMismatch(
        rootPath: string,
        logs: string,
        stream: vscode.ChatResponseStream
    ): Promise<{ fixed: boolean; message: string }> {
        const fs = await import('fs');
        const path = await import('path');

        // Extract required Node version from logs
        const versionMatch = logs.match(/node[:\s]+v?(\d+)/i) || 
                            logs.match(/requires?\s+node\s+v?(\d+)/i) ||
                            logs.match(/expected\s+node\s+v?(\d+)/i);
        
        const nodeVersion = versionMatch ? versionMatch[1] : '18';

        const nvmrcPath = path.join(rootPath, '.nvmrc');
        
        // Check if .nvmrc already exists
        if (fs.existsSync(nvmrcPath)) {
            const current = fs.readFileSync(nvmrcPath, 'utf-8').trim();
            if (current === nodeVersion) {
                return { fixed: false, message: `.nvmrc already set to ${nodeVersion}` };
            }
        }

        // Create/update .nvmrc
        stream.button({
            command: 'amplify-monitor.createNvmrc',
            title: `📝 Create .nvmrc with Node ${nodeVersion}`,
            arguments: [rootPath, nodeVersion]
        });

        return { 
            fixed: false, 
            message: `Click the button to create .nvmrc with Node ${nodeVersion}` 
        };
    }

    private async fixMissingEnvVar(
        rootPath: string,
        logs: string,
        stream: vscode.ChatResponseStream
    ): Promise<{ fixed: boolean; message: string }> {
        // Extract missing env var name from logs
        const envMatch = logs.match(/(?:missing|undefined|not set)[:\s]+([A-Z][A-Z0-9_]+)/i) ||
                        logs.match(/process\.env\.([A-Z][A-Z0-9_]+)/i) ||
                        logs.match(/\$\{?([A-Z][A-Z0-9_]+)\}?.*(?:undefined|missing)/i);

        if (!envMatch) {
            return { fixed: false, message: 'Could not identify the missing environment variable' };
        }

        const envVarName = envMatch[1];

        stream.button({
            command: 'amplify-monitor.addEnvVar',
            title: `🔑 Add ${envVarName} to Amplify`,
            arguments: []
        });

        stream.markdown(`\nDetected missing variable: \`${envVarName}\`\n`);

        return { 
            fixed: false, 
            message: `Missing env var: ${envVarName}. Click the button to add it in Amplify Console.` 
        };
    }

    private async fixEslintError(
        rootPath: string,
        logs: string,
        stream: vscode.ChatResponseStream
    ): Promise<{ fixed: boolean; message: string }> {
        const fs = await import('fs');
        const path = await import('path');

        const amplifyYmlPath = path.join(rootPath, 'amplify.yml');
        
        if (!fs.existsSync(amplifyYmlPath)) {
            return { fixed: false, message: 'No amplify.yml found to modify' };
        }

        // Offer to add CI=false to build command
        stream.button({
            command: 'amplify-monitor.addCiFalse',
            title: `⚙️ Add CI=false to amplify.yml`,
            arguments: [amplifyYmlPath]
        });

        stream.button({
            command: 'workbench.action.terminal.sendSequence',
            title: `🔧 Run npm run lint --fix`,
            arguments: [{ text: 'npm run lint -- --fix\n' }]
        });

        return { 
            fixed: false, 
            message: 'Choose to either add CI=false to skip lint errors, or run lint --fix locally.' 
        };
    }

    private async fixMissingAmplifyYml(
        rootPath: string,
        stream: vscode.ChatResponseStream
    ): Promise<{ fixed: boolean; message: string }> {
        const fs = await import('fs');
        const path = await import('path');

        const amplifyYmlPath = path.join(rootPath, 'amplify.yml');
        
        if (fs.existsSync(amplifyYmlPath)) {
            return { fixed: false, message: 'amplify.yml already exists' };
        }

        stream.button({
            command: 'amplify-monitor.createAmplifyYml',
            title: `📄 Create amplify.yml`,
            arguments: [rootPath]
        });

        return { 
            fixed: false, 
            message: 'Click the button to create a starter amplify.yml' 
        };
    }

    private async handleStatusRequest(
        request: vscode.ChatRequest,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> {
        stream.progress('Fetching Amplify status...');

        try {
            const appsResult = await this.cli.listApps();
            
            if (!appsResult || appsResult.length === 0) {
                stream.markdown('No Amplify apps found. Make sure your AWS credentials are configured.');
                return { metadata: { success: true } };
            }

            stream.markdown(`## 📊 Amplify Apps Status\n\n`);

            for (const app of appsResult.slice(0, 5)) { // Limit to 5 apps
                stream.markdown(`### ${app.name}\n`);
                stream.markdown(`- **App ID:** \`${app.appId}\`\n`);
                stream.markdown(`- **Region:** ${app.region || 'N/A'}\n`);
                
                // Try to get latest build status
                try {
                    const branches = await this.cli.listBranches(app.appId);
                    if (branches && branches.length > 0) {
                        for (const branch of branches.slice(0, 3)) {
                            const jobs = await this.cli.listJobs(app.appId, branch.branchName);
                            if (jobs && jobs.length > 0) {
                                const latest = jobs[0];
                                const statusIcon = latest.status === 'SUCCEED' ? '✅' : 
                                                   latest.status === 'FAILED' ? '❌' : 
                                                   latest.status === 'RUNNING' ? '🔄' : '⏸️';
                                stream.markdown(`- **${branch.branchName}:** ${statusIcon} ${latest.status} (Job #${latest.jobId})\n`);
                            }
                        }
                    }
                } catch (e) {
                    // Ignore branch/job fetch errors
                }
                stream.markdown(`\n`);
            }

            return { metadata: { success: true } };
        } catch (error) {
            stream.markdown(`Failed to fetch status: ${error instanceof Error ? error.message : 'Unknown error'}`);
            return { metadata: { error: true } };
        }
    }

    private async handleGeneralRequest(
        request: vscode.ChatRequest,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> {
        stream.markdown(`## 🚀 Amplify Monitor Assistant\n\n`);
        stream.markdown(`I can help you with AWS Amplify builds. Try:\n\n`);
        stream.markdown(`- **"diagnose"** - Analyze the latest failed build\n`);
        stream.markdown(`- **"show logs"** - View build logs\n`);
        stream.markdown(`- **"fix this"** - Get fix suggestions for failures\n`);
        stream.markdown(`- **"status"** - Check all apps status\n\n`);

        // If there's context, offer to help with it
        if (this.lastBuildContext) {
            stream.markdown(`---\n\n`);
            stream.markdown(`*I have context from a previous build failure on **${this.lastBuildContext.appName}/${this.lastBuildContext.branch}**. Ask me to analyze or fix it.*`);
        }

        return { metadata: { success: true } };
    }

    private async fetchLatestFailedBuildLogs(): Promise<BuildLogContext | null> {
        try {
            // Get selected app/branch or find latest failed
            let appId = this.cli.getSelectedApp();
            let branch = this.cli.getSelectedBranch();
            let region = this.cli.getSelectedRegion();

            // If no selection, try to find a failed build across apps
            if (!appId) {
                const apps = await this.cli.listApps();
                if (!apps || apps.length === 0) return null;

                for (const app of apps) {
                    const branches = await this.cli.listBranches(app.appId, app.region);
                    if (!branches) continue;

                    for (const br of branches) {
                        const jobs = await this.cli.listJobs(app.appId, br.branchName, app.region);
                        if (jobs && jobs.length > 0 && jobs[0].status === 'FAILED') {
                            appId = app.appId;
                            branch = br.branchName;
                            region = app.region;
                            break;
                        }
                    }
                    if (appId && branch) break;
                }
            }

            if (!appId || !branch) return null;

            // Get app info
            const apps = await this.cli.listApps();
            const appInfo = apps?.find(a => a.appId === appId);
            if (appInfo?.region) {
                region = appInfo.region;
            }

            // Get latest job
            const jobs = await this.cli.listJobs(appId, branch, region);
            if (!jobs || jobs.length === 0) return null;

            const latestJob = jobs.find(j => j.status === 'FAILED') || jobs[0];
            
            // Run diagnosis with logs to get full context
            let diagnosisResult;
            let rawLogs = '';
            
            try {
                // Try to get diagnosis with logs
                diagnosisResult = await this.cli.diagnoseWithLogs(appId, branch, latestJob.jobId, region);
                rawLogs = diagnosisResult?.rawLogs || '';
            } catch (e) {
                console.error('diagnoseWithLogs failed, falling back:', e);
                // Fallback to regular diagnosis
                diagnosisResult = await this.cli.diagnose(appId, branch, latestJob.jobId, region);
            }
            
            // If still no logs, try fetching them directly
            if (!rawLogs) {
                try {
                    rawLogs = await this.cli.getBuildLogs(appId, branch, latestJob.jobId, region);
                } catch (e) {
                    console.error('Failed to fetch build logs:', e);
                }
            }
            
            return {
                appId,
                appName: appInfo?.name || appId,
                branch,
                jobId: latestJob.jobId,
                status: latestJob.status,
                startTime: latestJob.startTime,
                endTime: latestJob.endTime,
                logs: rawLogs,
                issues: diagnosisResult?.issues || []
            };
        } catch (error) {
            console.error('Failed to fetch build logs:', error);
            return null;
        }
    }

    private extractRelevantLogSection(logs: string): string {
        const lines = logs.split('\n');
        const errorIndicators = ['error', 'failed', 'Error:', 'ERROR', 'FAILED', 'npm ERR!', 'exit code', 'Command failed'];
        
        let relevantLines: string[] = [];
        let foundError = false;
        let contextBefore: string[] = [];

        for (const line of lines) {
            // Keep a rolling buffer of context (increased from 10 to 20)
            if (contextBefore.length > 20) {
                contextBefore.shift();
            }
            contextBefore.push(line);

            // Check if this line contains an error indicator
            if (errorIndicators.some(indicator => line.toLowerCase().includes(indicator.toLowerCase()))) {
                if (!foundError) {
                    // Include context before first error (increased from 5 to 10)
                    relevantLines.push(...contextBefore.slice(-10));
                    foundError = true;
                }
                relevantLines.push(line);
            } else if (foundError && relevantLines.length < 150) {
                // Include lines after error for context (increased from 50 to 150)
                relevantLines.push(line);
            }
        }

        // If no errors found, return last 50 lines (increased from 30)
        if (relevantLines.length === 0) {
            relevantLines = lines.slice(-50);
        }

        // Return up to 100 lines (increased from 40)
        return relevantLines.slice(0, 100).join('\n');
    }

    private extractErrorContext(logs: string): string {
        const lines = logs.split('\n');
        const errorPatterns = [
            /error/i,
            /failed/i,
            /npm ERR!/,
            /Error:/,
            /Cannot find/,
            /Module not found/,
            /SyntaxError/,
            /TypeError/,
            /ENOENT/,
            /exit code [1-9]/
        ];

        const errorLines: string[] = [];
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (errorPatterns.some(pattern => pattern.test(line))) {
                // Include 2 lines before and 3 lines after for context
                const start = Math.max(0, i - 2);
                const end = Math.min(lines.length, i + 4);
                const context = lines.slice(start, end).join('\n');
                if (!errorLines.includes(context)) {
                    errorLines.push(context);
                }
            }
        }

        return errorLines.slice(0, 5).join('\n\n---\n\n');
    }

    private getCodeFixForPattern(pattern: string, logs: string): string | null {
        const fixes: { [key: string]: string } = {
            'eslint_error': `
**ESLint Fix:**

1. Run locally to see all errors:
\`\`\`bash
npm run lint
\`\`\`

2. Auto-fix what's possible:
\`\`\`bash
npm run lint -- --fix
\`\`\`

3. Or skip lint in CI by adding to \`amplify.yml\`:
\`\`\`yaml
build:
  commands:
    - CI=false npm run build
\`\`\`
`,
            'node_version_mismatch': `
**Node.js Version Fix:**

Add to your \`amplify.yml\`:
\`\`\`yaml
frontend:
  phases:
    preBuild:
      commands:
        - nvm use 18
        - npm ci
\`\`\`

Or create \`.nvmrc\` in your repo root:
\`\`\`
18
\`\`\`
`,
            'lock_file_mismatch': `
**Lock File Fix:**

Choose ONE package manager and commit only its lock file:

**For npm:**
\`\`\`bash
rm -f yarn.lock pnpm-lock.yaml
npm install
git add package-lock.json
git commit -m "Use npm with package-lock.json"
\`\`\`

**For pnpm:**
\`\`\`bash
rm -f package-lock.json yarn.lock
pnpm install
git add pnpm-lock.yaml
git commit -m "Use pnpm with pnpm-lock.yaml"
\`\`\`
`,
            'missing_env_var': `
**Missing Environment Variable Fix:**

1. Open AWS Amplify Console
2. Go to App settings → Environment variables
3. Add the missing variable

Or use Amplify Monitor:
- Run command: \`Amplify Monitor: Add Environment Variable\`
`,
            'npm_ci_failure': `
**npm ci Failure Fix:**

This usually means your \`package-lock.json\` is out of sync:

\`\`\`bash
rm -rf node_modules package-lock.json
npm install
git add package-lock.json
git commit -m "Regenerate package-lock.json"
git push
\`\`\`
`,
            'build_command_failed': `
**Build Command Fix:**

Check your \`amplify.yml\` build commands. Common fixes:

1. Ensure dependencies are installed first:
\`\`\`yaml
frontend:
  phases:
    preBuild:
      commands:
        - npm ci
    build:
      commands:
        - npm run build
\`\`\`

2. Check if build script exists in \`package.json\`
`,
            'typescript_error': `
**TypeScript Error Fix:**

1. Run locally to see errors:
\`\`\`bash
npx tsc --noEmit
\`\`\`

2. Fix the type errors in your code

3. Or temporarily ignore (not recommended):
\`\`\`json
// tsconfig.json
{
  "compilerOptions": {
    "skipLibCheck": true
  }
}
\`\`\`
`
        };

        return fixes[pattern] || null;
    }

    private provideFollowups(
        result: vscode.ChatResult,
        context: vscode.ChatContext,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.ChatFollowup[]> {
        const followups: vscode.ChatFollowup[] = [];

        if (result.metadata?.buildContext) {
            followups.push({
                prompt: 'Fix the build errors in my code',
                label: '🔧 Fix Issues',
                command: ''
            });
            followups.push({
                prompt: 'Show me the full build logs',
                label: '📋 View Logs',
                command: ''
            });
        } else if (result.metadata?.hasCodeError && result.metadata?.errorFiles?.length > 0) {
            // After fix request with code errors, suggest applying fixes
            followups.push({
                prompt: `Please fix the syntax error in ${result.metadata.errorFiles[0]}`,
                label: '✏️ Apply Fix',
                command: ''
            });
        } else if (result.metadata?.noFailures) {
            followups.push({
                prompt: 'Show me the status of all my Amplify apps',
                label: '📊 View Status',
                command: ''
            });
        } else {
            followups.push({
                prompt: 'Diagnose my latest failed build',
                label: '🔍 Diagnose Build',
                command: ''
            });
        }

        return followups;
    }
}
