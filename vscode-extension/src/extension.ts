import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AmplifyMonitorCli } from './cli';
import { AppsTreeProvider } from './views/appsTree';
import { JobsTreeProvider } from './views/jobsTree';
import { DiagnosisTreeProvider } from './views/diagnosisTree';
import { EnvVarsTreeProvider } from './views/envVarsTree';
import { MigrationTreeProvider } from './views/migrationTree';

let refreshInterval: NodeJS.Timeout | undefined;
let profileStatusBarItem: vscode.StatusBarItem;
let connectionStatusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
    console.log('Amplify Monitor extension is now active');

    const cli = new AmplifyMonitorCli();
    
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

    // Create status bar item for AWS profile
    profileStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    profileStatusBarItem.command = 'amplify-monitor.switchProfile';
    profileStatusBarItem.tooltip = 'Click to switch AWS profile';
    updateProfileStatusBar(cli);
    profileStatusBarItem.show();

    // Create connection status bar item
    connectionStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    connectionStatusBarItem.command = 'amplify-monitor.listApps';
    connectionStatusBarItem.text = '$(sync~spin) Amplify: Connecting...';
    connectionStatusBarItem.tooltip = 'Click to refresh Amplify apps';
    connectionStatusBarItem.show();

    // Auto-detect Amplify project and fetch apps on startup
    autoDetectAndInitialize(cli, appsProvider, migrationProvider, context);

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('amplify-monitor.listApps', async () => {
            await appsProvider.refresh();
            vscode.window.showInformationMessage('Amplify apps refreshed');
        }),

        vscode.commands.registerCommand('amplify-monitor.diagnose', async () => {
            await runDiagnosis(cli, diagnosisProvider);
        }),

        vscode.commands.registerCommand('amplify-monitor.selectApp', async (appId: string, region?: string) => {
            cli.setSelectedApp(appId, region);
            
            // Auto-select the first branch for this app
            try {
                const branches = await cli.listBranches(appId, region);
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
            vscode.window.showInformationMessage(`Selected app: ${appId}${regionInfo}`);
        }),

        vscode.commands.registerCommand('amplify-monitor.selectBranch', async (branch: string) => {
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

        vscode.commands.registerCommand('amplify-monitor.diagnoseJob', async (appId: string, branch: string, jobId: string) => {
            await runDiagnosisForJob(cli, diagnosisProvider, appId, branch, jobId);
        }),

        vscode.commands.registerCommand('amplify-monitor.copyIssue', async (item: { issue?: { pattern: string; rootCause: string; suggestedFixes: string[] } }) => {
            if (item?.issue) {
                const text = `Issue: ${item.issue.pattern}\nRoot Cause: ${item.issue.rootCause}\nSuggested Fixes:\n${item.issue.suggestedFixes.map((f, i) => `${i + 1}. ${f}`).join('\n')}`;
                await vscode.env.clipboard.writeText(text);
                vscode.window.showInformationMessage('Issue details copied to clipboard');
            }
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
                
                // Update status bar immediately
                updateProfileStatusBar(cli);
                
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
            // Refresh views when AWS profile changes
            if (e.affectsConfiguration('amplifyMonitor.awsProfile')) {
                updateProfileStatusBar(cli);
                await Promise.all([
                    appsProvider.refresh(),
                    jobsProvider.refresh()
                ]);
            }
        })
    );

    // Add status bar to subscriptions for cleanup
    context.subscriptions.push(profileStatusBarItem);
    context.subscriptions.push(connectionStatusBarItem);
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

function updateProfileStatusBar(cli: AmplifyMonitorCli) {
    const profile = cli.getAwsProfile() || 'default';
    profileStatusBarItem.text = `$(account) AWS: ${profile}`;
}

function updateConnectionStatus(connected: boolean, appCount?: number) {
    if (connected && appCount !== undefined) {
        connectionStatusBarItem.text = `$(cloud) Amplify: ${appCount} app${appCount !== 1 ? 's' : ''}`;
        connectionStatusBarItem.backgroundColor = undefined;
        connectionStatusBarItem.tooltip = `Connected - ${appCount} Amplify app${appCount !== 1 ? 's' : ''} found. Click to refresh.`;
    } else if (connected) {
        connectionStatusBarItem.text = '$(cloud) Amplify: Connected';
        connectionStatusBarItem.backgroundColor = undefined;
        connectionStatusBarItem.tooltip = 'Connected to AWS. Click to refresh apps.';
    } else {
        connectionStatusBarItem.text = '$(cloud-offline) Amplify: Not Connected';
        connectionStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        connectionStatusBarItem.tooltip = 'Could not connect to AWS. Click to retry or configure credentials.';
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
        updateConnectionStatus(true, apps.length);
        
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
        updateConnectionStatus(false);
        
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
    if (profileStatusBarItem) {
        profileStatusBarItem.dispose();
    }
}
