import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';

interface WebhookConfig {
    name: string;
    url: string;
    type: 'slack' | 'teams' | 'discord' | 'generic';
    enabled: boolean;
    events: WebhookEvent[];
}

type WebhookEvent = 'build_started' | 'build_succeeded' | 'build_failed' | 'build_cancelled';

interface BuildNotification {
    appId: string;
    appName: string;
    branch: string;
    jobId: string;
    status: 'PENDING' | 'RUNNING' | 'SUCCEED' | 'FAILED' | 'CANCELLED';
    commitId?: string;
    commitMessage?: string;
    duration?: number;
    region: string;
    timestamp: Date;
    issues?: { pattern: string; rootCause: string }[];
}

export class NotificationsService {
    private static _instance: NotificationsService;
    private _context: vscode.ExtensionContext;
    private _webhooks: WebhookConfig[] = [];

    public static getInstance(context?: vscode.ExtensionContext): NotificationsService {
        if (!NotificationsService._instance && context) {
            NotificationsService._instance = new NotificationsService(context);
        }
        return NotificationsService._instance;
    }

    private constructor(context: vscode.ExtensionContext) {
        this._context = context;
        this.loadWebhooks();
    }

    private loadWebhooks() {
        this._webhooks = this._context.globalState.get<WebhookConfig[]>('webhooks', []);
    }

    private saveWebhooks() {
        this._context.globalState.update('webhooks', this._webhooks);
    }

    public getWebhooks(): WebhookConfig[] {
        return [...this._webhooks];
    }

    public addWebhook(config: WebhookConfig) {
        this._webhooks.push(config);
        this.saveWebhooks();
    }

    public updateWebhook(index: number, config: WebhookConfig) {
        if (index >= 0 && index < this._webhooks.length) {
            this._webhooks[index] = config;
            this.saveWebhooks();
        }
    }

    public removeWebhook(index: number) {
        if (index >= 0 && index < this._webhooks.length) {
            this._webhooks.splice(index, 1);
            this.saveWebhooks();
        }
    }

    public async sendNotification(notification: BuildNotification): Promise<void> {
        const event = this.getEventType(notification.status);
        const enabledWebhooks = this._webhooks.filter(w => w.enabled && w.events.includes(event));

        for (const webhook of enabledWebhooks) {
            try {
                await this.sendToWebhook(webhook, notification);
            } catch (error) {
                console.error(`Failed to send notification to ${webhook.name}:`, error);
            }
        }
    }

    private getEventType(status: string): WebhookEvent {
        switch (status) {
            case 'PENDING':
            case 'RUNNING':
                return 'build_started';
            case 'SUCCEED':
                return 'build_succeeded';
            case 'FAILED':
                return 'build_failed';
            case 'CANCELLED':
                return 'build_cancelled';
            default:
                return 'build_started';
        }
    }

    private async sendToWebhook(webhook: WebhookConfig, notification: BuildNotification): Promise<void> {
        let payload: any;

        switch (webhook.type) {
            case 'slack':
                payload = this.formatSlackMessage(notification);
                break;
            case 'teams':
                payload = this.formatTeamsMessage(notification);
                break;
            case 'discord':
                payload = this.formatDiscordMessage(notification);
                break;
            default:
                payload = this.formatGenericMessage(notification);
        }

        await this.postToWebhook(webhook.url, payload);
    }

