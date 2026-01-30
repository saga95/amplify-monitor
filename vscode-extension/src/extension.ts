import * as vscode from 'vscode';
import { AmplifyMonitorCli } from './cli';
import { AppsTreeProvider } from './views/appsTree';
import { JobsTreeProvider } from './views/jobsTree';
import { DiagnosisTreeProvider } from './views/diagnosisTree';

let refreshInterval: NodeJS.Timeout | undefined;
let profileStatusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
    console.log('Amplify Monitor extension is now active');

    const cli = new AmplifyMonitorCli();
    
    // Create tree data providers
    const appsProvider = new AppsTreeProvider(cli);
    const jobsProvider = new JobsTreeProvider(cli);
    const diagnosisProvider = new DiagnosisTreeProvider(cli);

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

    // Create status bar item for AWS profile
    profileStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    profileStatusBarItem.command = 'amplify-monitor.switchProfile';
    profileStatusBarItem.tooltip = 'Click to switch AWS profile';
    updateProfileStatusBar(cli);
    profileStatusBarItem.show();

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
            } catch {
                // Ignore errors fetching branches
            }
            
            await jobsProvider.refresh();
            const regionInfo = region ? ` (${region})` : '';
            vscode.window.showInformationMessage(`Selected app: ${appId}${regionInfo}`);
        }),

        vscode.commands.registerCommand('amplify-monitor.selectBranch', async (branch: string) => {
            cli.setSelectedBranch(branch);
            await jobsProvider.refresh();
        }),

        vscode.commands.registerCommand('amplify-monitor.refresh', async () => {
            await Promise.all([
                appsProvider.refresh(),
                jobsProvider.refresh()
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

        appsView,
        jobsView,
        diagnosisView
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

