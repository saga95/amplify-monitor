// Unit tests for the editor-independent fleet modules. Run: npm run test:fleet
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const out = path.join(__dirname, '..', 'out', 'fleet');
const { diffAccounts, selectBranches, summarize, collectAttention } = require(path.join(out, 'fleetPoller'));
const { matchWorkspace } = require(path.join(out, 'gitWorkspace'));
const { normalizeRepoUrl, worstHealth } = require(path.join(out, 'types'));
const { createLimiter, classifyAwsError } = require(path.join(out, 'awsCli'));
const { writeSnapshot, renderMarkdown } = require(path.join(out, 'snapshotStore'));

const clone = x => JSON.parse(JSON.stringify(x));
const SHA = 'abcdef1234567890abcdef1234567890abcdef12';

function job(jobId, status, commitId = SHA) {
    return { jobId, status, commitId, commitMessage: `commit ${jobId}`, startTime: '2026-10-01T10:00:00Z', endTime: '2026-10-01T10:05:00Z', consoleUrl: `https://console/${jobId}` };
}

function fleet() {
    const dev = { branchName: 'dev', isProduction: false, health: 'ok', consoleUrl: 'c', recentJobs: [job('2', 'SUCCEED')] };
    dev.latestJob = dev.recentJobs[0];
    const main = { branchName: 'main', isProduction: true, health: 'ok', consoleUrl: 'c', recentJobs: [job('9', 'SUCCEED', '9'.repeat(40))] };
    main.latestJob = main.recentJobs[0];
    return [{
        profile: 'client-a', label: 'Client A', accountId: '111111111111', regions: ['us-east-1'], status: 'ok', health: 'ok',
        apps: [{ appId: 'd1', name: 'web', region: 'us-east-1', repoKey: 'github.com/org/web', productionBranch: 'main', health: 'ok', consoleUrl: 'c', hiddenBranches: 0, branches: [main, dev] }],
    }];
}

function setLatest(accounts, branch, j) {
    const b = accounts[0].apps[0].branches.find(x => x.branchName === branch);
    if (b.recentJobs[0].jobId === j.jobId) { b.recentJobs[0] = j; } else { b.recentJobs.unshift(j); }
    b.latestJob = j;
    b.health = j.status === 'FAILED' ? 'failing' : j.status === 'SUCCEED' ? 'ok' : 'building';
}

test('diffAccounts emits started → failed transitions and nothing when unchanged', () => {
    const a = fleet();
    const b = clone(a); setLatest(b, 'dev', job('3', 'RUNNING'));
    assert.deepStrictEqual(diffAccounts(a, b).map(e => e.kind), ['started']);
    const c = clone(b); setLatest(c, 'dev', job('3', 'FAILED'));
    assert.deepStrictEqual(diffAccounts(b, c).map(e => [e.kind, e.from, e.to]), [['failed', 'RUNNING', 'FAILED']]);
    assert.strictEqual(diffAccounts(c, clone(c)).length, 0);
    assert.strictEqual(diffAccounts([], c).length, 0, 'first poll is a baseline');
});

test('diffAccounts reports account credential problems and recovery', () => {
    const ok = fleet();
    const bad = clone(ok); bad[0].status = 'auth-expired'; bad[0].error = 'SSO session expired';
    assert.deepStrictEqual(diffAccounts(ok, bad).map(e => e.kind), ['account-error']);
    assert.deepStrictEqual(diffAccounts(bad, ok).map(e => e.kind), ['account-recovered']);
});

