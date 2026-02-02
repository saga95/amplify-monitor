import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AmplifyMonitorCli } from './cli';
import { AppsTreeProvider } from './views/appsTree';
import { JobsTreeProvider } from './views/jobsTree';
import { DiagnosisTreeProvider } from './views/diagnosisTree';
import { EnvVarsTreeProvider } from './views/envVarsTree';
import { MigrationTreeProvider } from './views/migrationTree';
import { DashboardPanel } from './views/dashboardPanel';
import { QuickFixService, QUICK_FIXES } from './quickFixes';
import { BundleAnalyzerPanel } from './views/bundleAnalyzerPanel';
import { BuildPerformanceTracker, BuildPerformancePanel } from './views/buildPerformancePanel';
import { MonorepoPanel } from './views/monorepoDetector';
import { BuildOptimizationWizard } from './views/buildOptimizationWizard';
import { PreDeployValidationPanel } from './views/preDeployValidation';
import { SecretsManagerPanel } from './views/secretsManagerPanel';
import { NotificationsPanel, NotificationsService } from './views/notificationsPanel';
import { NodeVersionDetectorPanel } from './views/nodeVersionDetector';
import { EnvVarsTroubleshooterPanel } from './views/envVarsTroubleshooter';
import { CustomDomainValidatorPanel } from './views/customDomainValidator';
import { AwsProfileManagerPanel } from './views/awsProfileManager';
import { CustomPatternsPanel } from './views/customPatternsPanel';
import { BuildComparisonPanel } from './views/buildComparisonPanel';
import { Gen2MigrationPanel } from './views/gen2MigrationPanel';
import { DiagnosisShareService } from './diagnosisShare';
import { AmplifyCopilotParticipant } from './copilotParticipant';
import { BuildCostPanel } from './views/buildCostPanel';
import { BuildQueuePanel } from './views/buildQueuePanel';
import { RollbackHelperPanel } from './views/rollbackHelper';
import { PreviewEnvironmentsPanel } from './views/previewEnvironments';
import { PerformanceAlertsPanel } from './views/performanceAlerts';
import { WebhookNotificationService, configureWebhook } from './webhookNotifications';
import { MultiAccountPanel } from './views/multiAccountPanel';
import { configureAwsProfile } from './views/profileConfigWizard';

let refreshInterval: NodeJS.Timeout | undefined;
let buildPerformanceTracker: BuildPerformanceTracker;

