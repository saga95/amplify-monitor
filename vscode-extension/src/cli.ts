import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface AmplifyApp {
    appId: string;
    name: string;
    repository?: string;
    defaultDomain: string;
    region?: string;
}

export interface AmplifyBranch {
    branchName: string;
    displayName: string;
}

export interface AmplifyJob {
    jobId: string;
    branch: string;
    status: string;
    startTime?: string;
    endTime?: string;
}

export interface DiagnosisIssue {
    pattern: string;
    rootCause: string;
    suggestedFixes: string[];
}

export interface DiagnosisResult {
    appId: string;
    branch: string;
    jobId: string;
    status: string;
    issues: DiagnosisIssue[];
}

export class AmplifyMonitorCli {
    private selectedApp: string | undefined;
    private selectedBranch: string | undefined;
    private selectedRegion: string | undefined;

    getCliPath(): string {
        const config = vscode.workspace.getConfiguration('amplifyMonitor');
        return config.get<string>('cliPath') || 'amplify-monitor';
    }

    setSelectedApp(appId: string, region?: string) {
        this.selectedApp = appId;
        this.selectedRegion = region;
    }

    getSelectedApp(): string | undefined {
        return this.selectedApp;
    }

    getSelectedRegion(): string | undefined {
        return this.selectedRegion;
    }

    setSelectedBranch(branch: string) {
        this.selectedBranch = branch;
    }

    getSelectedBranch(): string | undefined {
        return this.selectedBranch;
    }

    getAwsProfile(): string | undefined {
        const config = vscode.workspace.getConfiguration('amplifyMonitor');
        const profile = config.get<string>('awsProfile');
        return profile && profile.trim() !== '' ? profile.trim() : undefined;
    }

    private async runCommand<T>(args: string[], region?: string): Promise<T> {
        const cliPath = this.getCliPath();
        const fullArgs = ['--format', 'json'];
        
        // Add AWS profile if configured
        const profile = this.getAwsProfile();
        if (profile) {
            fullArgs.push('--profile', profile);
        }
        
        if (region) {
            fullArgs.push('--region', region);
        }
        
        fullArgs.push(...args);
        
        try {
            const { stdout } = await execFileAsync(cliPath, fullArgs, {
                timeout: 120000, // 2 minutes for multi-region scans
                maxBuffer: 10 * 1024 * 1024 // 10MB
            });
            return JSON.parse(stdout) as T;
        } catch (error: unknown) {
            if (error instanceof Error) {
                const execError = error as Error & { stderr?: string; code?: string };
                if (execError.code === 'ENOENT') {
                    throw new Error(
                        `amplify-monitor CLI not found at "${cliPath}". ` +
                        'Please install it or configure the path in settings.'
                    );
                }
                if (execError.stderr) {
                    throw new Error(execError.stderr);
                }
                throw error;
            }
            throw new Error('Unknown error occurred');
        }
    }

    async listApps(allRegions: boolean = false): Promise<AmplifyApp[]> {
        const args = ['apps'];
        if (allRegions) {
            args.push('--all-regions');
        }
        return this.runCommand<AmplifyApp[]>(args);
    }

    async listAppsInRegion(region: string): Promise<AmplifyApp[]> {
        return this.runCommand<AmplifyApp[]>(['apps'], region);
    }

    async listBranches(appId: string, region?: string): Promise<AmplifyBranch[]> {
        return this.runCommand<AmplifyBranch[]>(['branches', '--app-id', appId], region);
    }

    async listJobs(appId: string, branch: string, region?: string): Promise<AmplifyJob[]> {
        return this.runCommand<AmplifyJob[]>(['jobs', '--app-id', appId, '--branch', branch], region);
    }

    async diagnose(appId: string, branch: string, jobId?: string, region?: string): Promise<DiagnosisResult> {
        const args = ['diagnose', '--app-id', appId, '--branch', branch];
        if (jobId) {
            args.push('--job-id', jobId);
        }
        return this.runCommand<DiagnosisResult>(args, region);
    }

    async getLatestFailedJob(appId: string, branch: string, region?: string): Promise<AmplifyJob | null> {
        try {
            return await this.runCommand<AmplifyJob>(['latest-failed', '--app-id', appId, '--branch', branch], region);
        } catch {
            return null;
        }
    }
}
