import * as vscode from 'vscode';
import { AmplifyJob } from './cli';

export interface WebhookConfig {
    enabled: boolean;
    url: string;
    type: 'slack' | 'teams' | 'discord' | 'custom';
    events: {
        buildStarted: boolean;
        buildSucceeded: boolean;
        buildFailed: boolean;
    };
    includeLogExcerpt: boolean;
    mentionOnFailure?: string; // @here, @channel, or specific user/group
}

interface SlackMessage {
    text?: string;
    blocks?: SlackBlock[];
    attachments?: SlackAttachment[];
}

interface SlackBlock {
    type: string;
    text?: { type: string; text: string; emoji?: boolean };
    fields?: { type: string; text: string }[];
    elements?: any[];
}

interface SlackAttachment {
    color: string;
    blocks?: SlackBlock[];
}

interface TeamsMessage {
    '@type': string;
    '@context': string;
    themeColor: string;
    summary: string;
    sections: TeamsSection[];
    potentialAction?: TeamsAction[];
}

interface TeamsSection {
    activityTitle?: string;
    activitySubtitle?: string;
    activityImage?: string;
    facts?: { name: string; value: string }[];
    markdown?: boolean;
    text?: string;
}

interface TeamsAction {
    '@type': string;
    name: string;
    targets: { os: string; uri: string }[];
}

export class WebhookNotificationService {
    private static instance: WebhookNotificationService;
    private outputChannel: vscode.OutputChannel;

