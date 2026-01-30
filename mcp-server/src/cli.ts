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

export interface EnvVariable {
    name: string;
    value: string;
}

export interface StartJobResult {
    jobId: string;
    status: string;
}

export interface StopJobResult {
    jobId: string;
    status: string;
}

export interface MigrationFeature {
    category: string;
    feature: string;
    filePath?: string;
    lineNumber?: number;
    compatibility: unknown;
    migrationHint: string;
}

export interface MigrationSummary {
    totalFeatures: number;
    fullySupported: number;
    supportedWithCdk: number;
    notSupported: number;
    manualMigration: number;
}

export interface MigrationAnalysis {
    generation: string;
    projectPath: string;
    categoriesDetected: string[];
    features: MigrationFeature[];
    readyForMigration: boolean;
    blockingIssues: string[];
    warnings: string[];
    summary: MigrationSummary;
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

    async getEnvVariables(appId: string, branch: string, region?: string, profile?: string): Promise<EnvVariable[]> {
        return this.runCommand<EnvVariable[]>(['env-vars', '--app-id', appId, '--branch', branch], region, profile);
    }

    async setEnvVariable(appId: string, branch: string, name: string, value: string, region?: string, profile?: string): Promise<void> {
        await this.runCommand<{ success: boolean }>(['set-env', '--app-id', appId, '--branch', branch, '--name', name, '--value', value], region, profile);
    }

    async deleteEnvVariable(appId: string, branch: string, name: string, region?: string, profile?: string): Promise<void> {
        await this.runCommand<{ success: boolean }>(['delete-env', '--app-id', appId, '--branch', branch, '--name', name], region, profile);
    }

    async startBuild(appId: string, branch: string, region?: string, profile?: string): Promise<StartJobResult> {
        return this.runCommand<StartJobResult>(['start-build', '--app-id', appId, '--branch', branch], region, profile);
    }

    async stopBuild(appId: string, branch: string, jobId: string, region?: string, profile?: string): Promise<StopJobResult> {
        return this.runCommand<StopJobResult>(['stop-build', '--app-id', appId, '--branch', branch, '--job-id', jobId], region, profile);
    }

    async analyzeMigration(projectPath: string): Promise<MigrationAnalysis> {
        return this.runCommand<MigrationAnalysis>(['migration-analysis', '--path', projectPath]);
    }
}