test('summary and attention count failing branches and account errors', () => {
    const a = fleet(); setLatest(a, 'dev', job('3', 'FAILED'));
    a.push({ profile: 'client-b', label: 'Client B', regions: [], status: 'auth-expired', health: 'error', error: 'expired', fixCommand: 'aws sso login --profile client-b', apps: [] });
    const s = summarize(a);
    assert.strictEqual(s.failing, 1); assert.strictEqual(s.accountErrors, 1); assert.strictEqual(s.branches, 2);
    const att = collectAttention(a);
    assert.strictEqual(att[0].fixCommand, 'aws sso login --profile client-b');
    assert.match(att[1].message, /web \/ dev: job #3 FAILED/);
});

test('matchWorkspace tells whether local HEAD is deployed', () => {
    const a = fleet();
    const repo = { folder: '/w', repoKeys: ['github.com/org/web'], localBranch: 'dev', headCommit: SHA };
    assert.strictEqual(matchWorkspace([repo], a)[0].deployments.find(d => d.branch === 'dev').headState, 'deployed');
    setLatest(a, 'dev', job('2', 'RUNNING'));
    assert.strictEqual(matchWorkspace([repo], a)[0].deployments.find(d => d.branch === 'dev').headState, 'building');
    const other = matchWorkspace([{ ...repo, headCommit: '1'.repeat(40) }], a)[0].deployments;
    assert.strictEqual(other.find(d => d.branch === 'dev').headState, 'not-built');
    assert.ok(other.some(d => d.branch === 'main'), 'production branch is always listed');
});

test('normalizeRepoUrl handles ssh, https, credentials, ports and trailing slashes', () => {
    for (const u of ['git@github.com:Org/Repo.git', 'https://github.com/org/repo', 'https://user:tok@github.com/org/repo.git/', 'ssh://git@github.com:22/org/repo.git']) {
        assert.strictEqual(normalizeRepoUrl(u), 'github.com/org/repo', u);
    }
});

test('selectBranches keeps production first, applies globs and limits', () => {
    const branches = [{ branchName: 'a', updateTime: '2026-01-01' }, { branchName: 'main', updateTime: '2020-01-01' }, { branchName: 'release/1', updateTime: '2026-05-01' }];
    assert.deepStrictEqual(selectBranches(branches, ['release/*'], 'main', 5).map(b => b.branchName), ['main', 'release/1']);
    assert.deepStrictEqual(selectBranches(branches, [], 'main', 2).map(b => b.branchName), ['main', 'release/1']);
});

test('worstHealth ranks failing above building above ok', () => {
    assert.strictEqual(worstHealth(['ok', 'building', 'failing']), 'failing');
    assert.strictEqual(worstHealth(['ok', 'building']), 'building');
    assert.strictEqual(worstHealth([]), 'unknown');
});

test('classifyAwsError recognises SSO expiry, missing profiles and access denied', () => {
    const e = (stderr) => classifyAwsError(Object.assign(new Error('x'), { code: 255 }), stderr, 'aws', 'p');
    assert.strictEqual(e('Error when retrieving token from sso: Token has expired and refresh failed').kind, 'auth-expired');
    assert.match(e('The SSO session associated with this profile has expired').message, /aws sso login --profile p/);
    assert.strictEqual(e('The config profile (p) could not be found').kind, 'no-credentials');
    assert.strictEqual(e('An error occurred (AccessDeniedException) when calling ListApps').kind, 'access-denied');
    assert.strictEqual(classifyAwsError(Object.assign(new Error('x'), { code: 'ENOENT' }), '', 'aws').kind, 'not-installed');
});

test('createLimiter never exceeds its concurrency', async () => {
    const limit = createLimiter(3);
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 30 }, (_, i) => limit(async () => {
        active++; peak = Math.max(peak, active);
        await new Promise(r => setTimeout(r, 2 + (i % 4)));
        active--;
    })));
    assert.strictEqual(peak, 3);
});