    private constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Amplify Webhooks');
    }

    public static getInstance(): WebhookNotificationService {
        if (!WebhookNotificationService.instance) {
            WebhookNotificationService.instance = new WebhookNotificationService();
        }
        return WebhookNotificationService.instance;
    }

    public async sendBuildNotification(
        appName: string,
        appId: string,
        branch: string,
        job: AmplifyJob,
        logExcerpt?: string,
        issues?: Array<{ pattern: string; rootCause: string }>
    ): Promise<void> {
        const config = this.getConfig();
        
        if (!config.enabled || !config.url) {
            return;
        }

        // Check if we should send for this event
        if (job.status === 'RUNNING' && !config.events.buildStarted) return;
        if (job.status === 'SUCCEED' && !config.events.buildSucceeded) return;
        if (job.status === 'FAILED' && !config.events.buildFailed) return;

        try {
            const message = this.buildMessage(config, appName, appId, branch, job, logExcerpt, issues);
            await this.sendWebhook(config.url, message);
            
            this.outputChannel.appendLine(`[${new Date().toISOString()}] Sent ${job.status} notification for ${appName}/${branch} #${job.jobId}`);
        } catch (error) {
            this.outputChannel.appendLine(`[${new Date().toISOString()}] Failed to send webhook: ${error}`);
            vscode.window.showWarningMessage(`Failed to send webhook notification: ${error}`);
        }
    }

    private getConfig(): WebhookConfig {
        const config = vscode.workspace.getConfiguration('amplifyMonitor');
        return {
            enabled: config.get<boolean>('webhook.enabled', false),
            url: config.get<string>('webhook.url', ''),
            type: config.get<'slack' | 'teams' | 'discord' | 'custom'>('webhook.type', 'slack'),
            events: {
                buildStarted: config.get<boolean>('webhook.events.buildStarted', false),
                buildSucceeded: config.get<boolean>('webhook.events.buildSucceeded', true),
                buildFailed: config.get<boolean>('webhook.events.buildFailed', true),
            },
            includeLogExcerpt: config.get<boolean>('webhook.includeLogExcerpt', true),
            mentionOnFailure: config.get<string>('webhook.mentionOnFailure', ''),
        };
    }

    private buildMessage(
        config: WebhookConfig,
        appName: string,
        appId: string,
        branch: string,
        job: AmplifyJob,
        logExcerpt?: string,
        issues?: Array<{ pattern: string; rootCause: string }>
    ): object {
        switch (config.type) {
            case 'slack':
                return this.buildSlackMessage(config, appName, appId, branch, job, logExcerpt, issues);
            case 'teams':
                return this.buildTeamsMessage(config, appName, appId, branch, job, logExcerpt, issues);
            case 'discord':
                return this.buildDiscordMessage(config, appName, appId, branch, job, logExcerpt, issues);
            default:
                return this.buildGenericMessage(appName, appId, branch, job, logExcerpt, issues);
        }
    }

    private buildSlackMessage(
        config: WebhookConfig,
        appName: string,
        appId: string,
        branch: string,
        job: AmplifyJob,
        logExcerpt?: string,
        issues?: Array<{ pattern: string; rootCause: string }>
    ): SlackMessage {
        const statusEmoji = job.status === 'SUCCEED' ? '✅' : job.status === 'FAILED' ? '❌' : '🔄';
        const statusColor = job.status === 'SUCCEED' ? '#2ea043' : job.status === 'FAILED' ? '#cf222e' : '#0969da';
        
        const consoleUrl = `https://console.aws.amazon.com/amplify/home#/${appId}/${branch}/${job.jobId}`;

        const blocks: SlackBlock[] = [
            {
                type: 'header',
                text: {
                    type: 'plain_text',
                    text: `${statusEmoji} Amplify Build ${job.status}`,
                    emoji: true
                }
            },
            {
                type: 'section',
                fields: [
                    { type: 'mrkdwn', text: `*App:*\n${appName}` },
                    { type: 'mrkdwn', text: `*Branch:*\n${branch}` },
                    { type: 'mrkdwn', text: `*Job:*\n#${job.jobId}` },
                    { type: 'mrkdwn', text: `*Time:*\n${job.startTime ? new Date(job.startTime).toLocaleString() : 'N/A'}` }
                ]
            }
        ];

        // Add issues for failed builds
        if (job.status === 'FAILED' && issues && issues.length > 0) {
            const issueText = issues.map(i => `• *${i.pattern.replace(/_/g, ' ')}*: ${i.rootCause}`).join('\n');
            blocks.push({
                type: 'section',
                text: { type: 'mrkdwn', text: `*Issues Detected:*\n${issueText}` }
            });
        }

        // Add log excerpt
        if (config.includeLogExcerpt && logExcerpt && job.status === 'FAILED') {
            const truncatedLog = logExcerpt.substring(0, 500) + (logExcerpt.length > 500 ? '...' : '');
            blocks.push({
                type: 'section',
                text: { type: 'mrkdwn', text: `*Log Excerpt:*\n\`\`\`${truncatedLog}\`\`\`` }
            });
        }

        // Add action buttons
        blocks.push({
            type: 'actions',
            elements: [
                {
                    type: 'button',
                    text: { type: 'plain_text', text: '🔗 Open in Console', emoji: true },
                    url: consoleUrl
                }
            ]
        });

        const message: SlackMessage = {
            blocks,
            attachments: [{
                color: statusColor,
                blocks: []
            }]
        };

        // Add mention for failures
        if (job.status === 'FAILED' && config.mentionOnFailure) {
            message.text = config.mentionOnFailure;
        }

        return message;
    }

    private buildTeamsMessage(
        config: WebhookConfig,
        appName: string,
        appId: string,
        branch: string,
        job: AmplifyJob,
        logExcerpt?: string,
        issues?: Array<{ pattern: string; rootCause: string }>
    ): TeamsMessage {
        const statusEmoji = job.status === 'SUCCEED' ? '✅' : job.status === 'FAILED' ? '❌' : '🔄';
        const themeColor = job.status === 'SUCCEED' ? '2ea043' : job.status === 'FAILED' ? 'cf222e' : '0969da';
        
        const consoleUrl = `https://console.aws.amazon.com/amplify/home#/${appId}/${branch}/${job.jobId}`;

        const sections: TeamsSection[] = [
            {
                activityTitle: `${statusEmoji} Amplify Build ${job.status}`,
                activitySubtitle: `${appName} / ${branch}`,
                facts: [
                    { name: 'Job', value: `#${job.jobId}` },
                    { name: 'Status', value: job.status },
                    { name: 'Time', value: job.startTime ? new Date(job.startTime).toLocaleString() : 'N/A' }
                ],
                markdown: true
            }
        ];

        // Add issues for failed builds
        if (job.status === 'FAILED' && issues && issues.length > 0) {
            const issueText = issues.map(i => `- **${i.pattern.replace(/_/g, ' ')}**: ${i.rootCause}`).join('\n');
            sections.push({
                text: `**Issues Detected:**\n${issueText}`,
                markdown: true
            });
        }

        // Add log excerpt
        if (config.includeLogExcerpt && logExcerpt && job.status === 'FAILED') {
            const truncatedLog = logExcerpt.substring(0, 300) + (logExcerpt.length > 300 ? '...' : '');
            sections.push({
                text: `**Log Excerpt:**\n\`\`\`\n${truncatedLog}\n\`\`\``,
                markdown: true
            });
        }

        return {
            '@type': 'MessageCard',
            '@context': 'http://schema.org/extensions',
            themeColor,
            summary: `Amplify Build ${job.status}: ${appName}/${branch} #${job.jobId}`,
            sections,
            potentialAction: [
                {
                    '@type': 'OpenUri',
                    name: 'Open in Console',
                    targets: [{ os: 'default', uri: consoleUrl }]
                }
            ]
        };
    }

    private buildDiscordMessage(
        config: WebhookConfig,
        appName: string,
        appId: string,
        branch: string,
        job: AmplifyJob,
        logExcerpt?: string,
        issues?: Array<{ pattern: string; rootCause: string }>
    ): object {
        const statusEmoji = job.status === 'SUCCEED' ? '✅' : job.status === 'FAILED' ? '❌' : '🔄';
        const color = job.status === 'SUCCEED' ? 0x2ea043 : job.status === 'FAILED' ? 0xcf222e : 0x0969da;
        
        const consoleUrl = `https://console.aws.amazon.com/amplify/home#/${appId}/${branch}/${job.jobId}`;

        const fields = [
            { name: 'App', value: appName, inline: true },
            { name: 'Branch', value: branch, inline: true },
            { name: 'Job', value: `#${job.jobId}`, inline: true },
        ];

        // Add issues for failed builds
        if (job.status === 'FAILED' && issues && issues.length > 0) {
            const issueText = issues.map(i => `• **${i.pattern.replace(/_/g, ' ')}**: ${i.rootCause}`).join('\n');
            fields.push({ name: 'Issues', value: issueText.substring(0, 1024), inline: false });
        }

        let content = '';
        if (job.status === 'FAILED' && config.mentionOnFailure) {
            content = config.mentionOnFailure;
        }

        return {
            content,
            embeds: [{
                title: `${statusEmoji} Amplify Build ${job.status}`,
                color,
                fields,
                timestamp: job.startTime || new Date().toISOString(),
                url: consoleUrl
            }]
        };
    }

    private buildGenericMessage(
        appName: string,
        appId: string,
        branch: string,
        job: AmplifyJob,
        logExcerpt?: string,
        issues?: Array<{ pattern: string; rootCause: string }>
    ): object {
        return {
            event: `build_${job.status.toLowerCase()}`,
            app: {
                id: appId,
                name: appName,
                branch
            },
            job: {
                id: job.jobId,
                status: job.status,
                startTime: job.startTime,
                endTime: job.endTime
            },
            issues: issues || [],
            consoleUrl: `https://console.aws.amazon.com/amplify/home#/${appId}/${branch}/${job.jobId}`
        };
    }

    private async sendWebhook(url: string, payload: object): Promise<void> {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
    }

    public showOutput(): void {
        this.outputChannel.show();
    }

    public async testWebhook(): Promise<void> {
        const config = this.getConfig();
        
        if (!config.url) {
            vscode.window.showWarningMessage('Please configure a webhook URL first.');
            return;
        }

        const testJob: AmplifyJob = {
            jobId: 'test-123',
            branch: 'main',
            status: 'SUCCEED',
            startTime: new Date().toISOString()
        };

        try {
            await this.sendBuildNotification(
                'Test App',
                'test-app-id',
                'main',
                testJob
            );
            vscode.window.showInformationMessage('✅ Test webhook sent successfully!');
        } catch (error) {
            vscode.window.showErrorMessage(`❌ Webhook test failed: ${error}`);
        }
    }
}

