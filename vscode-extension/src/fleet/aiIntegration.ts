import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FleetMonitor } from './fleetMonitor';
import { callTool, tools as mcpTools } from './mcpServer';
import { SNAPSHOT_JSON, SNAPSHOT_MD, defaultFleetDir } from './snapshotStore';
import { formatJobLogs, resolveLogTarget } from './buildLogs';

const MCP_NAME = 'amplify-fleet';
const SERVER_FILES = ['mcpServer.js', 'types.js', 'snapshotStore.js', 'buildLogs.js'];
const BLOCK_START = '<!-- amplify-monitor:start -->';
const BLOCK_END = '<!-- amplify-monitor:end -->';

/** MCP tools that are also exposed to Copilot agent mode as VS Code language model tools. */
const LM_TOOLS = ['amplify_fleet_status', 'amplify_fleet_attention', 'amplify_branch_history', 'amplify_workspace_deployments', 'amplify_get_build_logs'];

/**
 * Copy the zero-dependency MCP server next to the snapshot so external agents can
 * reference a stable path that survives extension updates.
 */
export function installMcpServer(context: vscode.ExtensionContext, fleetDir: string): string {
    const sourceDir = path.join(context.extensionPath, 'out', 'fleet');
    const targetDir = path.join(fleetDir, 'server');
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    for (const file of SERVER_FILES) {
        const source = path.join(sourceDir, file);
        const target = path.join(targetDir, file);
        const content = fs.readFileSync(source);
        if (!fs.existsSync(target) || !fs.readFileSync(target).equals(content)) {
            fs.writeFileSync(target, content);
        }
    }
    return path.join(targetDir, 'mcpServer.js');
}

/** Register the fleet tools for Copilot agent mode (VS Code 1.95+). */
export function registerLanguageModelTools(monitor: FleetMonitor): vscode.Disposable[] {
    const lm = vscode.lm as typeof vscode.lm | undefined;
    if (!lm || typeof lm.registerTool !== 'function') {
        return [];
    }
    const disposables: vscode.Disposable[] = [];
    for (const name of LM_TOOLS) {
        try {
            disposables.push(lm.registerTool<Record<string, unknown>>(name, {
                async invoke(options) {
                    const input = options.input ?? {};
                    if (name === 'amplify_get_build_logs') {
                        // Inside VS Code we can fetch directly instead of going through a request file.
                        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(await buildLogsForTool(monitor, input))]);
                    }
                    const text = await callTool(name, input, monitor.getFleetDir());
                    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
                },
                prepareInvocation() {
                    return {
                        invocationMessage: name === 'amplify_get_build_logs'
                            ? 'Reading Amplify build logs'
                            : 'Reading Amplify fleet status (cached, no AWS calls)',
                    };
                },
            }));
        } catch (error) {
            console.warn(`Amplify Monitor: could not register tool ${name}:`, error);
        }
    }
    return disposables;
}

async function buildLogsForTool(monitor: FleetMonitor, input: Record<string, unknown>): Promise<string> {
    const snapshot = monitor.getSnapshot();
    if (!snapshot) {
        return 'Fleet monitoring has no data yet. Configure accounts with "Amplify Monitor: Configure Fleet Accounts".';
    }
    const str = (k: string) => (input[k] !== undefined ? String(input[k]) : undefined);
    const resolved = resolveLogTarget(snapshot, { account: str('account'), app: str('app'), branch: str('branch'), jobId: str('jobId') });
    if (!resolved.target) {
        return resolved.error ?? 'Not found.';
    }
    try {
        const logs = await monitor.getJobLogs(resolved.target, input.refresh === true);
        return formatJobLogs(logs, {
            step: str('step'),
            tail: typeof input.tail === 'number' ? input.tail : undefined,
            grep: str('grep'),
        });
    } catch (error) {
        return `Fetching logs failed: ${error instanceof Error ? error.message : error}`;
    }
}

function findNode(): string {
    const exe = process.platform === 'win32' ? 'node.exe' : 'node';
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
        if (!dir) { continue; }
        const candidate = path.join(dir, exe);
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            return candidate;
        } catch {
            // keep looking
        }
    }
    return 'node';
}