export function activate(context: vscode.ExtensionContext) {
    console.log('Amplify Monitor extension is now active');

    const cli = new AmplifyMonitorCli();
    buildPerformanceTracker = new BuildPerformanceTracker(context);
    
    // Initialize Copilot Chat Participant
    const copilotParticipant = new AmplifyCopilotParticipant(cli);
    context.subscriptions.push(...copilotParticipant.register(context));
    
    // Create tree data providers
    const appsProvider = new AppsTreeProvider(cli);
    const jobsProvider = new JobsTreeProvider(cli);
    const diagnosisProvider = new DiagnosisTreeProvider(cli);
    const envVarsProvider = new EnvVarsTreeProvider(cli);
    const migrationProvider = new MigrationTreeProvider();

    // Register tree views
    const appsView = vscode.window.createTreeView('amplifyApps', {
        treeDataProvider: appsProvider,
        showCollapseAll: true
    });
    
    const jobsView = vscode.window.createTreeView('amplifyJobs', {
        treeDataProvider: jobsProvider,
        showCollapseAll: true
    });

    const diagnosisView = vscode.window.createTreeView('amplifyDiagnosis', {
        treeDataProvider: diagnosisProvider,
        showCollapseAll: true
    });

    const envVarsView = vscode.window.createTreeView('amplifyEnvVars', {
        treeDataProvider: envVarsProvider,
        showCollapseAll: true
    });

    const migrationView = vscode.window.createTreeView('amplifyMigration', {
        treeDataProvider: migrationProvider,
        showCollapseAll: true
    });

    // Auto-detect Amplify project and fetch apps on startup
    autoDetectAndInitialize(cli, appsProvider, migrationProvider, context);

    // Register commands
    context.subscriptions.push(
        // Dashboard command
        vscode.commands.registerCommand('amplify-monitor.openDashboard', () => {
            DashboardPanel.createOrShow(cli);
        }),

        vscode.commands.registerCommand('amplify-monitor.listApps', async () => {
            await appsProvider.refresh();
            vscode.window.showInformationMessage('Amplify apps refreshed');
        }),

        vscode.commands.registerCommand('amplify-monitor.diagnose', async () => {
            await runDiagnosis(cli, diagnosisProvider);
        }),

        vscode.commands.registerCommand('amplify-monitor.selectApp', async (appId: string, region?: string, profile?: string) => {
            cli.setSelectedApp(appId, region, profile);
            
            // Auto-select the first branch for this app
            try {
                const branches = await cli.listBranches(appId, region, profile);
                if (branches.length > 0) {
                    // Prefer 'main' or 'master', otherwise use first branch
                    const preferredBranch = branches.find(b => b.branchName === 'main') 
                        || branches.find(b => b.branchName === 'master')
                        || branches[0];
                    cli.setSelectedBranch(preferredBranch.branchName);
                }
            } catch (error) {
                // Log but don't block - user can manually select branch
                console.warn(`Failed to auto-select branch for ${appId}:`, error);
            }
            
            await Promise.all([jobsProvider.refresh(), envVarsProvider.refresh()]);
            const regionInfo = region ? ` (${region})` : '';
            const profileInfo = profile ? ` [${profile}]` : '';
            vscode.window.showInformationMessage(`Selected app: ${appId}${regionInfo}${profileInfo}`);
        }),

        vscode.commands.registerCommand('amplify-monitor.selectBranch', async (branch: string, appId?: string, region?: string, profile?: string) => {
            // If appId/region/profile provided, update the selection (e.g., from tree view)
            if (appId) {
                cli.setSelectedApp(appId, region, profile);
            }
            cli.setSelectedBranch(branch);
            await Promise.all([jobsProvider.refresh(), envVarsProvider.refresh()]);
        }),

        vscode.commands.registerCommand('amplify-monitor.refresh', async () => {
            await Promise.all([
                appsProvider.refresh(),
                jobsProvider.refresh(),
                envVarsProvider.refresh()
            ]);
        }),

        vscode.commands.registerCommand('amplify-monitor.openSettings', () => {
            vscode.commands.executeCommand('workbench.action.openSettings', 'amplifyMonitor');
        }),

        vscode.commands.registerCommand('amplify-monitor.diagnoseJob', async (appIdOrObj: string | { appId?: string; branch?: string; branchName?: string; jobId?: string }, branch?: string, jobId?: string) => {
            // Handle both object and positional arguments for backwards compatibility
            let resolvedAppId: string | undefined;
            let resolvedBranch: string | undefined;
            let resolvedJobId: string | undefined;

            if (typeof appIdOrObj === 'object' && appIdOrObj !== null) {
                // Called with object argument (e.g., { appId, branch, jobId })
                resolvedAppId = appIdOrObj.appId || cli.getSelectedApp();
                resolvedBranch = appIdOrObj.branch || appIdOrObj.branchName || cli.getSelectedBranch();
                resolvedJobId = appIdOrObj.jobId;
            } else {
                // Called with positional arguments
                resolvedAppId = appIdOrObj || cli.getSelectedApp();
                resolvedBranch = branch || cli.getSelectedBranch();
                resolvedJobId = jobId;
            }

            if (!resolvedAppId || !resolvedBranch) {
                vscode.window.showErrorMessage('Please select an app and branch first');
                return;
            }

            await runDiagnosisForJob(cli, diagnosisProvider, resolvedAppId, resolvedBranch, resolvedJobId || '');
        }),

        vscode.commands.registerCommand('amplify-monitor.copyIssue', async (item: { issue?: { pattern: string; rootCause: string; suggestedFixes: string[] } }) => {
            if (item?.issue) {
                const text = `Issue: ${item.issue.pattern}\nRoot Cause: ${item.issue.rootCause}\nSuggested Fixes:\n${item.issue.suggestedFixes.map((f, i) => `${i + 1}. ${f}`).join('\n')}`;
                await vscode.env.clipboard.writeText(text);
                vscode.window.showInformationMessage('Issue details copied to clipboard');
            }
        }),

        // Quick Fix command
        vscode.commands.registerCommand('amplify-monitor.applyQuickFix', async (pattern?: string, fixId?: string) => {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('No workspace folder open');
                return;
            }

            const quickFixService = new QuickFixService(workspaceFolder.uri.fsPath);

            // If no pattern provided, show all available fixes
            if (!pattern) {
                const allFixes: { label: string; description: string; pattern: string; fixId: string }[] = [];
                for (const [p, fixes] of Object.entries(QUICK_FIXES)) {
                    for (const fix of fixes) {
                        allFixes.push({
                            label: fix.title,
                            description: `${p}: ${fix.description}`,
                            pattern: p,
                            fixId: fix.id
                        });
                    }
                }
                const selected = await vscode.window.showQuickPick(allFixes, {
                    placeHolder: 'Select a quick fix to apply'
                });
                if (selected) {
                    pattern = selected.pattern;
                    fixId = selected.fixId;
                } else {
                    return;
                }
            }

            // Get fixes for the pattern
            const fixes = QUICK_FIXES[pattern];
            if (!fixes || fixes.length === 0) {
                vscode.window.showInformationMessage(`No quick fixes available for ${pattern}`);
                return;
            }

            // Find specific fix or show picker
            let fix = fixId ? fixes.find(f => f.id === fixId) : undefined;
            if (!fix) {
                const items = fixes.map(f => ({
                    label: f.title,
                    description: f.description,
                    fix: f
                }));
                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: `Select fix for ${pattern.replace(/_/g, ' ')}`
                });
                if (!selected) return;
                fix = selected.fix;
            }

            // Apply the fix
            const success = await quickFixService.applyFix(fix);
            if (success) {
                vscode.window.showInformationMessage(`✅ Applied: ${fix.title}`);
                diagnosisProvider.refresh();
            }
        }),

        // Show all quick fixes command
        vscode.commands.registerCommand('amplify-monitor.showQuickFixes', async (item?: { issue?: { pattern: string } }) => {
            if (item?.issue?.pattern) {
                vscode.commands.executeCommand('amplify-monitor.applyQuickFix', item.issue.pattern);
            } else {
                vscode.commands.executeCommand('amplify-monitor.applyQuickFix');
            }
        }),

        // Share Diagnosis commands
        vscode.commands.registerCommand('amplify-monitor.shareDiagnosis', async () => {
            const result = diagnosisProvider.getResult();
            if (!result) {
                vscode.window.showWarningMessage('No diagnosis available. Run a diagnosis first.');
                return;
            }
            await DiagnosisShareService.showShareOptions(result);
        }),

        vscode.commands.registerCommand('amplify-monitor.copyDiagnosisMarkdown', async () => {
            const result = diagnosisProvider.getResult();
            if (!result) {
                vscode.window.showWarningMessage('No diagnosis available. Run a diagnosis first.');
                return;
            }
            await DiagnosisShareService.copyAsMarkdown(result);
        }),

        vscode.commands.registerCommand('amplify-monitor.copyDiagnosisGitHub', async () => {
            const result = diagnosisProvider.getResult();
            if (!result) {
                vscode.window.showWarningMessage('No diagnosis available. Run a diagnosis first.');
                return;
            }
            await DiagnosisShareService.copyAsGitHubIssue(result);
        }),

        vscode.commands.registerCommand('amplify-monitor.copyDiagnosisText', async () => {
            const result = diagnosisProvider.getResult();
            if (!result) {
                vscode.window.showWarningMessage('No diagnosis available. Run a diagnosis first.');
                return;
            }
            await DiagnosisShareService.copyAsText(result);
        }),

        vscode.commands.registerCommand('amplify-monitor.copyDiagnosisSummary', async () => {
            const result = diagnosisProvider.getResult();
            if (!result) {
                vscode.window.showWarningMessage('No diagnosis available. Run a diagnosis first.');
                return;
            }
            await DiagnosisShareService.copyShortSummary(result);
        }),

        vscode.commands.registerCommand('amplify-monitor.copyDiagnosisConsoleLink', async () => {
            const result = diagnosisProvider.getResult();
            if (!result) {
                vscode.window.showWarningMessage('No diagnosis available. Run a diagnosis first.');
                return;
            }
            await DiagnosisShareService.copyReferenceLink(result);
        }),

        vscode.commands.registerCommand('amplify-monitor.exportDiagnosis', async () => {
            const result = diagnosisProvider.getResult();
            if (!result) {
                vscode.window.showWarningMessage('No diagnosis available. Run a diagnosis first.');
                return;
            }
            await DiagnosisShareService.exportToFile(result);
        }),

        // Auto-fix commands for Copilot Chat
        vscode.commands.registerCommand('amplify-monitor.deleteLockFiles', async (filesToDelete: string[]) => {
            const confirm = await vscode.window.showWarningMessage(
                `Delete ${filesToDelete.length} conflicting lock file(s)?`,
                { modal: true },
                'Delete'
            );
            if (confirm === 'Delete') {
                for (const file of filesToDelete) {
                    try {
                        await vscode.workspace.fs.delete(vscode.Uri.file(file));
                        vscode.window.showInformationMessage(`Deleted: ${path.basename(file)}`);
                    } catch (e) {
                        vscode.window.showErrorMessage(`Failed to delete ${file}: ${e}`);
                    }
                }
            }
        }),

        vscode.commands.registerCommand('amplify-monitor.createNvmrc', async (rootPath: string, nodeVersion: string) => {
            const nvmrcPath = path.join(rootPath, '.nvmrc');
            const content = nodeVersion + '\n';
            await fs.promises.writeFile(nvmrcPath, content);
            
            const doc = await vscode.workspace.openTextDocument(nvmrcPath);
            await vscode.window.showTextDocument(doc);
            vscode.window.showInformationMessage(`Created .nvmrc with Node ${nodeVersion}`);
        }),

        vscode.commands.registerCommand('amplify-monitor.addCiFalse', async (amplifyYmlPath: string) => {
            try {
                const content = await fs.promises.readFile(amplifyYmlPath, 'utf-8');
                
                // Check if CI=false is already present
                if (content.includes('CI=false') || content.includes('CI=0')) {
                    vscode.window.showInformationMessage('CI=false is already in amplify.yml');
                    return;
                }

                // Add CI=false to build commands
                let newContent = content;
                if (content.includes('npm run build')) {
                    newContent = content.replace(
                        /npm run build/g,
                        'CI=false npm run build'
                    );
                } else {
                    // Add as environment variable
                    if (content.includes('frontend:')) {
                        newContent = content.replace(
                            /(frontend:\s*\n\s*phases:)/,
                            'frontend:\n  env:\n    variables:\n      CI: "false"\n  phases:'
                        );
                    }
                }

                await fs.promises.writeFile(amplifyYmlPath, newContent);
                
                const doc = await vscode.workspace.openTextDocument(amplifyYmlPath);
                await vscode.window.showTextDocument(doc);
                vscode.window.showInformationMessage('Added CI=false to amplify.yml');
            } catch (e) {
                vscode.window.showErrorMessage(`Failed to modify amplify.yml: ${e}`);
            }
        }),

        vscode.commands.registerCommand('amplify-monitor.createAmplifyYml', async (rootPath: string) => {
            const amplifyYmlPath = path.join(rootPath, 'amplify.yml');
            const defaultContent = `version: 1
frontend:
  phases:
    preBuild:
      commands:
        - npm ci
    build:
      commands:
        - npm run build
  artifacts:
    baseDirectory: .next
    files:
      - '**/*'
  cache:
    paths:
      - node_modules/**/*
      - .next/cache/**/*
`;
            await fs.promises.writeFile(amplifyYmlPath, defaultContent);
            
            const doc = await vscode.workspace.openTextDocument(amplifyYmlPath);
            await vscode.window.showTextDocument(doc);
            vscode.window.showInformationMessage('Created amplify.yml - please customize for your project');
        }),

        vscode.commands.registerCommand('amplify-monitor.switchProfile', async () => {
            const currentProfile = cli.getAwsProfile() || 'default';
            const profile = await vscode.window.showInputBox({
                prompt: 'Enter AWS profile name (leave empty for default credentials)',
                placeHolder: 'e.g., client-production',
                value: currentProfile === 'default' ? '' : currentProfile
            });
            
            if (profile !== undefined) {
                const config = vscode.workspace.getConfiguration('amplifyMonitor');
                await config.update('awsProfile', profile, vscode.ConfigurationTarget.Global);
                
                // Refresh all views with new credentials
                await Promise.all([
                    appsProvider.refresh(),
                    jobsProvider.refresh()
                ]);
                
                const displayProfile = profile || 'default';
                vscode.window.showInformationMessage(`Switched to AWS profile: ${displayProfile}`);
            }
        }),

        // Environment Variables commands
        vscode.commands.registerCommand('amplify-monitor.refreshEnvVars', async () => {
            envVarsProvider.refresh();
        }),

        vscode.commands.registerCommand('amplify-monitor.addEnvVar', async () => {
            const appId = cli.getSelectedApp();
            const branch = cli.getSelectedBranch();
            const region = cli.getSelectedRegion();

            if (!appId || !branch) {
                vscode.window.showWarningMessage('Please select an app and branch first');
                return;
            }

            const name = await vscode.window.showInputBox({
                prompt: 'Environment variable name',
                placeHolder: 'e.g., API_KEY'
            });
            if (!name) { return; }

            const value = await vscode.window.showInputBox({
                prompt: `Value for ${name}`,
                password: true
            });
            if (value === undefined) { return; }

            try {
                await cli.setEnvVariable(appId, branch, name, value, region);
                envVarsProvider.refresh();
                vscode.window.showInformationMessage(`Added ${name} to ${branch}`);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to add env var: ${error}`);
            }
        }),

        vscode.commands.registerCommand('amplify-monitor.editEnvVar', async (item: { envVar?: { name: string; value: string } }) => {
            const appId = cli.getSelectedApp();
            const branch = cli.getSelectedBranch();
            const region = cli.getSelectedRegion();

            if (!appId || !branch || !item?.envVar) { return; }

            const value = await vscode.window.showInputBox({
                prompt: `New value for ${item.envVar.name}`,
                password: true
            });
            if (value === undefined) { return; }

            try {
                await cli.setEnvVariable(appId, branch, item.envVar.name, value, region);
                envVarsProvider.refresh();
                vscode.window.showInformationMessage(`Updated ${item.envVar.name}`);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to update env var: ${error}`);
            }
        }),

        vscode.commands.registerCommand('amplify-monitor.deleteEnvVar', async (item: { envVar?: { name: string } }) => {
            const appId = cli.getSelectedApp();
            const branch = cli.getSelectedBranch();
            const region = cli.getSelectedRegion();

            if (!appId || !branch || !item?.envVar) { return; }

            const confirm = await vscode.window.showWarningMessage(
                `Delete ${item.envVar.name}?`,
                { modal: true },
                'Delete'
            );

            if (confirm === 'Delete') {
                try {
                    await cli.deleteEnvVariable(appId, branch, item.envVar.name, region);
                    envVarsProvider.refresh();
                    vscode.window.showInformationMessage(`Deleted ${item.envVar.name}`);
                } catch (error) {
                    vscode.window.showErrorMessage(`Failed to delete env var: ${error}`);
                }
            }
        }),

        vscode.commands.registerCommand('amplify-monitor.revealEnvVar', async (item: { envVar?: { name: string; value: string } }) => {
            if (item?.envVar) {
                const action = await vscode.window.showInformationMessage(
                    `${item.envVar.name}`,
                    { modal: true, detail: item.envVar.value },
                    'Copy Value'
                );
                if (action === 'Copy Value') {
                    await vscode.env.clipboard.writeText(item.envVar.value);
                    vscode.window.showInformationMessage('Value copied to clipboard');
                }
            }
        }),

        // Build actions commands
        vscode.commands.registerCommand('amplify-monitor.startBuild', async () => {
            const appId = cli.getSelectedApp();
            const branch = cli.getSelectedBranch();
            const region = cli.getSelectedRegion();

            if (!appId || !branch) {
                vscode.window.showWarningMessage('Please select an app and branch first');
                return;
            }

            try {
                const result = await cli.startBuild(appId, branch, region);
                jobsProvider.refresh();
                vscode.window.showInformationMessage(`Build started: Job ${result.jobId}`);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to start build: ${error}`);
            }
        }),

        vscode.commands.registerCommand('amplify-monitor.stopBuild', async (jobId?: string) => {
            const appId = cli.getSelectedApp();
            const branch = cli.getSelectedBranch();
            const region = cli.getSelectedRegion();

            if (!appId || !branch) {
                vscode.window.showWarningMessage('Please select an app and branch first');
                return;
            }

            if (!jobId) {
                jobId = await vscode.window.showInputBox({
                    prompt: 'Enter job ID to stop',
                    placeHolder: 'e.g., 1'
                });
            }

            if (!jobId) { return; }

            try {
                await cli.stopBuild(appId, branch, jobId, region);
                jobsProvider.refresh();
                vscode.window.showInformationMessage(`Build stopped: Job ${jobId}`);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to stop build: ${error}`);
            }
        }),

        vscode.commands.registerCommand('amplify-monitor.openInConsole', async () => {
            const appId = cli.getSelectedApp();
            const region = cli.getSelectedRegion() || 'us-east-1';

            if (!appId) {
                vscode.window.showWarningMessage('Please select an app first');
                return;
            }

            const url = `https://${region}.console.aws.amazon.com/amplify/home?region=${region}#/${appId}`;
            vscode.env.openExternal(vscode.Uri.parse(url));
        }),

        // Migration analysis commands
        vscode.commands.registerCommand('amplify-monitor.analyzeMigration', async () => {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                vscode.window.showWarningMessage('No workspace folder open');
                return;
            }

            const projectPath = workspaceFolders[0].uri.fsPath;
            
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Analyzing project for Gen1 → Gen2 migration...',
                cancellable: false
            }, async () => {
                try {
                    const analysis = await cli.analyzeMigration(projectPath);
                    migrationProvider.setAnalysis(analysis);
                    
                    // Show summary notification
                    if (analysis.generation === 'Gen1') {
                        if (analysis.readyForMigration) {
                            vscode.window.showInformationMessage(
                                `✅ Project is ready for Gen2 migration! ${analysis.summary.fullySupported}/${analysis.summary.totalFeatures} features fully supported.`
                            );
                        } else {
                            vscode.window.showWarningMessage(
                                `⚠️ ${analysis.blockingIssues.length} blocking issues found. Check the Migration panel for details.`
                            );
                        }
                    } else if (analysis.generation === 'Gen2') {
                        vscode.window.showInformationMessage('This project is already using Amplify Gen2!');
                    } else {
                        vscode.window.showWarningMessage('Could not detect an Amplify project. Make sure amplify/ folder exists.');
                    }
                } catch (error) {
                    vscode.window.showErrorMessage(`Migration analysis failed: ${error}`);
                }
            });
        }),

        vscode.commands.registerCommand('amplify-monitor.refreshMigration', () => {
            vscode.commands.executeCommand('amplify-monitor.analyzeMigration');
        }),

        vscode.commands.registerCommand('amplify-monitor.openMigrationDocs', () => {
            vscode.env.openExternal(vscode.Uri.parse('https://docs.amplify.aws/react/start/migrate-to-gen2/'));
        }),

        // Bundle Analyzer
        vscode.commands.registerCommand('amplify-monitor.analyzeBundle', async () => {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('No workspace folder open');
                return;
            }
            BundleAnalyzerPanel.createOrShow(workspaceFolder.uri.fsPath);
        }),

        // Build Performance
        vscode.commands.registerCommand('amplify-monitor.showBuildPerformance', () => {
            BuildPerformancePanel.createOrShow(buildPerformanceTracker);
        }),

        // Monorepo Detector
        vscode.commands.registerCommand('amplify-monitor.detectMonorepo', async () => {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('No workspace folder open');
                return;
            }
            await MonorepoPanel.createOrShow(workspaceFolder.uri.fsPath);
        }),

        // Build Optimization Wizard
        vscode.commands.registerCommand('amplify-monitor.optimizeBuild', async () => {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('No workspace folder open');
                return;
            }
            BuildOptimizationWizard.createOrShow(workspaceFolder.uri.fsPath);
        }),

        // Pre-Deploy Validation
        vscode.commands.registerCommand('amplify-monitor.validateDeploy', async () => {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('No workspace folder open');
                return;
            }
            PreDeployValidationPanel.createOrShow(workspaceFolder.uri.fsPath);
        }),

        // Secrets Manager Integration
        vscode.commands.registerCommand('amplify-monitor.manageSecrets', async () => {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('No workspace folder open');
                return;
            }
            const appId = cli.getSelectedApp();
            const branch = cli.getSelectedBranch();
            SecretsManagerPanel.createOrShow(workspaceFolder.uri.fsPath, appId, branch);
        }),

        // Notifications (Slack/Teams/Discord)
        vscode.commands.registerCommand('amplify-monitor.configureNotifications', () => {
            NotificationsPanel.createOrShow(context);
        }),

        // Node Version Detector
        vscode.commands.registerCommand('amplify-monitor.detectNodeVersion', () => {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showWarningMessage('Please open a workspace folder first');
                return;
            }
            NodeVersionDetectorPanel.createOrShow(context.extensionUri);
        }),

        // Env Vars Troubleshooter
        vscode.commands.registerCommand('amplify-monitor.troubleshootEnvVars', () => {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showWarningMessage('Please open a workspace folder first');
                return;
            }
            EnvVarsTroubleshooterPanel.createOrShow(context.extensionUri, cli);
        }),

        // Custom Domain Validator
        vscode.commands.registerCommand('amplify-monitor.validateCustomDomain', () => {
            CustomDomainValidatorPanel.createOrShow(context.extensionUri);
        }),

        // AWS Profile Manager
        vscode.commands.registerCommand('amplify-monitor.manageProfiles', () => {
            AwsProfileManagerPanel.createOrShow(context.extensionUri);
        }),

        vscode.commands.registerCommand('amplify-monitor.switchProfile', async () => {
            const profiles = await getAwsProfiles();
            if (profiles.length === 0) {
                const action = await vscode.window.showWarningMessage(
                    'No AWS profiles found',
                    'Open Profile Manager'
                );
                if (action === 'Open Profile Manager') {
                    AwsProfileManagerPanel.createOrShow(context.extensionUri);
                }
                return;
            }

            const currentProfile = vscode.workspace.getConfiguration('amplifyMonitor').get<string>('awsProfile') || 
                                   process.env.AWS_PROFILE || 'default';

            const items: vscode.QuickPickItem[] = profiles.map(p => ({
                label: p === currentProfile ? `$(check) ${p}` : p,
                description: p === 'default' ? 'Default profile' : undefined,
                picked: p === currentProfile
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select AWS Profile',
                title: 'Switch AWS Profile'
            });

            if (selected) {
                const profileName = selected.label.replace('$(check) ', '');
                await vscode.workspace.getConfiguration('amplifyMonitor').update(
                    'awsProfile',
                    profileName,
                    vscode.ConfigurationTarget.Global
                );
                vscode.window.showInformationMessage(`Switched to AWS profile: ${profileName}`);
            }
        }),

        // Custom Failure Patterns
        vscode.commands.registerCommand('amplify-monitor.customPatterns', () => {
            CustomPatternsPanel.createOrShow(context.extensionUri, context);
        }),

        // Build Comparison
        vscode.commands.registerCommand('amplify-monitor.compareBuilds', (appId?: string, branch?: string) => {
            BuildComparisonPanel.createOrShow(context.extensionUri, cli, appId, branch);
        }),

        // Gen1 → Gen2 Migration Helper
        vscode.commands.registerCommand('amplify-monitor.gen2Migration', () => {
            Gen2MigrationPanel.createOrShow(context.extensionUri, cli);
        }),

        // Build Cost Estimator
        vscode.commands.registerCommand('amplify-monitor.buildCostEstimator', () => {
            BuildCostPanel.createOrShow(context.extensionUri, cli);
        }),

        // Build Queue Visualization
        vscode.commands.registerCommand('amplify-monitor.buildQueue', () => {
            BuildQueuePanel.createOrShow(context.extensionUri, cli);
        }),

        // Rollback Helper
        vscode.commands.registerCommand('amplify-monitor.rollbackHelper', () => {
            RollbackHelperPanel.createOrShow(context.extensionUri, cli);
        }),

        // PR Preview Environments
        vscode.commands.registerCommand('amplify-monitor.previewEnvironments', () => {
            PreviewEnvironmentsPanel.createOrShow(context.extensionUri, cli);
        }),

        // Performance Alerts
        vscode.commands.registerCommand('amplify-monitor.performanceAlerts', () => {
            PerformanceAlertsPanel.createOrShow(context.extensionUri, cli);
        }),

        // Webhook Notifications
        vscode.commands.registerCommand('amplify-monitor.configureWebhook', () => {
            configureWebhook();
        }),

        vscode.commands.registerCommand('amplify-monitor.testWebhook', () => {
            WebhookNotificationService.getInstance().testWebhook();
        }),

        vscode.commands.registerCommand('amplify-monitor.showWebhookLogs', () => {
            WebhookNotificationService.getInstance().showOutput();
        }),

        // Multi-Account Commands
        vscode.commands.registerCommand('amplify-monitor.toggleMultiAccount', async () => {
            // Open Multi-Account Panel
            MultiAccountPanel.createOrShow(context.extensionUri, cli);
        }),

        vscode.commands.registerCommand('amplify-monitor.selectMultiAccountProfiles', async () => {
            // Open Multi-Account Panel
            MultiAccountPanel.createOrShow(context.extensionUri, cli);
        }),

        // Profile Configuration Wizard
        vscode.commands.registerCommand('amplify-monitor.configureProfile', async () => {
            await configureAwsProfile();
        }),

        appsView,
        jobsView,
        diagnosisView,
        envVarsView,
        migrationView
    );

    // Setup auto-refresh if enabled
    setupAutoRefresh(appsProvider, jobsProvider);

    // Watch for config changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async e => {
            if (e.affectsConfiguration('amplifyMonitor.autoRefresh') || 
                e.affectsConfiguration('amplifyMonitor.autoRefreshInterval')) {
                setupAutoRefresh(appsProvider, jobsProvider);
            }
            // Refresh views when AWS profile or multi-account settings change
            if (e.affectsConfiguration('amplifyMonitor.awsProfile') ||
                e.affectsConfiguration('amplifyMonitor.multiAccount')) {
                await Promise.all([
                    appsProvider.refresh(),
                    jobsProvider.refresh()
                ]);
            }
        })
    );
}