    private formatSlackMessage(notification: BuildNotification): any {
        const statusEmoji = this.getStatusEmoji(notification.status);
        const statusColor = this.getStatusColor(notification.status);
        const consoleUrl = `https://${notification.region}.console.aws.amazon.com/amplify/home?region=${notification.region}#/${notification.appId}/${notification.branch}/${notification.jobId}`;

        return {
            attachments: [{
                color: statusColor,
                blocks: [
                    {
                        type: 'header',
                        text: {
                            type: 'plain_text',
                            text: `${statusEmoji} Amplify Build ${notification.status}`,
                            emoji: true
                        }
                    },
                    {
                        type: 'section',
                        fields: [
                            {
                                type: 'mrkdwn',
                                text: `*App:*\n${notification.appName}`
                            },
                            {
                                type: 'mrkdwn',
                                text: `*Branch:*\n${notification.branch}`
                            },
                            {
                                type: 'mrkdwn',
                                text: `*Job ID:*\n${notification.jobId}`
                            },
                            {
                                type: 'mrkdwn',
                                text: `*Region:*\n${notification.region}`
                            }
                        ]
                    },
                    ...(notification.commitMessage ? [{
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text: `*Commit:*\n\`${notification.commitId?.substring(0, 7) || 'N/A'}\` - ${notification.commitMessage}`
                        }
                    }] : []),
                    ...(notification.duration ? [{
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text: `*Duration:* ${this.formatDuration(notification.duration)}`
                        }
                    }] : []),
                    ...(notification.issues && notification.issues.length > 0 ? [{
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text: `*Issues Detected:*\n${notification.issues.map(i => `• ${i.pattern}: ${i.rootCause}`).join('\n')}`
                        }
                    }] : []),
                    {
                        type: 'actions',
                        elements: [{
                            type: 'button',
                            text: {
                                type: 'plain_text',
                                text: '🔗 View in AWS Console',
                                emoji: true
                            },
                            url: consoleUrl
                        }]
                    },
                    {
                        type: 'context',
                        elements: [{
                            type: 'mrkdwn',
                            text: `Sent by Amplify Monitor • ${notification.timestamp.toLocaleString()}`
                        }]
                    }
                ]
            }]
        };
    }

    private formatTeamsMessage(notification: BuildNotification): any {
        const statusEmoji = this.getStatusEmoji(notification.status);
        const statusColor = this.getStatusColor(notification.status);
        const consoleUrl = `https://${notification.region}.console.aws.amazon.com/amplify/home?region=${notification.region}#/${notification.appId}/${notification.branch}/${notification.jobId}`;

        return {
            '@type': 'MessageCard',
            '@context': 'http://schema.org/extensions',
            themeColor: statusColor.replace('#', ''),
            summary: `Amplify Build ${notification.status}`,
            sections: [{
                activityTitle: `${statusEmoji} Amplify Build ${notification.status}`,
                activitySubtitle: notification.appName,
                facts: [
                    { name: 'Branch', value: notification.branch },
                    { name: 'Job ID', value: notification.jobId },
                    { name: 'Region', value: notification.region },
                    ...(notification.commitMessage ? [{ name: 'Commit', value: `${notification.commitId?.substring(0, 7)} - ${notification.commitMessage}` }] : []),
                    ...(notification.duration ? [{ name: 'Duration', value: this.formatDuration(notification.duration) }] : [])
                ],
                ...(notification.issues && notification.issues.length > 0 ? {
                    text: `**Issues Detected:**\n${notification.issues.map(i => `- ${i.pattern}: ${i.rootCause}`).join('\n')}`
                } : {})
            }],
            potentialAction: [{
                '@type': 'OpenUri',
                name: 'View in AWS Console',
                targets: [{ os: 'default', uri: consoleUrl }]
            }]
        };
    }

    private formatDiscordMessage(notification: BuildNotification): any {
        const statusEmoji = this.getStatusEmoji(notification.status);
        const statusColor = parseInt(this.getStatusColor(notification.status).replace('#', ''), 16);
        const consoleUrl = `https://${notification.region}.console.aws.amazon.com/amplify/home?region=${notification.region}#/${notification.appId}/${notification.branch}/${notification.jobId}`;

        return {
            embeds: [{
                title: `${statusEmoji} Amplify Build ${notification.status}`,
                color: statusColor,
                fields: [
                    { name: 'App', value: notification.appName, inline: true },
                    { name: 'Branch', value: notification.branch, inline: true },
                    { name: 'Job ID', value: notification.jobId, inline: true },
                    { name: 'Region', value: notification.region, inline: true },
                    ...(notification.commitMessage ? [{ name: 'Commit', value: `\`${notification.commitId?.substring(0, 7)}\` - ${notification.commitMessage}`, inline: false }] : []),
                    ...(notification.duration ? [{ name: 'Duration', value: this.formatDuration(notification.duration), inline: true }] : []),
                    ...(notification.issues && notification.issues.length > 0 ? [{ name: 'Issues', value: notification.issues.map(i => `• ${i.pattern}`).join('\n'), inline: false }] : [])
                ],
                url: consoleUrl,
                timestamp: notification.timestamp.toISOString(),
                footer: { text: 'Amplify Monitor' }
            }]
        };
    }

    private formatGenericMessage(notification: BuildNotification): any {
        return {
            event: this.getEventType(notification.status),
            app: {
                id: notification.appId,
                name: notification.appName
            },
            branch: notification.branch,
            job: {
                id: notification.jobId,
                status: notification.status,
                duration: notification.duration
            },
            commit: notification.commitId ? {
                id: notification.commitId,
                message: notification.commitMessage
            } : null,
            region: notification.region,
            timestamp: notification.timestamp.toISOString(),
            issues: notification.issues || []
        };
    }

    private getStatusEmoji(status: string): string {
        switch (status) {
            case 'SUCCEED': return '✅';
            case 'FAILED': return '❌';
            case 'RUNNING': return '🔄';
            case 'PENDING': return '⏳';
            case 'CANCELLED': return '🚫';
            default: return '📋';
        }
    }

    private getStatusColor(status: string): string {
        switch (status) {
            case 'SUCCEED': return '#00c853';
            case 'FAILED': return '#f44336';
            case 'RUNNING': return '#2196f3';
            case 'PENDING': return '#ff9800';
            case 'CANCELLED': return '#9e9e9e';
            default: return '#607d8b';
        }
    }

    private formatDuration(seconds: number): string {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        if (mins > 0) {
            return `${mins}m ${secs}s`;
        }
        return `${secs}s`;
    }

    private postToWebhook(url: string, payload: any): Promise<void> {
        return new Promise((resolve, reject) => {
            const data = JSON.stringify(payload);
            const parsedUrl = new URL(url);
            const isHttps = parsedUrl.protocol === 'https:';
            
            const options = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || (isHttps ? 443 : 80),
                path: parsedUrl.pathname + parsedUrl.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data)
                }
            };

            const req = (isHttps ? https : http).request(options, (res) => {
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    resolve();
                } else {
                    reject(new Error(`HTTP ${res.statusCode}`));
                }
            });

            req.on('error', reject);
            req.write(data);
            req.end();
        });
    }

    public async testWebhook(config: WebhookConfig): Promise<boolean> {
        const testNotification: BuildNotification = {
            appId: 'test-app-id',
            appName: 'Test App',
            branch: 'main',
            jobId: '123',
            status: 'SUCCEED',
            commitId: 'abc1234',
            commitMessage: 'Test notification from Amplify Monitor',
            duration: 120,
            region: 'us-east-1',
            timestamp: new Date()
        };

        try {
            await this.sendToWebhook(config, testNotification);
            return true;
        } catch (error) {
            console.error('Webhook test failed:', error);
            return false;
        }
    }
}

