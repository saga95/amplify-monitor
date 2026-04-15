import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
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
    buildLog: string;
    deployLog: string;
    region?: string;
    profile?: string;
    issues: Array<{
        pattern: string;
        rootCause: string;
        suggestedFixes: string[];
        matchedLines?: string[];
    }>;
    /** URIs to saved BUILD.txt and DEPLOY.txt temp files */
    logFileUris?: { buildUri?: vscode.Uri; deployUri?: vscode.Uri };
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

        // Reference build/deploy log files so Copilot can read them for follow-up questions
        if (buildContext.logFileUris?.buildUri) {
            stream.reference(buildContext.logFileUris.buildUri);
        }
        if (buildContext.logFileUris?.deployUri) {
            stream.reference(buildContext.logFileUris.deployUri);
        }

        // Header with build info
        const consoleUrl = buildContext.region 
            ? `https://${buildContext.region}.console.aws.amazon.com/amplify/home#/${buildContext.appId}/${buildContext.branch}/${buildContext.jobId}`
            : undefined;

        stream.markdown(`## 🔴 Build Failure Analysis\n\n`);
        stream.markdown(`| | |\n|---|---|\n`);
        stream.markdown(`| **App** | ${buildContext.appName} (\`${buildContext.appId}\`) |\n`);
        stream.markdown(`| **Branch** | \`${buildContext.branch}\` |\n`);
        stream.markdown(`| **Job** | #${buildContext.jobId} |\n`);
        if (buildContext.profile) {
            stream.markdown(`| **Profile** | ${buildContext.profile} |\n`);
        }
        if (buildContext.startTime) {
            stream.markdown(`| **Time** | ${buildContext.startTime} |\n`);
        }
        if (consoleUrl) {
            stream.markdown(`| **Console** | [Open in AWS Console](${consoleUrl}) |\n`);
        }
        stream.markdown(`\n`);

        if (buildContext.issues.length > 0) {
            stream.markdown(`### Issues Detected (${buildContext.issues.length})\n\n`);
            
            for (let i = 0; i < buildContext.issues.length; i++) {
                const issue = buildContext.issues[i];
                stream.markdown(`#### ${i + 1}. ${issue.pattern.replace(/_/g, ' ')}\n\n`);
                stream.markdown(`**Root Cause:** ${issue.rootCause}\n\n`);

                // Show actual matched log lines inline with the issue
                if (issue.matchedLines && issue.matchedLines.length > 0) {
                    stream.markdown(`**From build log:**\n`);
                    stream.markdown('```\n');
                    stream.markdown(issue.matchedLines.join('\n'));
                    stream.markdown('\n```\n\n');
                }

                stream.markdown(`**Suggested Fixes:**\n`);
                for (const fix of issue.suggestedFixes) {
                    stream.markdown(`- ${fix}\n`);
                }
                stream.markdown(`\n`);
            }
        } else {
            stream.markdown(`> No specific failure patterns detected. Check the build logs below for details.\n\n`);
        }

        // Show build log excerpt — only when logs are available
        if (buildContext.logs && buildContext.logs.trim().length > 0) {
            const relevantLogs = this.extractRelevantLogSection(buildContext.logs);
            if (relevantLogs.trim().length > 0) {
                stream.markdown(`### Build Log Excerpt\n\n`);
                stream.markdown('```\n');
                stream.markdown(relevantLogs);
                stream.markdown('\n```\n\n');
            }
        } else if (buildContext.issues.length > 0 && 
                   !buildContext.issues.some(i => i.matchedLines && i.matchedLines.length > 0)) {
            // Logs are empty AND no matched lines on issues — warn the user
            stream.markdown(`> ⚠️ Could not retrieve raw build logs. The issues above were detected from the CLI diagnosis. `);
            if (consoleUrl) {
                stream.markdown(`[View full logs in AWS Console](${consoleUrl})`);
            }
            stream.markdown(`\n\n`);
        }

        stream.markdown(`*Ask me to **"fix this"** and I'll help you resolve the issues, or **"show logs"** for the full build output.*`);

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

        // Reference log files so Copilot can use them for follow-ups
        if (buildContext.logFileUris?.buildUri) {
            stream.reference(buildContext.logFileUris.buildUri);
        }
        if (buildContext.logFileUris?.deployUri) {
            stream.reference(buildContext.logFileUris.deployUri);
        }

        stream.markdown(`## 📋 Build Logs - Job #${buildContext.jobId}\n\n`);
        stream.markdown(`**App:** ${buildContext.appName} | **Branch:** ${buildContext.branch}\n\n`);

        const hasBuildLog = buildContext.buildLog && buildContext.buildLog.trim().length > 0;
        const hasDeployLog = buildContext.deployLog && buildContext.deployLog.trim().length > 0;
        const hasRawLogs = buildContext.logs && buildContext.logs.trim().length > 0;

        if (hasBuildLog || hasDeployLog) {
            // Show split logs with clear headers
            if (hasBuildLog) {
                stream.markdown(`### BUILD Log\n\n`);
                stream.markdown('```\n');
                stream.markdown(buildContext.buildLog);
                stream.markdown('\n```\n\n');
            }
            if (hasDeployLog) {
                stream.markdown(`### DEPLOY Log\n\n`);
                stream.markdown('```\n');
                stream.markdown(buildContext.deployLog);
                stream.markdown('\n```\n\n');
            }
        } else if (hasRawLogs) {
            // Fallback to combined raw logs
            stream.markdown('```\n');
            stream.markdown(buildContext.logs);
            stream.markdown('\n```\n');
        } else {
            stream.markdown(`> ⚠️ Could not retrieve build logs.\n\n`);
            // Still show matched lines from issues as a useful fallback
            if (buildContext.issues.length > 0) {
                stream.markdown(`**Error context from detected issues:**\n\n`);
                for (const issue of buildContext.issues) {
                    if (issue.matchedLines && issue.matchedLines.length > 0) {
                        stream.markdown(`*${issue.pattern.replace(/_/g, ' ')}:*\n`);
                        stream.markdown('```\n');
                        stream.markdown(issue.matchedLines.join('\n'));
                        stream.markdown('\n```\n\n');
                    }
                }
            }
            const consoleUrl = buildContext.region
                ? `https://${buildContext.region}.console.aws.amazon.com/amplify/home#/${buildContext.appId}/${buildContext.branch}/${buildContext.jobId}`
                : undefined;
            if (consoleUrl) {
                stream.markdown(`[View full logs in AWS Console](${consoleUrl})\n`);
            }
        }

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

        // Reference the actual build/deploy log files so Copilot has full context
        if (buildContext.logFileUris?.buildUri) {
            stream.reference(buildContext.logFileUris.buildUri);
        }
        if (buildContext.logFileUris?.deployUri) {
            stream.reference(buildContext.logFileUris.deployUri);
        }

        // Extract and reference local source files mentioned in errors
        const errorFiles = this.extractErrorFilePaths(buildContext.logs || buildContext.buildLog || '');
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const referencedFiles: vscode.Uri[] = [];
        
        if (workspaceFolders && errorFiles.length > 0) {
            for (const filePath of errorFiles.slice(0, 5)) {
                try {
                    const fullPath = vscode.Uri.joinPath(workspaceFolders[0].uri, filePath);
                    const doc = await vscode.workspace.openTextDocument(fullPath);
                    stream.reference(doc.uri);
                    referencedFiles.push(doc.uri);
                } catch {
                    // File might not exist locally
                }
            }
        }

        // Categorize issues
        const hasCodeError = buildContext.issues.some(i => 
            ['typescript_error', 'eslint_error', 'nextjs_error', 'syntax_error', 'build_command_failed'].includes(i.pattern)
        );
        const hasConfigIssue = buildContext.issues.some(i => 
            ['lock_file_mismatch', 'node_version_mismatch', 'missing_env_var', 'amplify_yml_missing', 'npm_ci_failure'].includes(i.pattern)
        );

        stream.markdown(`## 🔧 Fixing Build Issues\n\n`);
        stream.markdown(`**App:** ${buildContext.appName} | **Branch:** ${buildContext.branch} | **Job:** #${buildContext.jobId}\n\n`);

        // For config issues, provide quick-action buttons
        if (hasConfigIssue) {
            for (const issue of buildContext.issues.filter(i => 
                ['lock_file_mismatch', 'node_version_mismatch', 'missing_env_var', 'amplify_yml_missing', 'npm_ci_failure', 'eslint_error'].includes(i.pattern)
            )) {
                stream.markdown(`### ${issue.pattern.replace(/_/g, ' ')}\n\n`);
                await this.attemptAutoFix(issue.pattern, buildContext.logs || '', stream);
            }
        }

        // Show the actual build error from logs — this is what Copilot needs to reason about
        const buildLogContent = buildContext.buildLog || buildContext.logs || '';
        if (buildLogContent) {
            const errorSection = this.extractSpecificError(buildLogContent);
            if (errorSection.trim()) {
                stream.markdown(`### Build Error\n\n`);
                stream.markdown('```\n');
                stream.markdown(errorSection);
                stream.markdown('\n```\n\n');
            }
        }

        // Show matched log lines from each issue for additional context
        if (buildContext.issues.length > 0) {
            const issuesWithLines = buildContext.issues.filter(i => i.matchedLines && i.matchedLines.length > 0);
            if (issuesWithLines.length > 0) {
                stream.markdown(`### Detected Issues\n\n`);
                for (const issue of issuesWithLines) {
                    stream.markdown(`**${issue.pattern.replace(/_/g, ' ')}** — ${issue.rootCause}\n\n`);
                    stream.markdown('```\n');
                    stream.markdown(issue.matchedLines!.join('\n'));
                    stream.markdown('\n```\n\n');
                }
            }
        }

        // Tell Copilot what to do — it has the referenced log files + local source files
        if (hasCodeError && referencedFiles.length > 0) {
            stream.markdown(`---\n\n`);
            stream.markdown(`The build/deploy log files and the source files mentioned in the errors are attached above. `);
            stream.markdown(`Please analyze the actual error in the build log, find the root cause in the referenced source files, and apply the fix.\n\n`);
        } else if (hasCodeError) {
            stream.markdown(`---\n\n`);
            stream.markdown(`The build/deploy log files are attached above. `);
            stream.markdown(`Please analyze the error and suggest the fix for the source files mentioned in the logs.\n\n`);
        } else if (!hasConfigIssue) {
            // Fallback — show error context
            const errorCtx = this.extractErrorContext(buildContext.logs || buildContext.buildLog || '');
            if (errorCtx.trim()) {
                stream.markdown(`### Error Context\n\n`);
                stream.markdown('```\n');
                stream.markdown(errorCtx);
                stream.markdown('\n```\n\n');
            }
        }

        return { 
            metadata: { 
                success: true, 
                errorFiles, 
                hasCodeError, 
                hasConfigIssue,
                needsCodeFix: hasCodeError && referencedFiles.length > 0
            } 
        };
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
            const config = vscode.workspace.getConfiguration('amplifyMonitor');
            const isMultiAccount = config.get<boolean>('multiAccount.enabled', false);
            const configuredProfiles = config.get<string[]>('multiAccount.profiles', []);
            const defaultProfile = this.cli.getAwsProfile() || 'default';

            interface AppWithProfile { app: { appId: string; name: string; region?: string }; profile: string }
            let allApps: AppWithProfile[] = [];

            if (isMultiAccount && configuredProfiles.length > 0) {
                const profilesToFetch = [...new Set([...configuredProfiles, defaultProfile])];
                for (const p of profilesToFetch) {
                    try {
                        const apps = await this.cli.listAppsForProfile(p, true);
                        allApps.push(...apps.map(app => ({ app, profile: p })));
                    } catch {
                        // Skip profiles that fail
                    }
                }
            } else {
                const apps = await this.cli.listApps();
                allApps = apps.map(app => ({ app, profile: defaultProfile }));
            }
            
            if (allApps.length === 0) {
                stream.markdown('No Amplify apps found. Make sure your AWS credentials are configured.');
                return { metadata: { success: true } };
            }

            stream.markdown(`## 📊 Amplify Apps Status\n\n`);

            for (const { app, profile } of allApps.slice(0, 10)) {
                stream.markdown(`### ${app.name}\n`);
                stream.markdown(`- **App ID:** \`${app.appId}\`\n`);
                stream.markdown(`- **Region:** ${app.region || 'N/A'}\n`);
                if (isMultiAccount) {
                    stream.markdown(`- **Profile:** ${profile}\n`);
                }
                
                // Try to get latest build status using correct profile
                try {
                    const branches = await this.cli.listBranches(app.appId, app.region, profile);
                    if (branches && branches.length > 0) {
                        for (const branch of branches.slice(0, 3)) {
                            const jobs = await this.cli.listJobs(app.appId, branch.branchName, app.region, profile);
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

    /**
     * Save build/deploy logs as temporary files and return their URIs
     * so Copilot can reference/read them as context documents.
     */
    private async saveLogFiles(
        appId: string,
        jobId: string,
        buildLog: string,
        deployLog: string
    ): Promise<{ buildUri?: vscode.Uri; deployUri?: vscode.Uri }> {
        const result: { buildUri?: vscode.Uri; deployUri?: vscode.Uri } = {};
        const tmpDir = path.join(os.tmpdir(), 'amplify-monitor-logs');

        try {
            if (!fs.existsSync(tmpDir)) {
                fs.mkdirSync(tmpDir, { recursive: true });
            }

            if (buildLog) {
                const buildPath = path.join(tmpDir, `${appId}-${jobId}-BUILD.txt`);
                fs.writeFileSync(buildPath, buildLog, 'utf-8');
                result.buildUri = vscode.Uri.file(buildPath);
            }

            if (deployLog) {
                const deployPath = path.join(tmpDir, `${appId}-${jobId}-DEPLOY.txt`);
                fs.writeFileSync(deployPath, deployLog, 'utf-8');
                result.deployUri = vscode.Uri.file(deployPath);
            }
        } catch (e) {
            console.warn('Failed to save log files to temp dir:', e);
        }

        return result;
    }

    private async fetchLatestFailedBuildLogs(): Promise<BuildLogContext | null> {
        try {
            // Get selected app/branch or find latest failed
            let appId = this.cli.getSelectedApp();
            let branch = this.cli.getSelectedBranch();
            let region = this.cli.getSelectedRegion();
            let profile = this.cli.getSelectedProfile();

            // If no selection, try to find a failed build across apps (including multi-account)
            if (!appId) {
                const config = vscode.workspace.getConfiguration('amplifyMonitor');
                const isMultiAccount = config.get<boolean>('multiAccount.enabled', false);
                const configuredProfiles = config.get<string[]>('multiAccount.profiles', []);
                const defaultProfile = this.cli.getAwsProfile() || 'default';

                interface AppWithProfile { app: { appId: string; name: string; region?: string }; profile: string }
                let allApps: AppWithProfile[] = [];

                if (isMultiAccount && configuredProfiles.length > 0) {
                    // Multi-account: fetch apps from all profiles
                    const profilesToFetch = [...new Set([...configuredProfiles, defaultProfile])];
                    for (const p of profilesToFetch) {
                        try {
                            const apps = await this.cli.listAppsForProfile(p, true);
                            allApps.push(...apps.map(app => ({ app, profile: p })));
                        } catch {
                            // Skip profiles that fail
                        }
                    }
                } else {
                    const apps = await this.cli.listApps();
                    allApps = apps.map(app => ({ app, profile: defaultProfile }));
                }

                if (allApps.length === 0) return null;

                for (const { app, profile: appProfile } of allApps) {
                    const branches = await this.cli.listBranches(app.appId, app.region, appProfile);
                    if (!branches) continue;

                    for (const br of branches) {
                        const jobs = await this.cli.listJobs(app.appId, br.branchName, app.region, appProfile);
                        if (jobs && jobs.length > 0 && jobs[0].status === 'FAILED') {
                            appId = app.appId;
                            branch = br.branchName;
                            region = app.region;
                            profile = appProfile;
                            break;
                        }
                    }
                    if (appId && branch) break;
                }
            }

            if (!appId || !branch) return null;

            // Get app info - use the correct profile
            let appName = appId;
            try {
                const apps = profile 
                    ? await this.cli.listAppsForProfile(profile, true) 
                    : await this.cli.listApps();
                const appInfo = apps?.find(a => a.appId === appId);
                if (appInfo?.region) {
                    region = appInfo.region;
                }
                if (appInfo?.name) {
                    appName = appInfo.name;
                }
            } catch {
                // Continue with what we have
            }

            // Get latest job using the correct profile
            const jobs = await this.cli.listJobs(appId, branch, region, profile);
            if (!jobs || jobs.length === 0) return null;

            const latestJob = jobs.find(j => j.status === 'FAILED') || jobs[0];
            
            // Run diagnosis with logs to get full context - pass profile
            let diagnosisResult;
            let rawLogs = '';
            let buildLog = '';
            let deployLog = '';
            
            try {
                // Try to get diagnosis with embedded logs
                diagnosisResult = await this.cli.diagnoseWithLogs(appId, branch, latestJob.jobId, region, profile);
                rawLogs = diagnosisResult?.rawLogs || '';
                buildLog = diagnosisResult?.buildLog || '';
                deployLog = diagnosisResult?.deployLog || '';
            } catch (e) {
                console.warn('diagnoseWithLogs failed (possibly large output), falling back to diagnosis without logs:', e);
                try {
                    // Fallback to diagnosis without logs — still gets issues with matchedLines
                    diagnosisResult = await this.cli.diagnose(appId, branch, latestJob.jobId, region, profile);
                } catch (e2) {
                    console.error('diagnose also failed:', e2);
                }
            }
            
            // If still no logs, try fetching them separately
            if (!rawLogs && !buildLog) {
                try {
                    const logsResult = await this.cli.getBuildLogs(appId, branch, latestJob.jobId, region, profile);
                    rawLogs = logsResult.logs;
                    buildLog = logsResult.buildLog;
                    deployLog = logsResult.deployLog;
                } catch (e) {
                    console.warn('getBuildLogs failed — issues will show matched lines only:', e);
                }
            }

            // Save build/deploy logs as temp files so Copilot can reference them
            const logFileUris = await this.saveLogFiles(appId, latestJob.jobId, buildLog, deployLog);
            
            return {
                appId,
                appName,
                branch,
                jobId: latestJob.jobId,
                status: latestJob.status,
                startTime: latestJob.startTime,
                endTime: latestJob.endTime,
                logs: rawLogs,
                buildLog,
                deployLog,
                region,
                profile,
                issues: diagnosisResult?.issues || [],
                logFileUris,
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
