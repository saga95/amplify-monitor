import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { AwsCliClient } from './awsCli';
import { JOB_META, JobLogStep, JobLogTarget, JobLogs, extractErrorLines, jobLogDir, readJobLogs, stripAnsi } from './buildLogs';
import { TERMINAL_JOB_STATUSES, amplifyConsoleUrl } from './types';

const MAX_LOG_BYTES = 25 * 1024 * 1024;

interface RawJob {
    job?: {
        summary?: { jobId: string; status: string; commitId?: string; commitMessage?: string };
        steps?: Array<{ stepName: string; status: string; startTime?: string; endTime?: string; logUrl?: string }>;
    };
}

/** Download a pre-signed S3 log URL (no AWS credentials needed). */
function download(url: string): Promise<{ text: string; truncated: boolean }> {
    return new Promise((resolve, reject) => {
        const request = https.get(url, { timeout: 60_000 }, response => {
            if (response.statusCode && response.statusCode >= 400) {
                response.resume();
                reject(new Error(`Log download failed with HTTP ${response.statusCode}`));
                return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            let truncated = false;
            response.on('data', (chunk: Buffer) => {
                if (size >= MAX_LOG_BYTES) {
                    truncated = true;
                    return;
                }
                chunks.push(chunk);
                size += chunk.length;
            });
            response.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf-8'), truncated }));
            response.on('error', reject);
        });
        request.on('timeout', () => request.destroy(new Error('Log download timed out')));
        request.on('error', reject);
    });
}

/**
 * Fetch the logs of one Amplify job with the AWS CLI and cache them on disk.
 * Finished jobs are immutable, so a complete cache entry is reused unless `force` is set.
 */
export async function fetchJobLogs(client: AwsCliClient, fleetDir: string, target: JobLogTarget, force = false): Promise<JobLogs> {
    const cached = readJobLogs(fleetDir, target);
    if (cached && cached.complete && !force) {
        return cached;
    }

    const raw = await client.runJson<RawJob>(
        ['amplify', 'get-job', '--app-id', target.appId, '--branch-name', target.branch, '--job-id', target.jobId],
        target.profile, target.region);
    const summary = raw.job?.summary;
    const dir = jobLogDir(fleetDir, target);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    const steps: JobLogStep[] = [];
    const errorLines: string[] = [];
    for (const step of raw.job?.steps ?? []) {
        const entry: JobLogStep = { stepName: step.stepName, status: step.status, startTime: step.startTime, endTime: step.endTime, bytes: 0, lines: 0 };
        if (step.logUrl) {
            try {
                const { text, truncated } = await download(step.logUrl);
                const clean = stripAnsi(text);
                if (clean.trim()) {
                    const file = path.join(dir, `${step.stepName.replace(/[^A-Za-z0-9_-]/g, '_')}.txt`);
                    fs.writeFileSync(file, clean, { mode: 0o600 });
                    entry.file = file;
                    entry.bytes = Buffer.byteLength(clean);
                    entry.lines = clean.split('\n').length;
                    entry.truncated = truncated || undefined;
                    errorLines.push(...extractErrorLines(clean).map(l => `[${step.stepName}] ${l}`));
                }
            } catch (error) {
                entry.status = `${step.status} (log unavailable: ${error instanceof Error ? error.message : error})`;
            }
        }
        steps.push(entry);
    }

    const status = summary?.status ?? 'UNKNOWN';
    const logs: JobLogs = {
        ...target,
        status,
        commitId: summary?.commitId,
        commitMessage: summary?.commitMessage?.trim(),
        fetchedAt: new Date().toISOString(),
        complete: TERMINAL_JOB_STATUSES.has(status),
        dir,
        consoleUrl: amplifyConsoleUrl(target.region, target.appId, target.branch, target.jobId),
        steps,
        errorLines: errorLines.slice(0, 80),
    };
    fs.writeFileSync(path.join(dir, JOB_META), JSON.stringify(logs, null, 2), { mode: 0o600 });
    return logs;
}
