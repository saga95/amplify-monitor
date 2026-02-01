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
    rawLogs?: string;
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
    compatibility: MigrationCompatibility;
    migrationHint: string;
}

export type MigrationCompatibility = 
    | { type: 'Supported' }
    | { type: 'SupportedWithCdk' }
    | { type: 'NotSupported'; alternative: string }
    | { type: 'ManualMigration'; reason: string };

export interface MigrationSummary {
    totalFeatures: number;
    fullySupported: number;
    supportedWithCdk: number;
    notSupported: number;
    manualMigration: number;
}

export interface MigrationAnalysis {
    generation: 'Gen1' | 'Gen2' | 'Unknown';
    projectPath: string;
    categoriesDetected: string[];
    features: MigrationFeature[];
    readyForMigration: boolean;
    blockingIssues: string[];
    warnings: string[];
    summary: MigrationSummary;
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

    /**
     * Validate that a parameter is a proper string, not an object
     */
    private validateStringParam(name: string, value: unknown): string {
        if (value === null || value === undefined) {
            throw new Error(`${name} is required but was not provided`);
        }
        if (typeof value === 'object') {
            throw new Error(`${name} must be a string, received object: ${JSON.stringify(value)}`);
        }
        const strValue = String(value);
        if (!strValue || strValue === 'undefined' || strValue === '[object Object]') {
            throw new Error(`${name} has invalid value: "${strValue}"`);
        }
        return strValue;
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
                    // Parse and improve common error messages
                    const stderr = execError.stderr;
                    
                    // AWS API errors
                    if (stderr.includes('NotFoundException')) {
                        const appIdMatch = stderr.match(/App ([a-z0-9]+) not found/i);
                        if (appIdMatch) {
                            throw new Error(`App not found: "${appIdMatch[1]}". Please check the App ID in your Amplify Console.`);
                        }
                        throw new Error('Resource not found. The app, branch, or job may have been deleted.');
                    }
                    
                    if (stderr.includes('ValidationException')) {
                        throw new Error('Invalid parameters. Please ensure all values are correct strings, not objects.');
                    }
                    
                    if (stderr.includes('AccessDeniedException') || stderr.includes('UnauthorizedAccess')) {
                        throw new Error('AWS access denied. Please check your credentials and permissions.');
                    }
                    
                    if (stderr.includes('ExpiredTokenException') || stderr.includes('expired')) {
                        throw new Error('AWS credentials have expired. Please refresh your credentials.');
                    }
                    
                    // CLI errors
                    if (stderr.includes('unrecognized subcommand')) {
                        const cmdMatch = stderr.match(/unrecognized subcommand '([^']+)'/);
                        throw new Error(
                            `CLI command not available: "${cmdMatch?.[1] || 'unknown'}". ` +
                            'Please update the amplify-monitor CLI to the latest version.'
                        );
                    }
                    