async function runDiagnosis(cli: AmplifyMonitorCli, provider: DiagnosisTreeProvider) {
    const config = vscode.workspace.getConfiguration('amplifyMonitor');
    let appId = config.get<string>('defaultAppId') || cli.getSelectedApp();
    const branch = config.get<string>('defaultBranch') || cli.getSelectedBranch() || 'main';

    if (!appId) {
        appId = await vscode.window.showInputBox({
            prompt: 'Enter Amplify App ID',
            placeHolder: 'e.g., d1234567890'
        });
        if (!appId) {
            return;
        }
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Diagnosing Amplify build...',
        cancellable: false
    }, async () => {
        try {
            await provider.runDiagnosis(appId!, branch);
        } catch (error) {
            vscode.window.showErrorMessage(`Diagnosis failed: ${error}`);
        }
    });
}

async function runDiagnosisForJob(
    cli: AmplifyMonitorCli,
    provider: DiagnosisTreeProvider,
    appId: string,
    branch: string,
    jobId: string
) {
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Diagnosing job ${jobId}...`,
        cancellable: false
    }, async () => {
        try {
            await provider.runDiagnosis(appId, branch, jobId);
        } catch (error) {
            vscode.window.showErrorMessage(`Diagnosis failed: ${error}`);
        }
    });
}

function setupAutoRefresh(appsProvider: AppsTreeProvider, jobsProvider: JobsTreeProvider) {
    if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = undefined;
    }

    const config = vscode.workspace.getConfiguration('amplifyMonitor');
    const autoRefresh = config.get<boolean>('autoRefresh');
    const interval = config.get<number>('autoRefreshInterval') || 60;

    if (autoRefresh) {
        refreshInterval = setInterval(async () => {
            await Promise.all([
                appsProvider.refresh(),
                jobsProvider.refresh()
            ]);
        }, interval * 1000);
    }
}

async function autoDetectAndInitialize(
    cli: AmplifyMonitorCli, 
    appsProvider: AppsTreeProvider, 
    migrationProvider: MigrationTreeProvider,
    context: vscode.ExtensionContext
) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    
    // Check for Amplify project in workspace
    let hasAmplifyProject = false;
    let amplifyProjectPath: string | undefined;
    
    if (workspaceFolders) {
        for (const folder of workspaceFolders) {
            const amplifyPath = path.join(folder.uri.fsPath, 'amplify');
            if (fs.existsSync(amplifyPath)) {
                hasAmplifyProject = true;
                amplifyProjectPath = folder.uri.fsPath;
                break;
            }
        }
    }

    // Try to fetch apps to check AWS connection
    try {
        const apps = await cli.listApps(true);
        
        // Show notification if Amplify project found
        if (hasAmplifyProject) {
            const action = await vscode.window.showInformationMessage(
                `🚀 Amplify project detected! Found ${apps.length} app${apps.length !== 1 ? 's' : ''} in your AWS account.`,
                'Analyze Migration',
                'View Apps'
            );
            
            if (action === 'Analyze Migration' && amplifyProjectPath) {
                // Run migration analysis
                try {
                    const analysis = await cli.analyzeMigration(amplifyProjectPath);
                    migrationProvider.setAnalysis(analysis);
                    
                    if (analysis.generation === 'Gen1') {
                        vscode.window.showInformationMessage(
                            `Migration Analysis: ${analysis.summary.fullySupported}/${analysis.summary.totalFeatures} features ready for Gen2`
                        );
                    }
                } catch {
                    // Silently fail migration analysis
                }
            } else if (action === 'View Apps') {
                vscode.commands.executeCommand('amplifyApps.focus');
            }
        } else if (apps.length > 0) {
            // No local project but apps found in AWS
            vscode.window.showInformationMessage(
                `Found ${apps.length} Amplify app${apps.length !== 1 ? 's' : ''} in your AWS account.`,
                'View Apps'
            ).then(action => {
                if (action === 'View Apps') {
                    vscode.commands.executeCommand('amplifyApps.focus');
                }
            });
        }
        
        // Refresh apps view
        appsProvider.refresh();
        
    } catch (error) {
        if (hasAmplifyProject) {
            // Amplify project found but no AWS credentials
            const action = await vscode.window.showWarningMessage(
                '🔐 Amplify project detected but AWS credentials not configured.',
                'Configure Credentials',
                'Analyze Locally'
            );
            
            if (action === 'Configure Credentials') {
                vscode.commands.executeCommand('amplify-monitor.openSettings');
            } else if (action === 'Analyze Locally' && amplifyProjectPath) {
                // Run local migration analysis (doesn't need AWS)
                try {
                    const analysis = await cli.analyzeMigration(amplifyProjectPath);
                    migrationProvider.setAnalysis(analysis);
                } catch {
                    // Silently fail
                }
            }
        }
    }
    
    // Watch for workspace changes to detect new Amplify projects
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(async () => {
            // Re-run detection when workspace folders change
            autoDetectAndInitialize(cli, appsProvider, migrationProvider, context);
        })
    );
}

export function deactivate() {
    if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = undefined;
    }
}

// Helper function to get AWS profiles from credentials and config files
async function getAwsProfiles(): Promise<string[]> {
    const os = require('os');
    const profiles = new Set<string>();
    
    const configPath = process.env.AWS_CONFIG_FILE || path.join(os.homedir(), '.aws', 'config');
    const credentialsPath = process.env.AWS_SHARED_CREDENTIALS_FILE || path.join(os.homedir(), '.aws', 'credentials');
    
    // Parse credentials file
    if (fs.existsSync(credentialsPath)) {
        const content = fs.readFileSync(credentialsPath, 'utf-8');
        const matches = content.match(/^\[([^\]]+)\]/gm);
        if (matches) {
            for (const match of matches) {
                profiles.add(match.slice(1, -1));
            }
        }
    }
    
    // Parse config file
    if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, 'utf-8');
        const matches = content.match(/^\[([^\]]+)\]/gm);
        if (matches) {
            for (const match of matches) {
                let name = match.slice(1, -1);
                if (name.startsWith('profile ')) {
                    name = name.substring(8);
                }
                profiles.add(name);
            }
        }
    }
    
    return Array.from(profiles).sort((a, b) => {
        if (a === 'default') return -1;
        if (b === 'default') return 1;
        return a.localeCompare(b);
    });
}