export class NotificationsPanel {
    public static currentPanel: NotificationsPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _service: NotificationsService;

    public static createOrShow(context: vscode.ExtensionContext) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (NotificationsPanel.currentPanel) {
            NotificationsPanel.currentPanel._panel.reveal(column);
            NotificationsPanel.currentPanel.refresh();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'notificationsPanel',
            '🔔 Build Notifications',
            column || vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        NotificationsPanel.currentPanel = new NotificationsPanel(panel, context);
    }

    private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
        this._panel = panel;
        this._service = NotificationsService.getInstance(context);

        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'addWebhook':
                        this._service.addWebhook(message.config);
                        this.refresh();
                        vscode.window.showInformationMessage(`Added webhook: ${message.config.name}`);
                        break;
                    case 'updateWebhook':
                        this._service.updateWebhook(message.index, message.config);
                        this.refresh();
                        break;
                    case 'removeWebhook':
                        this._service.removeWebhook(message.index);
                        this.refresh();
                        vscode.window.showInformationMessage('Webhook removed');
                        break;
                    case 'testWebhook':
                        const success = await this._service.testWebhook(message.config);
                        if (success) {
                            vscode.window.showInformationMessage('Test notification sent successfully!');
                        } else {
                            vscode.window.showErrorMessage('Failed to send test notification. Check webhook URL.');
                        }
                        break;
                    case 'refresh':
                        this.refresh();
                        break;
                }
            },
            null,
            this._disposables
        );

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this.refresh();
    }

    public refresh() {
        this._panel.webview.html = this._getHtml();
    }

    private _getHtml(): string {
        const webhooks = this._service.getWebhooks();

        return `<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); max-width: 900px; margin: 0 auto; }
        h1 { display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--vscode-input-border); padding-bottom: 15px; }
        h2 { font-size: 16px; margin-top: 25px; }
        
        .info-box { background: rgba(33,150,243,0.1); border: 1px solid rgba(33,150,243,0.3); border-radius: 8px; padding: 15px; margin: 15px 0; }
        .info-box h3 { margin: 0 0 10px 0; font-size: 14px; color: #2196f3; }
        .info-box p { margin: 5px 0; font-size: 13px; opacity: 0.9; }
        .info-box code { background: rgba(0,0,0,0.2); padding: 2px 6px; border-radius: 3px; font-size: 12px; }
        
        .webhook-list { margin: 20px 0; }
        .webhook-card { background: var(--vscode-input-background); border-radius: 8px; padding: 15px; margin: 10px 0; border-left: 4px solid var(--vscode-button-background); }
        .webhook-card.disabled { opacity: 0.6; border-left-color: var(--vscode-input-border); }
        .webhook-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .webhook-name { font-weight: 600; display: flex; align-items: center; gap: 8px; }
        .webhook-type { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
        .webhook-url { font-family: monospace; font-size: 11px; opacity: 0.7; word-break: break-all; margin: 8px 0; }
        .webhook-events { display: flex; gap: 6px; flex-wrap: wrap; margin: 10px 0; }
        .event-badge { font-size: 10px; padding: 3px 8px; border-radius: 4px; background: rgba(0,0,0,0.2); }
        .event-badge.active { background: rgba(0,200,83,0.2); color: #00c853; }
        .webhook-actions { display: flex; gap: 8px; margin-top: 10px; }
        
        button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 13px; display: flex; align-items: center; gap: 6px; }
        button:hover { background: var(--vscode-button-hoverBackground); }
        button.secondary { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); }
        button.danger { background: #f44336; }
        button.small { padding: 5px 10px; font-size: 11px; }
        
        .form-section { background: var(--vscode-input-background); border-radius: 8px; padding: 20px; margin: 20px 0; }
        .form-group { margin: 15px 0; }
        .form-group label { display: block; margin-bottom: 5px; font-weight: 500; font-size: 13px; }
        .form-group input, .form-group select { width: 100%; background: var(--vscode-editor-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 10px; border-radius: 4px; font-size: 13px; box-sizing: border-box; }
        .form-group input:focus, .form-group select:focus { outline: none; border-color: var(--vscode-focusBorder); }
        
        .checkbox-group { display: flex; flex-wrap: wrap; gap: 15px; margin-top: 10px; }
        .checkbox-item { display: flex; align-items: center; gap: 6px; }
        .checkbox-item input { width: auto; }
        
        .empty { text-align: center; padding: 40px; opacity: 0.6; }
        .empty-icon { font-size: 48px; margin-bottom: 15px; }
        
        .toggle { position: relative; width: 44px; height: 24px; }
        .toggle input { opacity: 0; width: 0; height: 0; }
        .toggle-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: var(--vscode-input-border); transition: 0.3s; border-radius: 24px; }
        .toggle-slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px; background-color: white; transition: 0.3s; border-radius: 50%; }
        .toggle input:checked + .toggle-slider { background-color: #00c853; }
        .toggle input:checked + .toggle-slider:before { transform: translateX(20px); }
    </style>
</head>
<body>
    <h1>🔔 Build Notifications</h1>
    
    <div class="info-box">
        <h3>💡 How it works</h3>
        <p>Configure webhooks to receive build notifications in Slack, Teams, Discord, or any webhook endpoint.</p>
        <p>Supported platforms: <code>Slack</code> <code>Microsoft Teams</code> <code>Discord</code> <code>Generic JSON</code></p>
    </div>
    
    <h2>Configured Webhooks</h2>
    
    <div class="webhook-list">
        ${webhooks.length > 0 ? webhooks.map((webhook, index) => `
            <div class="webhook-card ${webhook.enabled ? '' : 'disabled'}">
                <div class="webhook-header">
                    <div class="webhook-name">
                        ${this.getTypeIcon(webhook.type)} ${this.escapeHtml(webhook.name)}
                        <span class="webhook-type">${webhook.type}</span>
                    </div>
                    <label class="toggle">
                        <input type="checkbox" ${webhook.enabled ? 'checked' : ''} onchange="toggleWebhook(${index}, this.checked)">
                        <span class="toggle-slider"></span>
                    </label>
                </div>
                <div class="webhook-url">${this.escapeHtml(webhook.url.substring(0, 60))}${webhook.url.length > 60 ? '...' : ''}</div>
                <div class="webhook-events">
                    <span class="event-badge ${webhook.events.includes('build_started') ? 'active' : ''}">🚀 Started</span>
                    <span class="event-badge ${webhook.events.includes('build_succeeded') ? 'active' : ''}">✅ Succeeded</span>
                    <span class="event-badge ${webhook.events.includes('build_failed') ? 'active' : ''}">❌ Failed</span>
                    <span class="event-badge ${webhook.events.includes('build_cancelled') ? 'active' : ''}">🚫 Cancelled</span>
                </div>
                <div class="webhook-actions">
                    <button class="small secondary" onclick="testWebhook(${index})">🧪 Test</button>
                    <button class="small secondary" onclick="editWebhook(${index})">✏️ Edit</button>
                    <button class="small danger" onclick="removeWebhook(${index})">🗑️ Delete</button>
                </div>
            </div>
        `).join('') : `
            <div class="empty">
                <div class="empty-icon">🔕</div>
                <p>No webhooks configured</p>
                <p style="font-size: 12px;">Add a webhook below to start receiving build notifications</p>
            </div>
        `}
    </div>
    
    <h2>Add New Webhook</h2>
    
    <div class="form-section">
        <div class="form-group">
            <label>Webhook Name</label>
            <input type="text" id="webhookName" placeholder="e.g., Team Slack Channel">
        </div>
        
        <div class="form-group">
            <label>Platform</label>
            <select id="webhookType">
                <option value="slack">Slack</option>
                <option value="teams">Microsoft Teams</option>
                <option value="discord">Discord</option>
                <option value="generic">Generic JSON Webhook</option>
            </select>
        </div>
        
        <div class="form-group">
            <label>Webhook URL</label>
            <input type="text" id="webhookUrl" placeholder="https://hooks.slack.com/services/...">
        </div>
        
        <div class="form-group">
            <label>Events to notify</label>
            <div class="checkbox-group">
                <label class="checkbox-item">
                    <input type="checkbox" id="evt_started" checked>
                    🚀 Build Started
                </label>
                <label class="checkbox-item">
                    <input type="checkbox" id="evt_succeeded" checked>
                    ✅ Build Succeeded
                </label>
                <label class="checkbox-item">
                    <input type="checkbox" id="evt_failed" checked>
                    ❌ Build Failed
                </label>
                <label class="checkbox-item">
                    <input type="checkbox" id="evt_cancelled">
                    🚫 Build Cancelled
                </label>
            </div>
        </div>
        
        <button onclick="addWebhook()">➕ Add Webhook</button>
    </div>
    
    <div class="info-box">
        <h3>📖 Getting Webhook URLs</h3>
        <p><strong>Slack:</strong> Go to your Slack workspace → Apps → Incoming Webhooks → Add New Webhook</p>
        <p><strong>Teams:</strong> Channel → ... → Connectors → Incoming Webhook → Configure</p>
        <p><strong>Discord:</strong> Server Settings → Integrations → Webhooks → New Webhook</p>
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        const webhooks = ${JSON.stringify(webhooks)};
        
        function addWebhook() {
            const name = document.getElementById('webhookName').value.trim();
            const type = document.getElementById('webhookType').value;
            const url = document.getElementById('webhookUrl').value.trim();
            
            if (!name || !url) {
                alert('Please fill in name and URL');
                return;
            }
            
            const events = [];
            if (document.getElementById('evt_started').checked) events.push('build_started');
            if (document.getElementById('evt_succeeded').checked) events.push('build_succeeded');
            if (document.getElementById('evt_failed').checked) events.push('build_failed');
            if (document.getElementById('evt_cancelled').checked) events.push('build_cancelled');
            
            if (events.length === 0) {
                alert('Please select at least one event');
                return;
            }
            
            vscode.postMessage({
                command: 'addWebhook',
                config: { name, type, url, enabled: true, events }
            });
            
            // Clear form
            document.getElementById('webhookName').value = '';
            document.getElementById('webhookUrl').value = '';
        }
        
        function toggleWebhook(index, enabled) {
            const webhook = webhooks[index];
            webhook.enabled = enabled;
            vscode.postMessage({
                command: 'updateWebhook',
                index,
                config: webhook
            });
        }
        
        function testWebhook(index) {
            vscode.postMessage({
                command: 'testWebhook',
                config: webhooks[index]
            });
        }
        
        function editWebhook(index) {
            const webhook = webhooks[index];
            document.getElementById('webhookName').value = webhook.name;
            document.getElementById('webhookType').value = webhook.type;
            document.getElementById('webhookUrl').value = webhook.url;
            document.getElementById('evt_started').checked = webhook.events.includes('build_started');
            document.getElementById('evt_succeeded').checked = webhook.events.includes('build_succeeded');
            document.getElementById('evt_failed').checked = webhook.events.includes('build_failed');
            document.getElementById('evt_cancelled').checked = webhook.events.includes('build_cancelled');
            
            // Remove old and re-add
            removeWebhook(index);
        }
        
        function removeWebhook(index) {
            if (confirm('Remove this webhook?')) {
                vscode.postMessage({ command: 'removeWebhook', index });
            }
        }
    </script>
</body>
</html>`;
    }

    private getTypeIcon(type: string): string {
        switch (type) {
            case 'slack': return '💬';
            case 'teams': return '👥';
            case 'discord': return '🎮';
            default: return '🔗';
        }
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    public dispose() {
        NotificationsPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) x.dispose();
        }
    }
}
