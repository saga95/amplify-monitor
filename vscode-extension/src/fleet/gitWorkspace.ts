import { execFile } from 'child_process';
import { ACTIVE_JOB_STATUSES, FleetAccount, WorkspaceDeployment, WorkspaceRepo, normalizeRepoUrl } from './types';

export interface LocalRepoInfo {
    folder: string;
    repoKeys: string[];
    localBranch?: string;
    headCommit?: string;
    headSubject?: string;
}

function git(folder: string, args: string[]): Promise<string | undefined> {
    return new Promise(resolve => {
        execFile('git', ['-C', folder, ...args], { timeout: 5000, windowsHide: true }, (error, stdout) => {
            resolve(error ? undefined : stdout.trim());
        });
    });
}

export async function readLocalRepo(folder: string): Promise<LocalRepoInfo | undefined> {
    const remotes = await git(folder, ['remote', '-v']);
    if (!remotes) {
        return undefined;
    }
    const repoKeys = new Set<string>();
    for (const line of remotes.split('\n')) {
        const url = line.split(/\s+/)[1];
        const key = normalizeRepoUrl(url);
        if (key) {
            repoKeys.add(key);
        }
    }
    if (repoKeys.size === 0) {
        return undefined;
    }
    const [branch, head, subject] = await Promise.all([
        git(folder, ['rev-parse', '--abbrev-ref', 'HEAD']),
        git(folder, ['rev-parse', 'HEAD']),
        git(folder, ['log', '-1', '--format=%s']),
    ]);
    return {
        folder,
        repoKeys: Array.from(repoKeys),
        localBranch: branch && branch !== 'HEAD' ? branch : undefined,
        headCommit: head,
        headSubject: subject,
    };
}

/**
 * Link local repositories to the Amplify branches built from them, and work out
 * whether the local HEAD commit has been built and deployed yet.
 */
export function matchWorkspace(repos: LocalRepoInfo[], accounts: FleetAccount[]): WorkspaceRepo[] {
    const result: WorkspaceRepo[] = [];
    for (const repo of repos) {
        const deployments: WorkspaceDeployment[] = [];
        let matchedKey = repo.repoKeys[0];
        for (const account of accounts) {
            for (const app of account.apps) {
                if (!app.repoKey || !repo.repoKeys.includes(app.repoKey)) {
                    continue;
                }
                matchedKey = app.repoKey;
                for (const branch of app.branches) {
                    const head = repo.headCommit?.toLowerCase();
                    const headJob = head ? branch.recentJobs.find(j => j.commitId?.toLowerCase() === head) : undefined;
                    const relevant = branch.branchName === repo.localBranch || branch.isProduction || !!headJob;
                    if (!relevant) {
                        continue;
                    }
                    let headState: WorkspaceDeployment['headState'] = 'unknown';
                    if (headJob) {
                        headState = headJob.status === 'SUCCEED' ? 'deployed'
                            : headJob.status === 'FAILED' ? 'failed'
                                : ACTIVE_JOB_STATUSES.has(headJob.status) ? 'building' : 'unknown';
                    } else if (head && branch.branchName === repo.localBranch) {
                        headState = 'not-built';
                    }
                    deployments.push({
                        profile: account.profile,
                        accountLabel: account.label,
                        appId: app.appId,
                        appName: app.name,
                        region: app.region,
                        branch: branch.branchName,
                        latestJob: branch.latestJob,
                        headJob,
                        headState,
                    });
                }
            }
        }
        result.push({
            folder: repo.folder,
            repoKey: matchedKey,
            localBranch: repo.localBranch,
            headCommit: repo.headCommit,
            headSubject: repo.headSubject,
            deployments,
        });
    }
    return result;
}