function tildify(p: string): string {
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function mergeJsonMcpConfig(file: string, server: { command: string; args: string[]; env?: Record<string, string> }): void {
    let config: { mcpServers?: Record<string, unknown> } = {};
    if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf-8');
        if (raw.trim()) {
            config = JSON.parse(raw); // throw on invalid JSON rather than overwrite the user's file
            fs.writeFileSync(`${file}.bak`, raw);
        }
    }
    config.mcpServers = { ...(config.mcpServers ?? {}), [MCP_NAME]: server };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

function tomlString(value: string): string {
    return JSON.stringify(value); // JSON string escaping is valid TOML basic-string escaping
}

function addCodexServer(server: { command: string; args: string[]; env?: Record<string, string> }): 'added' | 'exists' {
    const file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
    if (existing.includes(`[mcp_servers.${MCP_NAME}]`)) {
        return 'exists';
    }
    let block = `\n[mcp_servers.${MCP_NAME}]\ncommand = ${tomlString(server.command)}\nargs = [${server.args.map(tomlString).join(', ')}]\n`;
    if (server.env && Object.keys(server.env).length) {
        block += `env = { ${Object.entries(server.env).map(([k, v]) => `${k} = ${tomlString(v)}`).join(', ')} }\n`;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (existing) {
        fs.writeFileSync(`${file}.bak`, existing);
    }
    fs.writeFileSync(file, existing + block);
    return 'added';
}

function instructionsBlock(monitor: FleetMonitor): string {
    const dir = tildify(monitor.getFleetDir());
    return [
        BLOCK_START,
        '## AWS Amplify build status (Amplify Monitor)',
        '',
        'The Amplify Monitor VS Code extension continuously tracks every Amplify app and branch across the AWS accounts used for this work, and keeps a live snapshot.',
        '',
        `- For build/deploy status, failures, or "did my push deploy?", use the \`${MCP_NAME}\` MCP tools: \`amplify_fleet_attention\`, \`amplify_fleet_status\`, \`amplify_branch_history\`, \`amplify_workspace_deployments\`, \`amplify_wait_for_build\`.`,
        '- To see why a build failed, call `amplify_get_build_logs` (error lines plus the end of the BUILD/DEPLOY logs). Failed-build logs are usually already cached.',
        `- If those tools are unavailable, read \`${dir}/${SNAPSHOT_MD}\` (Markdown) or \`${dir}/${SNAPSHOT_JSON}\` (JSON).`,
        '- Do not run `aws amplify ...` or `aws sts ...` commands just to check status. The snapshot already covers every account and is refreshed about every minute.',
        '- After pushing a commit, call `amplify_wait_for_build` for that branch to confirm the deploy before reporting the task done.',
        BLOCK_END,
    ].join('\n');
}

function upsertBlock(file: string, block: string, createIfMissing: boolean): 'created' | 'updated' | 'skipped' {
    if (!fs.existsSync(file)) {
        if (!createIfMissing) {
            return 'skipped';
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${block}\n`);
        return 'created';
    }
    const content = fs.readFileSync(file, 'utf-8');
    const start = content.indexOf(BLOCK_START);
    const end = content.indexOf(BLOCK_END);
    const next = start >= 0 && end > start
        ? content.slice(0, start) + block + content.slice(end + BLOCK_END.length)
        : `${content.replace(/\s*$/, '')}\n\n${block}\n`;
    if (next === content) {
        return 'skipped';
    }
    fs.writeFileSync(file, next);
    return 'updated';
}

/** Command: wire the fleet snapshot / MCP server into the developer's AI coding agents. */
export async function connectAiAgents(context: vscode.ExtensionContext, monitor: FleetMonitor): Promise<void> {
    let serverPath: string;
    try {
        serverPath = installMcpServer(context, monitor.getFleetDir());
    } catch (error) {
        void vscode.window.showErrorMessage(`Could not install the Amplify fleet MCP server: ${error}`);
        return;
    }
    const node = findNode();
    const env = monitor.getFleetDir() !== defaultFleetDir() ? { AMPLIFY_MONITOR_FLEET_DIR: monitor.getFleetDir() } : undefined;
    const server = { command: node, args: [serverPath], ...(env ? { env } : {}) };

    const picks = await vscode.window.showQuickPick([
        { id: 'claude', label: '$(terminal) Claude Code', description: 'claude mcp add (user scope)', picked: true },
        { id: 'codex', label: '$(terminal) OpenAI Codex', description: '~/.codex/config.toml', picked: true },
        { id: 'antigravity', label: '$(rocket) Google Antigravity', description: '~/.gemini/antigravity/mcp_config.json' },
        { id: 'cursor', label: '$(edit) Cursor', description: '~/.cursor/mcp.json' },
        { id: 'copilot', label: '$(copilot) GitHub Copilot', description: 'built in: #amplifyFleet tools and @amplify /fleet', picked: true },
        { id: 'instructions', label: '$(book) Workspace agent instructions', description: 'AGENTS.md (+ CLAUDE.md / copilot-instructions.md if present)' },
        { id: 'copy', label: '$(copy) Copy MCP config JSON', description: 'for any other MCP client' },
    ], {
        canPickMany: true,
        title: 'Connect AI agents to the Amplify fleet snapshot',
        placeHolder: 'Agents will read build status from the extension instead of calling the AWS CLI',
    });
    if (!picks || picks.length === 0) {
        return;
    }

    const results: string[] = [];
    for (const pick of picks) {
        try {
            switch (pick.id) {
                case 'claude': {
                    const envArgs = env ? Object.entries(env).map(([k, v]) => `-e ${k}=${JSON.stringify(v)} `).join('') : '';
                    const terminal = vscode.window.createTerminal({ name: 'Amplify Monitor: Claude Code MCP' });
                    terminal.show();
                    terminal.sendText(`claude mcp add --scope user ${envArgs}${MCP_NAME} -- ${JSON.stringify(node)} ${JSON.stringify(serverPath)}`);
                    results.push('Claude Code: ran `claude mcp add` in a terminal');
                    break;
                }
                case 'codex':
                    results.push(addCodexServer(server) === 'added' ? 'Codex: added to config.toml' : 'Codex: already configured');
                    break;
                case 'antigravity':
                    mergeJsonMcpConfig(path.join(os.homedir(), '.gemini', 'antigravity', 'mcp_config.json'), server);
                    results.push('Antigravity: added to mcp_config.json (reload Antigravity\'s MCP servers)');
                    break;
                case 'cursor':
                    mergeJsonMcpConfig(path.join(os.homedir(), '.cursor', 'mcp.json'), server);
                    results.push('Cursor: added to ~/.cursor/mcp.json');
                    break;
                case 'copilot':
                    results.push('Copilot: ready (reference #amplifyFleet in agent mode, or ask @amplify /fleet)');
                    break;
                case 'instructions': {
                    const block = instructionsBlock(monitor);
                    const folders = vscode.workspace.workspaceFolders ?? [];
                    if (folders.length === 0) {
                        results.push('Instructions: no workspace folder open');
                        break;
                    }
                    const claudePicked = picks.some(p => p.id === 'claude');
                    for (const folder of folders) {
                        const root = folder.uri.fsPath;
                        const changed = [
                            ['AGENTS.md', upsertBlock(path.join(root, 'AGENTS.md'), block, true)],
                            ['CLAUDE.md', upsertBlock(path.join(root, 'CLAUDE.md'), block, claudePicked)],
                            ['.github/copilot-instructions.md', upsertBlock(path.join(root, '.github', 'copilot-instructions.md'), block, false)],
                        ].filter(([, r]) => r !== 'skipped').map(([f, r]) => `${f} ${r}`);
                        results.push(`${folder.name}: ${changed.join(', ') || 'instructions already up to date'}`);
                    }
                    break;
                }
                case 'copy':
                    await vscode.env.clipboard.writeText(JSON.stringify({ mcpServers: { [MCP_NAME]: server } }, null, 2));
                    results.push('MCP config copied to clipboard');
                    break;
            }
        } catch (error) {
            results.push(`${pick.label.replace(/\$\([^)]*\)\s*/, '')}: failed (${error instanceof Error ? error.message : error})`);
        }
    }

    const choice = await vscode.window.showInformationMessage(
        `Amplify fleet connected. ${results.join('. ')}.`,
        'Open Snapshot');
    if (choice === 'Open Snapshot') {
        await vscode.commands.executeCommand('amplify-monitor.fleet.openSnapshot');
    }
}

export { mcpTools };