                    throw new Error(stderr);
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
        const validAppId = this.validateStringParam('appId', appId);
        return this.runCommand<AmplifyBranch[]>(['branches', '--app-id', validAppId], region);
    }

    async listJobs(appId: string, branch: string, region?: string): Promise<AmplifyJob[]> {
        const validAppId = this.validateStringParam('appId', appId);
        const validBranch = this.validateStringParam('branch', branch);
        return this.runCommand<AmplifyJob[]>(['jobs', '--app-id', validAppId, '--branch', validBranch], region);
    }

    async diagnose(appId: string, branch: string, jobId?: string, region?: string): Promise<DiagnosisResult> {
        const validAppId = this.validateStringParam('appId', appId);
        const validBranch = this.validateStringParam('branch', branch);
        const args = ['diagnose', '--app-id', validAppId, '--branch', validBranch];
        if (jobId) {
            const validJobId = this.validateStringParam('jobId', jobId);
            args.push('--job-id', validJobId);
        }
        return this.runCommand<DiagnosisResult>(args, region);
    }

    async getLatestFailedJob(appId: string, branch: string, region?: string): Promise<AmplifyJob | null> {
        try {
            const validAppId = this.validateStringParam('appId', appId);
            const validBranch = this.validateStringParam('branch', branch);
            return await this.runCommand<AmplifyJob>(['latest-failed', '--app-id', validAppId, '--branch', validBranch], region);
        } catch {
            return null;
        }
    }

    async getEnvVariables(appId: string, branch: string, region?: string): Promise<EnvVariable[]> {
        const validAppId = this.validateStringParam('appId', appId);
        const validBranch = this.validateStringParam('branch', branch);
        return this.runCommand<EnvVariable[]>(['env-vars', '--app-id', validAppId, '--branch', validBranch], region);
    }

    async setEnvVariable(appId: string, branch: string, name: string, value: string, region?: string): Promise<void> {
        const validAppId = this.validateStringParam('appId', appId);
        const validBranch = this.validateStringParam('branch', branch);
        const validName = this.validateStringParam('name', name);
        await this.runCommand(['set-env', '--app-id', validAppId, '--branch', validBranch, '--name', validName, '--value', value], region);
    }

    async deleteEnvVariable(appId: string, branch: string, name: string, region?: string): Promise<void> {
        const validAppId = this.validateStringParam('appId', appId);
        const validBranch = this.validateStringParam('branch', branch);
        const validName = this.validateStringParam('name', name);
        await this.runCommand(['delete-env', '--app-id', validAppId, '--branch', validBranch, '--name', validName], region);
    }

    async startBuild(appId: string, branch: string, region?: string): Promise<StartJobResult> {
        const validAppId = this.validateStringParam('appId', appId);
        const validBranch = this.validateStringParam('branch', branch);
        return this.runCommand<StartJobResult>(['start-build', '--app-id', validAppId, '--branch', validBranch], region);
    }

    async stopBuild(appId: string, branch: string, jobId: string, region?: string): Promise<StopJobResult> {
        const validAppId = this.validateStringParam('appId', appId);
        const validBranch = this.validateStringParam('branch', branch);
        const validJobId = this.validateStringParam('jobId', jobId);
        return this.runCommand<StopJobResult>(['stop-build', '--app-id', validAppId, '--branch', validBranch, '--job-id', validJobId], region);
    }

    async analyzeMigration(projectPath: string): Promise<MigrationAnalysis> {
        const validPath = this.validateStringParam('projectPath', projectPath);
        return this.runCommand<MigrationAnalysis>(['migration-analysis', '--path', validPath]);
    }

    async getBuildLogs(appId: string, branch: string, jobId: string, region?: string): Promise<string> {
        const validAppId = this.validateStringParam('appId', appId);
        const validBranch = this.validateStringParam('branch', branch);
        const validJobId = this.validateStringParam('jobId', jobId);
        
        try {
            const result = await this.runCommand<{ logs: string }>(['logs', '--app-id', validAppId, '--branch', validBranch, '--job-id', validJobId], region);
            return result.logs || '';
        } catch {
            // Fallback: try to get logs from diagnosis
            const diagnosis = await this.diagnose(validAppId, validBranch, validJobId, region);
            return diagnosis.rawLogs || '';
        }
    }

    async diagnoseWithLogs(appId: string, branch: string, jobId?: string, region?: string): Promise<DiagnosisResult & { rawLogs: string }> {
        const validAppId = this.validateStringParam('appId', appId);
        const validBranch = this.validateStringParam('branch', branch);
        const args = ['diagnose', '--app-id', validAppId, '--branch', validBranch, '--include-logs'];
        if (jobId) {
            const validJobId = this.validateStringParam('jobId', jobId);
            args.push('--job-id', validJobId);
        }
        return this.runCommand<DiagnosisResult & { rawLogs: string }>(args, region);
    }
}
