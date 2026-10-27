import { execFile } from 'child_process';

export type AwsCliErrorKind = 'auth-expired' | 'no-credentials' | 'access-denied' | 'not-installed' | 'timeout' | 'other';

export class AwsCliError extends Error {
    constructor(
        message: string,
        public readonly kind: AwsCliErrorKind,
        public readonly stderr?: string
    ) {
        super(message);
        this.name = 'AwsCliError';
    }
}

export interface AwsCliOptions {
    /** Path to the `aws` executable. */
    awsPath: string;
    /** Per-call timeout in milliseconds. */
    timeoutMs: number;
}

export interface RawAmplifyApp {
    appId: string;
    name: string;
    repository?: string;
    defaultDomain?: string;
    productionBranch?: { branchName?: string; status?: string; lastDeployTime?: string };
}

export interface RawAmplifyBranch {
    branchName: string;
    displayName?: string;
    stage?: string;
    activeJobId?: string;
    updateTime?: string;
}

export interface RawJobSummary {
    jobId: string;
    status: string;
    jobType?: string;
    commitId?: string;
    commitMessage?: string;
    commitTime?: string;
    startTime?: string;
    endTime?: string;
}

/** Regions where AWS Amplify Hosting is available (kept in sync with the Rust CLI's list). */
export const AMPLIFY_REGIONS = [
    'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
    'ca-central-1', 'sa-east-1',
    'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-north-1', 'eu-south-1',
    'ap-south-1', 'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3', 'ap-east-1',
    'me-south-1',
];

/**
 * Thin, read-only wrapper around the AWS CLI (`aws amplify ...`).
 *
 * Every call passes --profile and --region explicitly so several accounts can be
 * polled side by side without touching the developer's default profile, and
 * pagination/pager are disabled so output is always a single JSON document.
 */
export class AwsCliClient {
    constructor(private readonly getOptions: () => AwsCliOptions) {}

    async runJson<T>(args: string[], profile?: string, region?: string): Promise<T> {
        const stdout = await this.exec([...args, '--output', 'json'], profile, region);
        try {
            return JSON.parse(stdout) as T;
        } catch {
            throw new AwsCliError(`Unexpected AWS CLI output for "aws ${args.slice(0, 2).join(' ')}"`, 'other', stdout.slice(0, 500));
        }
    }

    async runText(args: string[], profile?: string, region?: string): Promise<string> {
        return (await this.exec([...args, '--output', 'text'], profile, region)).trim();
    }

    async getAccountId(profile: string): Promise<string> {
        return this.runText(['sts', 'get-caller-identity', '--query', 'Account'], profile);
    }

    async getProfileRegion(profile: string): Promise<string | undefined> {
        try {
            const region = await this.exec(['configure', 'get', 'region'], profile);
            return region.trim() || undefined;
        } catch {
            return undefined;
        }
    }

    async listApps(profile: string, region: string): Promise<RawAmplifyApp[]> {
        const result = await this.runJson<{ apps?: RawAmplifyApp[] }>(
            ['amplify', 'list-apps', '--no-paginate', '--max-results', '100'], profile, region);
        return result.apps ?? [];
    }

    async listBranches(profile: string, region: string, appId: string): Promise<RawAmplifyBranch[]> {
        const result = await this.runJson<{ branches?: RawAmplifyBranch[] }>(
            ['amplify', 'list-branches', '--app-id', appId, '--no-paginate', '--max-results', '50'], profile, region);
        return result.branches ?? [];
    }

    async listJobs(profile: string, region: string, appId: string, branch: string, maxResults: number): Promise<RawJobSummary[]> {
        const result = await this.runJson<{ jobSummaries?: RawJobSummary[] }>(
            ['amplify', 'list-jobs', '--app-id', appId, '--branch-name', branch, '--no-paginate', '--max-results', String(maxResults)],
            profile, region);
        return result.jobSummaries ?? [];
    }

    private exec(args: string[], profile?: string, region?: string): Promise<string> {
        const { awsPath, timeoutMs } = this.getOptions();
        const fullArgs = [...args];
        if (profile) {
            fullArgs.push('--profile', profile);
        }
        if (region) {
            fullArgs.push('--region', region);
        }

        return new Promise((resolve, reject) => {
            execFile(awsPath, fullArgs, {
                timeout: timeoutMs,
                maxBuffer: 20 * 1024 * 1024,
                windowsHide: true,
                // Never page output, never prompt interactively.
                env: { ...process.env, AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off' },
            }, (error, stdout, stderr) => {
                if (!error) {
                    resolve(stdout);
                    return;
                }
                reject(classifyAwsError(error as NodeJS.ErrnoException & { killed?: boolean }, String(stderr || ''), awsPath, profile));
            });
        });
    }
}

export function classifyAwsError(
    error: NodeJS.ErrnoException & { killed?: boolean },
    stderr: string,
    awsPath: string,
    profile?: string
): AwsCliError {
    const profileArg = profile ? ` --profile ${profile}` : '';
    if (error.code === 'ENOENT') {
        return new AwsCliError(
            `AWS CLI not found at "${awsPath}". Install AWS CLI v2 or set amplifyMonitor.fleet.awsCliPath.`,
            'not-installed');
    }
    if (error.killed) {
        return new AwsCliError('AWS CLI call timed out', 'timeout', stderr);
    }

    const text = stderr || error.message || '';
    const firstLine = text.split('\n').map(l => l.trim()).filter(Boolean).pop() || 'AWS CLI call failed';

    if (/sso.*(expired|invalid)|token has expired|expiredtoken|refresh failed|error loading sso token|session.*expired/i.test(text)) {
        if (/sso/i.test(text)) {
            return new AwsCliError(`SSO session expired. Run: aws sso login${profileArg}`, 'auth-expired', text);
        }
        return new AwsCliError(`Credentials expired for profile${profile ? ` "${profile}"` : ''}. Refresh the session credentials.`, 'auth-expired', text);
    }
    if (/unable to locate credentials|config profile .* could not be found|no credentials|partial credentials/i.test(text)) {
        return new AwsCliError(`No credentials for profile${profile ? ` "${profile}"` : ''}. ${firstLine}`, 'no-credentials', text);
    }
    if (/accessdenied|not authorized|unauthorized|invalidclienttokenid|signaturedoesnotmatch/i.test(text)) {
        return new AwsCliError(`Access denied: ${firstLine}`, 'access-denied', text);
    }
    return new AwsCliError(firstLine, 'other', text);
}

/** Simple promise concurrency limiter so a large fleet does not spawn dozens of CLI processes at once. */
export function createLimiter(maxConcurrent: number): <T>(task: () => Promise<T>) => Promise<T> {
    let active = 0;
    const waiting: Array<() => void> = [];
    const limit = Math.max(1, maxConcurrent);

    return async <T>(task: () => Promise<T>): Promise<T> => {
        if (active >= limit) {
            // Wait for a running task to hand its slot over (active stays constant).
            await new Promise<void>(resolve => waiting.push(resolve));
        } else {
            active++;
        }
        try {
            return await task();
        } finally {
            const next = waiting.shift();
            if (next) {
                next();
            } else {
                active--;
            }
        }
    };
}