test('MCP server answers initialize, tools/list and tools/call from the snapshot', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amplify-fleet-'));
    const accounts = fleet(); setLatest(accounts, 'dev', job('3', 'FAILED'));
    const snapshot = {
        schemaVersion: 1, generator: 'test', generatedAt: new Date().toISOString(), pollIntervalSeconds: 60, polling: true,
        summary: summarize(accounts), attention: collectAttention(accounts), workspace: [], accounts, recentEvents: [],
    };
    writeSnapshot(dir, snapshot);
    assert.match(renderMarkdown(snapshot), /Client A/);

    const child = spawn(process.execPath, [path.join(out, 'mcpServer.js')], { env: { ...process.env, AMPLIFY_MONITOR_FLEET_DIR: dir } });
    const responses = new Map();
    let buffer = '';
    child.stdout.on('data', chunk => {
        buffer += chunk;
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
            const msg = JSON.parse(buffer.slice(0, i));
            buffer = buffer.slice(i + 1);
            responses.set(msg.id, msg);
        }
    });
    const send = m => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/list' });
    send({ id: 3, method: 'tools/call', params: { name: 'amplify_fleet_attention', arguments: {} } });
    send({ id: 4, method: 'tools/call', params: { name: 'amplify_wait_for_build', arguments: { app: 'web', branch: 'dev', timeoutSeconds: 10 } } });
    const deadline = Date.now() + 5000;
    while (responses.size < 4 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 50));
    }
    child.kill();
    assert.strictEqual(responses.get(1).result.serverInfo.name, 'amplify-fleet');
    assert.ok(responses.get(2).result.tools.some(t => t.name === 'amplify_wait_for_build'));
    assert.match(responses.get(3).result.content[0].text, /web \/ dev: job #3 FAILED/);
    assert.match(responses.get(4).result.content[0].text, /job #3 .*FAILED/);
    fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Build logs
// ---------------------------------------------------------------------------
const { extractErrorLines, resolveLogTarget, formatJobLogs, jobLogDir, pruneLogs, stripAnsi } = require(path.join(out, 'buildLogs'));

function cacheJob(dir, target, buildText) {
    const jobDir = jobLogDir(dir, target);
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(path.join(jobDir, 'BUILD.txt'), buildText);
    const logs = {
        ...target, status: 'FAILED', fetchedAt: new Date().toISOString(), complete: true, dir: jobDir, consoleUrl: 'c',
        steps: [{ stepName: 'BUILD', status: 'FAILED', file: path.join(jobDir, 'BUILD.txt'), bytes: buildText.length, lines: buildText.split('\n').length }],
        errorLines: extractErrorLines(buildText).map(l => `[BUILD] ${l}`),
    };
    fs.writeFileSync(path.join(jobDir, 'job.json'), JSON.stringify(logs));
    return logs;
}

test('extractErrorLines finds real errors and skips "0 errors"', () => {
    const text = [
        '2026-01-01T00:00:00Z [INFO]: Compiled with 0 errors',
        '2026-01-01T00:00:01Z [ERROR]: !!! Build failed',
        'src/a.ts(1,2): error TS2304: Cannot find name x',
        'npm ERR! code ELIFECYCLE',
        '2026-01-01T00:00:02Z [ERROR]: !!! Build failed',
    ].join('\n');
    const lines = extractErrorLines(text);
    assert.strictEqual(lines.length, 3, lines.join('\n'));
    assert.strictEqual(stripAnsi('\u001b[31mred\u001b[0m'), 'red');
});

test('resolveLogTarget picks the latest job, a given job, and reports ambiguity', () => {
    const snapshot = { accounts: fleet() };
    assert.strictEqual(resolveLogTarget(snapshot, { app: 'web', branch: 'dev' }).target.jobId, '2');
    assert.strictEqual(resolveLogTarget(snapshot, { app: 'web', branch: 'main' }).target.profile, 'client-a');
    assert.ok(resolveLogTarget(snapshot, { app: 'web', branch: 'ma' }).target, 'substring match');
    const two = clone(snapshot); two.accounts.push({ ...clone(two.accounts[0]), profile: 'client-b', label: 'Client B' });
    assert.match(resolveLogTarget(two, { app: 'web', branch: 'dev' }).error, /Ambiguous/);
    assert.strictEqual(resolveLogTarget(two, { account: 'client-b', app: 'web', branch: 'dev' }).target.profile, 'client-b');
});

test('formatJobLogs shows error lines, tail and grep', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amplify-logs-'));
    const text = Array.from({ length: 300 }, (_, i) => `line ${i}`).concat(['[ERROR]: !!! Build failed']).join('\n');
    const logs = cacheJob(dir, { profile: 'p', region: 'us-east-1', appId: 'd1', branch: 'feat/x', jobId: '7' }, text);
    const out1 = formatJobLogs(logs, { tail: 20 });
    assert.match(out1, /## Error lines/);
    assert.match(out1, /last 20 of 301 lines/);
    assert.doesNotMatch(out1, /line 100\n/);
    assert.match(formatJobLogs(logs, { grep: 'line 1(0|5)0$' }), /matching .*\(2\)/);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('pruneLogs removes old jobs but not a download in progress', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amplify-prune-'));
    const old = cacheJob(dir, { profile: 'p', region: 'us-east-1', appId: 'd1', branch: 'main', jobId: '1' }, 'x');
    const past = new Date(Date.now() - 30 * 86400000);
    fs.utimesSync(path.join(old.dir, 'job.json'), past, past);
    const fresh = cacheJob(dir, { profile: 'p', region: 'us-east-1', appId: 'd1', branch: 'main', jobId: '2' }, 'x');
    const inProgress = jobLogDir(dir, { profile: 'p', appId: 'd1', branch: 'main', jobId: '3' });
    fs.mkdirSync(inProgress, { recursive: true });
    assert.strictEqual(pruneLogs(dir, 14), 1);
    assert.ok(!fs.existsSync(old.dir));
    assert.ok(fs.existsSync(fresh.dir));
    assert.ok(fs.existsSync(inProgress));
    fs.rmSync(dir, { recursive: true, force: true });
});

test('MCP amplify_get_build_logs serves cached logs without AWS', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amplify-fleet-'));
    const accounts = fleet(); setLatest(accounts, 'dev', job('3', 'FAILED'));
    writeSnapshot(dir, {
        schemaVersion: 1, generator: 'test', generatedAt: new Date().toISOString(), pollIntervalSeconds: 60, polling: true,
        summary: summarize(accounts), attention: [], workspace: [], accounts, recentEvents: [],
    });
    cacheJob(dir, { profile: 'client-a', region: 'us-east-1', appId: 'd1', appName: 'web', branch: 'dev', jobId: '3' }, 'npm ERR! missing script: build');
    const { callTool } = require(path.join(out, 'mcpServer'));
    const text = await callTool('amplify_get_build_logs', { app: 'web', branch: 'dev' }, dir);
    assert.match(text, /job #3 FAILED/);
    assert.match(text, /npm ERR! missing script: build/);
    fs.rmSync(dir, { recursive: true, force: true });
});
