import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface AmplifyApp {
    appId: string;
    name: string;
    repository?: string;
    defaultDomain: string;
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

    getCliPath(): string {
        const config = vscode.workspace.getConfiguration('amplifyMonitor');
        return config.get<string>('cliPath') || 'amplify-monitor';
    }

    setSelectedApp(appId: string) {
        this.selectedApp = appId;
    }

    getSelectedApp(): string | undefined {
        return this.selectedApp;
    }

    setSelectedBranch(branch: string) {
        this.selectedBranch = branch;
    }

    getSelectedBranch(): string | undefined {
        return this.selectedBranch;
    }

    private async runCommand<T>(args: string[]): Promise<T> {
        const cliPath = this.getCliPath();
        
        try {
            const { stdout } = await execFileAsync(cliPath, ['--format', 'json', ...args], {
                timeout: 60000,
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

    async listApps(): Promise<AmplifyApp[]> {
        return this.runCommand<AmplifyApp[]>(['apps']);
    }

    async listBranches(appId: string): Promise<AmplifyBranch[]> {
        return this.runCommand<AmplifyBranch[]>(['branches', '--app-id', appId]);
    }

    async listJobs(appId: string, branch: string): Promise<AmplifyJob[]> {
        return this.runCommand<AmplifyJob[]>(['jobs', '--app-id', appId, '--branch', branch]);
    }

    async diagnose(appId: string, branch: string, jobId?: string): Promise<DiagnosisResult> {
        const args = ['diagnose', '--app-id', appId, '--branch', branch];
        if (jobId) {
            args.push('--job-id', jobId);
        }
        return this.runCommand<DiagnosisResult>(args);
    }

    async getLatestFailedJob(appId: string, branch: string): Promise<AmplifyJob | null> {
        try {
            return await this.runCommand<AmplifyJob>(['latest-failed', '--app-id', appId, '--branch', branch]);
        } catch {
            return null;
        }
    }
}