export async function configureWebhook(): Promise<void> {
    const typeOptions = [
        { label: '$(comment-discussion) Slack', description: 'Slack Incoming Webhook', value: 'slack' },
        { label: '$(organization) Microsoft Teams', description: 'Teams Incoming Webhook', value: 'teams' },
        { label: '$(comment) Discord', description: 'Discord Webhook', value: 'discord' },
        { label: '$(code) Custom', description: 'Generic JSON webhook', value: 'custom' }
    ];

    const selected = await vscode.window.showQuickPick(typeOptions, {
        placeHolder: 'Select webhook type'
    });

    if (!selected) return;

    const url = await vscode.window.showInputBox({
        prompt: `Enter your ${selected.label.replace(/\$\([^)]+\)\s*/, '')} webhook URL`,
        placeHolder: 'https://hooks.slack.com/services/...',
        validateInput: (value) => {
            if (!value.startsWith('http://') && !value.startsWith('https://')) {
                return 'URL must start with http:// or https://';
            }
            return undefined;
        }
    });

    if (!url) return;

    const config = vscode.workspace.getConfiguration('amplifyMonitor');
    await config.update('webhook.enabled', true, vscode.ConfigurationTarget.Global);
    await config.update('webhook.url', url, vscode.ConfigurationTarget.Global);
    await config.update('webhook.type', selected.value, vscode.ConfigurationTarget.Global);

    const testNow = await vscode.window.showInformationMessage(
        'Webhook configured! Would you like to send a test notification?',
        'Yes', 'No'
    );

    if (testNow === 'Yes') {
        await WebhookNotificationService.getInstance().testWebhook();
    }
}
