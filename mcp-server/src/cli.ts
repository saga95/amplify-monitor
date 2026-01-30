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
    private cliPath: string;

    constructor(cliPath: string = 'amplify-monitor') {
        this.cliPath = cliPath;
    }

    private async runCommand<T>(args: string[], region?: string, profile?: string): Promise<T> {
        const fullArgs = ['--format', 'json'];
        
        if (profile) {
            fullArgs.push('--profile', profile);
        }
        
        if (region) {
            fullArgs.push('--region', region);
        }
        
        fullArgs.push(...args);
        
        try {
            const { stdout } = await execFileAsync(this.cliPath, fullArgs, {
                timeout: 120000,
                maxBuffer: 10 * 1024 * 1024
            });
            return JSON.parse(stdout) as T;
        } catch (error: unknown) {
            if (error instanceof Error) {
                const execError = error as Error & { stderr?: string; code?: string };
                if (execError.code === 'ENOENT') {
                    throw new Error(
                        `amplify-monitor CLI not found at "${this.cliPath}". ` +
                        'Please install it first.'
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

    async listApps(allRegions: boolean = true, region?: string, profile?: string): Promise<AmplifyApp[]> {
        const args = ['apps'];
        if (allRegions && !region) {
            args.push('--all-regions');
        }
        return this.runCommand<AmplifyApp[]>(args, region, profile);
    }

    async listBranches(appId: string, region?: string, profile?: string): Promise<AmplifyBranch[]> {
        return this.runCommand<AmplifyBranch[]>(['branches', '--app-id', appId], region, profile);
    }

    async listJobs(appId: string, branch: string, region?: string, profile?: string): Promise<AmplifyJob[]> {
        return this.runCommand<AmplifyJob[]>(['jobs', '--app-id', appId, '--branch', branch], region, profile);
    }

    async diagnose(appId: string, branch: string, jobId?: string, region?: string, profile?: string): Promise<DiagnosisResult> {
        const args = ['diagnose', '--app-id', appId, '--branch', branch];
        if (jobId) {
            args.push('--job-id', jobId);
        }
        return this.runCommand<DiagnosisResult>(args, region, profile);
    }

    async getLatestFailedJob(appId: string, branch: string, region?: string, profile?: string): Promise<AmplifyJob | null> {
        try {
            return await this.runCommand<AmplifyJob>(['latest-failed', '--app-id', appId, '--branch', branch], region, profile);
        } catch {
            return null;
        }
    }
}
