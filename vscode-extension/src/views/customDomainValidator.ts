import * as vscode from 'vscode';
import * as dns from 'dns';
import * as https from 'https';
import { promisify } from 'util';

const dnsResolve = promisify(dns.resolve);
const dnsResolve4 = promisify(dns.resolve4);
const dnsResolveCname = promisify(dns.resolveCname);
const dnsResolveTxt = promisify(dns.resolveTxt);

// Amplify CloudFront domains pattern
const AMPLIFY_CLOUDFRONT_PATTERN = /\.cloudfront\.net$/;
const AMPLIFY_DOMAIN_PATTERN = /\.amplifyapp\.com$/;

interface DnsRecord {
    type: 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'NS';
    value: string;
    ttl?: number;
}

interface SslInfo {
    valid: boolean;
    issuer?: string;
    validFrom?: string;
    validTo?: string;
    daysRemaining?: number;
    error?: string;
}

interface DomainCheck {
    name: string;
    status: 'success' | 'warning' | 'error' | 'info';
    message: string;
    details?: string;
    fix?: {
        action: string;
        description: string;
        data?: any;
    };
}

interface DomainValidationResult {
    domain: string;
    isApex: boolean;
    dnsRecords: DnsRecord[];
    ssl: SslInfo;
    checks: DomainCheck[];
    amplifyConfig: {
        expectedCname?: string;
        expectedValidation?: string;
        appId?: string;
        branch?: string;
    };
    summary: {
        total: number;
        passed: number;
        warnings: number;
        errors: number;
    };
}

export class CustomDomainValidatorPanel {
    public static currentPanel: CustomDomainValidatorPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _appId: string | undefined;
    private _branch: string | undefined;

    public static createOrShow(extensionUri: vscode.Uri, appId?: string, branch?: string) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (CustomDomainValidatorPanel.currentPanel) {
            CustomDomainValidatorPanel.currentPanel._appId = appId;
            CustomDomainValidatorPanel.currentPanel._branch = branch;
            CustomDomainValidatorPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'customDomainValidator',
            'Custom Domain Validator',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        CustomDomainValidatorPanel.currentPanel = new CustomDomainValidatorPanel(panel, extensionUri, appId, branch);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, appId?: string, branch?: string) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._appId = appId;
        this._branch = branch;

        this._update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'validate':
                        await this._validateDomain(message.domain);
                        break;
                    case 'copyToClipboard':
                        await vscode.env.clipboard.writeText(message.text);
                        vscode.window.showInformationMessage('Copied to clipboard!');
                        break;
                    case 'openUrl':
                        vscode.env.openExternal(vscode.Uri.parse(message.url));
                        break;
                    case 'openAmplifyConsole':
                        this._openAmplifyConsole();
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    public dispose() {
        CustomDomainValidatorPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private async _update() {
        this._panel.webview.html = this._getHtmlContent();
    }

    private async _validateDomain(domain: string) {
        this._panel.webview.postMessage({ command: 'validating' });

        try {
            // Clean up the domain
            domain = domain.trim().toLowerCase();
            domain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

            const result = await this._performValidation(domain);

            this._panel.webview.postMessage({
                command: 'validationResult',
                result
            });
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'validationResult',
                error: `Validation failed: ${error}`
            });
        }
    }

    private async _performValidation(domain: string): Promise<DomainValidationResult> {
        const checks: DomainCheck[] = [];
        const dnsRecords: DnsRecord[] = [];
        
        // Determine if apex domain
        const isApex = this._isApexDomain(domain);

        // 1. DNS Resolution checks
        await this._checkDnsRecords(domain, dnsRecords, checks, isApex);

        // 2. SSL Certificate check
        const ssl = await this._checkSslCertificate(domain);
        this._addSslChecks(ssl, checks, domain);

        // 3. Amplify-specific checks
        await this._checkAmplifyConfiguration(domain, dnsRecords, checks, isApex);

        // 4. Common misconfigurations
        this._checkCommonIssues(domain, dnsRecords, checks, isApex);

        // Calculate summary
        const summary = {
            total: checks.length,
            passed: checks.filter(c => c.status === 'success').length,
            warnings: checks.filter(c => c.status === 'warning').length,
            errors: checks.filter(c => c.status === 'error').length
        };

        // Generate expected Amplify configuration
        const amplifyConfig = this._generateAmplifyConfig(domain, isApex);

        return {
            domain,
            isApex,
            dnsRecords,
            ssl,
            checks,
            amplifyConfig,
            summary
        };
    }

    private _isApexDomain(domain: string): boolean {
        const parts = domain.split('.');
        // apex if only 2 parts (example.com) or known TLDs like .co.uk
        if (parts.length === 2) return true;
        
        // Check for known 2-part TLDs
        const twoPartTlds = ['.co.uk', '.com.au', '.co.nz', '.co.jp', '.com.br'];
        for (const tld of twoPartTlds) {
            if (domain.endsWith(tld) && parts.length === 3) return true;
        }
        
        return false;
    }

    private async _checkDnsRecords(
        domain: string,
        records: DnsRecord[],
        checks: DomainCheck[],
        isApex: boolean
    ) {
        // Try CNAME lookup (for subdomains)
        try {
            const cnames = await dnsResolveCname(domain);
            for (const cname of cnames) {
                records.push({ type: 'CNAME', value: cname });
            }
            
            // Check if CNAME points to Amplify
            const hasAmplifyTarget = cnames.some(c => 
                AMPLIFY_CLOUDFRONT_PATTERN.test(c) || AMPLIFY_DOMAIN_PATTERN.test(c)
            );
            
            if (hasAmplifyTarget) {
                checks.push({
                    name: 'CNAME Record',
                    status: 'success',
                    message: 'CNAME correctly points to Amplify',
                    details: cnames.join(', ')
                });
            } else {
                checks.push({
                    name: 'CNAME Record',
                    status: 'warning',
                    message: 'CNAME exists but does not point to Amplify',
                    details: `Current: ${cnames.join(', ')}`,
                    fix: {
                        action: 'update_cname',
                        description: 'Update CNAME to point to your Amplify domain'
                    }
                });
            }
        } catch (e: any) {
            if (e.code === 'ENODATA' || e.code === 'ENOTFOUND') {
                if (!isApex) {
                    checks.push({
                        name: 'CNAME Record',
                        status: 'error',
                        message: 'No CNAME record found for subdomain',
                        details: 'Subdomains require a CNAME record pointing to Amplify',
                        fix: {
                            action: 'add_cname',
                            description: 'Add CNAME record in your DNS provider'
                        }
                    });
                }
            }
        }

        // Try A record lookup (especially for apex domains)
        try {
            const aRecords = await dnsResolve4(domain);
            for (const ip of aRecords) {
                records.push({ type: 'A', value: ip });
            }

            if (isApex) {
                // Apex domains need ALIAS/ANAME record or A record to CloudFront IPs
                checks.push({
                    name: 'A Record (Apex)',
                    status: 'info',
                    message: `A records found: ${aRecords.join(', ')}`,
                    details: 'Apex domains require ALIAS/ANAME record or Route 53 alias'
                });
            }
        } catch (e: any) {
            if (isApex && (e.code === 'ENODATA' || e.code === 'ENOTFOUND')) {
                checks.push({
                    name: 'A Record (Apex)',
                    status: 'error',
                    message: 'No A record found for apex domain',
                    details: 'Apex domains need an A/ALIAS record',
                    fix: {
                        action: 'add_alias',
                        description: 'Add ALIAS record or use Route 53'
                    }
                });
            }
        }

        // Check TXT records for domain validation
        try {
            const txtRecords = await dnsResolveTxt(domain);
            for (const txt of txtRecords) {
                records.push({ type: 'TXT', value: txt.join('') });
            }

            // Check for Amplify validation record
            const hasAmplifyValidation = txtRecords.some(t => 
                t.some(v => v.includes('_') && v.includes('.') && v.length > 30)
            );

            if (hasAmplifyValidation) {
                checks.push({
                    name: 'Domain Validation',
                    status: 'success',
                    message: 'Amplify domain validation TXT record found'
                });
            }
        } catch (e) {
            // TXT records are optional
        }

        // Also check _acme-challenge for Let's Encrypt
        try {
            const acmeTxt = await dnsResolveTxt(`_acme-challenge.${domain}`);
            for (const txt of acmeTxt) {
                records.push({ type: 'TXT', value: `_acme-challenge: ${txt.join('')}` });
            }
        } catch (e) {
            // ACME challenge is optional
        }
    }

    private async _checkSslCertificate(domain: string): Promise<SslInfo> {
        return new Promise((resolve) => {
            const options = {
                hostname: domain,
                port: 443,
                method: 'HEAD',
                timeout: 10000,
                rejectUnauthorized: false // Allow checking invalid certs
            };

            const req = https.request(options, (res) => {
                const socket = res.socket as any;
                const cert = socket.getPeerCertificate?.();

                if (cert && Object.keys(cert).length > 0) {
                    const validFrom = new Date(cert.valid_from);
                    const validTo = new Date(cert.valid_to);
                    const now = new Date();
                    const daysRemaining = Math.floor((validTo.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

                    resolve({
                        valid: socket.authorized && daysRemaining > 0,
                        issuer: cert.issuer?.O || cert.issuer?.CN,
                        validFrom: validFrom.toISOString().split('T')[0],
                        validTo: validTo.toISOString().split('T')[0],
                        daysRemaining
                    });
                } else {
                    resolve({
                        valid: false,
                        error: 'No certificate found'
                    });
                }
            });

            req.on('error', (e) => {
                resolve({
                    valid: false,
                    error: e.message
                });
            });

            req.on('timeout', () => {
                req.destroy();
                resolve({
                    valid: false,
                    error: 'Connection timeout'
                });
            });

            req.end();
        });
    }

    private _addSslChecks(ssl: SslInfo, checks: DomainCheck[], domain: string) {
        if (ssl.error) {
            if (ssl.error.includes('ENOTFOUND') || ssl.error.includes('getaddrinfo')) {
                checks.push({
                    name: 'SSL Certificate',
                    status: 'error',
                    message: 'Domain does not resolve - cannot check SSL',
                    details: 'DNS must be configured before SSL can be verified'
                });
            } else if (ssl.error.includes('ECONNREFUSED')) {
                checks.push({
                    name: 'SSL Certificate',
                    status: 'error',
                    message: 'Connection refused on port 443',
                    details: 'The domain is not serving HTTPS traffic'
                });
            } else if (ssl.error.includes('timeout')) {
                checks.push({
                    name: 'SSL Certificate',
                    status: 'warning',
                    message: 'SSL check timed out',
                    details: 'Could not verify certificate within timeout'
                });
            } else {
                checks.push({
                    name: 'SSL Certificate',
                    status: 'error',
                    message: 'SSL certificate error',
                    details: ssl.error
                });
            }
            return;
        }

        if (ssl.valid) {
            if (ssl.daysRemaining !== undefined && ssl.daysRemaining < 30) {
                checks.push({
                    name: 'SSL Certificate',
                    status: 'warning',
                    message: `Certificate expiring in ${ssl.daysRemaining} days`,
                    details: `Expires: ${ssl.validTo}. Amplify auto-renews, but verify it's managed by Amplify.`
                });
            } else {
                checks.push({
                    name: 'SSL Certificate',
                    status: 'success',
                    message: 'Valid SSL certificate',
                    details: `Issuer: ${ssl.issuer}, Expires: ${ssl.validTo} (${ssl.daysRemaining} days)`
                });
            }

            // Check if issued by Amazon/Let's Encrypt (Amplify uses these)
            if (ssl.issuer && (ssl.issuer.includes('Amazon') || ssl.issuer.includes("Let's Encrypt"))) {
                checks.push({
                    name: 'Certificate Issuer',
                    status: 'success',
                    message: `Certificate issued by ${ssl.issuer}`,
                    details: 'This is consistent with Amplify-managed certificates'
                });
            }
        } else {
            checks.push({
                name: 'SSL Certificate',
                status: 'error',
                message: 'Invalid SSL certificate',
                details: ssl.error || 'Certificate validation failed',
                fix: {
                    action: 'check_amplify',
                    description: 'Verify domain is added in Amplify Console and SSL is provisioned'
                }
            });
        }
    }

    private async _checkAmplifyConfiguration(
        domain: string,
        records: DnsRecord[],
        checks: DomainCheck[],
        isApex: boolean
    ) {
        // Check for common Amplify misconfigurations
        const cnameRecords = records.filter(r => r.type === 'CNAME');
        
        // Check for www vs non-www
        if (!domain.startsWith('www.')) {
            // Check if www version exists
            try {
                const wwwCnames = await dnsResolveCname(`www.${domain}`);
                if (wwwCnames.length > 0) {
                    checks.push({
                        name: 'WWW Redirect',
                        status: 'info',
                        message: `www.${domain} also configured`,
                        details: 'Both www and non-www versions should redirect to a canonical URL'
                    });
                }
            } catch (e) {
                if (isApex) {
                    checks.push({
                        name: 'WWW Subdomain',
                        status: 'info',
                        message: `www.${domain} not configured`,
                        details: 'Consider adding www subdomain and setting up redirect'
                    });
                }
            }
        }

        // Check for CloudFront configuration issues
        const hasCloudFrontCname = cnameRecords.some(r => AMPLIFY_CLOUDFRONT_PATTERN.test(r.value));
        const hasAmplifyDomainCname = cnameRecords.some(r => AMPLIFY_DOMAIN_PATTERN.test(r.value));

        if (hasCloudFrontCname && !hasAmplifyDomainCname) {
            checks.push({
                name: 'Amplify Setup',
                status: 'success',
                message: 'Domain points to CloudFront (Amplify CDN)',
                details: 'This is the correct configuration for Amplify custom domains'
            });
        } else if (hasAmplifyDomainCname) {
            checks.push({
                name: 'Amplify Setup',
                status: 'warning',
                message: 'Domain points to .amplifyapp.com domain',
                details: 'For best performance, the CNAME should point to the CloudFront distribution'
            });
        }

        // Check propagation
        if (cnameRecords.length > 0 || records.filter(r => r.type === 'A').length > 0) {
            checks.push({
                name: 'DNS Propagation',
                status: 'success',
                message: 'DNS records are resolving',
                details: 'Records have propagated successfully'
            });
        } else {
            checks.push({
                name: 'DNS Propagation',
                status: 'warning',
                message: 'No DNS records found',
                details: 'DNS changes can take up to 48 hours to propagate globally',
                fix: {
                    action: 'wait',
                    description: 'Wait for DNS propagation or verify DNS provider settings'
                }
            });
        }
    }

    private _checkCommonIssues(
        domain: string,
        records: DnsRecord[],
        checks: DomainCheck[],
        isApex: boolean
    ) {
        // Check for conflicting records
        const cnameRecords = records.filter(r => r.type === 'CNAME');
        const aRecords = records.filter(r => r.type === 'A');

        if (cnameRecords.length > 0 && aRecords.length > 0 && !isApex) {
            checks.push({
                name: 'Conflicting Records',
                status: 'warning',
                message: 'Both CNAME and A records exist',
                details: 'This can cause routing issues. For Amplify, use only CNAME for subdomains.',
                fix: {
                    action: 'remove_a',
                    description: 'Remove A records and keep only the CNAME'
                }
            });
        }

        // Check for proxy (Cloudflare orange cloud)
        const hasProxyLikeIps = aRecords.some(r => {
            // Cloudflare IPs start with 104.16, 172.67, 104.21, etc.
            return r.value.startsWith('104.') || r.value.startsWith('172.67') || r.value.startsWith('141.101');
        });

        if (hasProxyLikeIps) {
            checks.push({
                name: 'CDN Proxy Detected',
                status: 'warning',
                message: 'Possible CDN proxy (Cloudflare) detected',
                details: 'Proxying through another CDN can cause issues with Amplify SSL and caching',
                fix: {
                    action: 'disable_proxy',
                    description: 'Disable proxy mode (grey cloud in Cloudflare) for Amplify domains'
                }
            });
        }

        // Check for nameserver configuration
        if (isApex && aRecords.length === 0 && cnameRecords.length === 0) {
            checks.push({
                name: 'Apex Domain Setup',
                status: 'error',
                message: 'Apex domain has no valid records',
                details: 'Apex domains cannot use CNAME. Use ALIAS, ANAME, or Route 53.',
                fix: {
                    action: 'setup_apex',
                    description: 'Use Route 53 or a DNS provider that supports ALIAS records'
                }
            });
        }

        // Check for CAA records that might block certificate issuance
        this._checkCaaRecords(domain, checks);
    }

    private async _checkCaaRecords(domain: string, checks: DomainCheck[]) {
        try {
            const caaRecords = await dnsResolve(domain, 'CAA') as any[];
            
            if (caaRecords && caaRecords.length > 0) {
                const allowsAmazon = caaRecords.some(r => 
                    r.issue?.includes('amazon') || r.issue?.includes('amazontrust')
                );
                const allowsLetsEncrypt = caaRecords.some(r => 
                    r.issue?.includes('letsencrypt')
                );

                if (!allowsAmazon && !allowsLetsEncrypt) {
                    checks.push({
                        name: 'CAA Records',
                        status: 'error',
                        message: 'CAA records may block Amplify certificate issuance',
                        details: 'CAA records restrict which CAs can issue certificates. Add amazon.com or letsencrypt.org.',
                        fix: {
                            action: 'update_caa',
                            description: 'Add CAA record: 0 issue "amazon.com"'
                        }
                    });
                } else {
                    checks.push({
                        name: 'CAA Records',
                        status: 'success',
                        message: 'CAA records allow Amplify certificate issuance'
                    });
                }
            }
        } catch (e) {
            // No CAA records is fine - allows any CA
        }
    }

    private _generateAmplifyConfig(domain: string, isApex: boolean): DomainValidationResult['amplifyConfig'] {
        const config: DomainValidationResult['amplifyConfig'] = {};

        if (this._appId) {
            config.appId = this._appId;
            // Generate expected CNAME target
            config.expectedCname = `${this._appId}.cloudfront.net`;
        }

        if (this._branch) {
            config.branch = this._branch;
        }

        // Note: In real implementation, would fetch actual validation value from Amplify API
        config.expectedValidation = `_abc123.${domain}`;

        return config;
    }

    private _openAmplifyConsole() {
        const region = vscode.workspace.getConfiguration('amplifyMonitor').get('defaultRegion', 'us-east-1');
        
        if (this._appId) {
            const url = `https://${region}.console.aws.amazon.com/amplify/apps/${this._appId}/settings/domain-management`;
            vscode.env.openExternal(vscode.Uri.parse(url));
        } else {
            vscode.env.openExternal(vscode.Uri.parse(`https://${region}.console.aws.amazon.com/amplify/home`));
        }
    }

    private _getHtmlContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Custom Domain Validator</title>
    <style>
        :root {
            --bg-color: var(--vscode-editor-background);
            --text-color: var(--vscode-editor-foreground);
            --border-color: var(--vscode-panel-border);
            --card-bg: var(--vscode-editorWidget-background);
            --success-color: #4caf50;
            --warning-color: #ff9800;
            --error-color: #f44336;
            --info-color: #2196f3;
        }
        
        * { box-sizing: border-box; }
        
        body {
            font-family: var(--vscode-font-family);
            color: var(--text-color);
            background: var(--bg-color);
            padding: 20px;
            margin: 0;
        }
        
        h1 {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 8px;
        }
        
        .subtitle {
            color: var(--vscode-descriptionForeground);
            margin-bottom: 24px;
        }
        
        .input-group {
            display: flex;
            gap: 8px;
            margin-bottom: 24px;
        }
        
        input[type="text"] {
            flex: 1;
            padding: 10px 14px;
            font-size: 14px;
            border: 1px solid var(--border-color);
            border-radius: 6px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
        }
        
        input[type="text"]:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
        }
        
        button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 10px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            white-space: nowrap;
        }
        
        button:hover { background: var(--vscode-button-hoverBackground); }
        button:disabled { opacity: 0.6; cursor: not-allowed; }
        
        button.secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        
        .card {
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 16px;
            margin-bottom: 16px;
        }
        
        .card h2 {
            margin: 0 0 16px 0;
            font-size: 14px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .summary-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 12px;
            margin-bottom: 16px;
        }
        
        .summary-item {
            text-align: center;
            padding: 16px;
            border-radius: 8px;
            background: var(--vscode-input-background);
        }
        
        .summary-item .count {
            font-size: 28px;
            font-weight: bold;
        }
        
        .summary-item .label {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
        }
        
        .summary-item.passed .count { color: var(--success-color); }
        .summary-item.warnings .count { color: var(--warning-color); }
        .summary-item.errors .count { color: var(--error-color); }
        
        .domain-info {
            display: flex;
            align-items: center;
            gap: 16px;
            padding: 12px 16px;
            background: var(--vscode-input-background);
            border-radius: 6px;
            margin-bottom: 16px;
        }
        
        .domain-name {
            font-size: 18px;
            font-weight: bold;
            font-family: var(--vscode-editor-font-family);
        }
        
        .domain-badge {
            padding: 4px 10px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 500;
            text-transform: uppercase;
        }
        
        .domain-badge.apex {
            background: rgba(33, 150, 243, 0.2);
            color: var(--info-color);
        }
        
        .domain-badge.subdomain {
            background: rgba(76, 175, 80, 0.2);
            color: var(--success-color);
        }
        
        .check {
            display: flex;
            gap: 12px;
            padding: 12px;
            border-radius: 6px;
            margin-bottom: 8px;
            align-items: flex-start;
        }
        
        .check:last-child { margin-bottom: 0; }
        
        .check.success { background: rgba(76, 175, 80, 0.1); border-left: 3px solid var(--success-color); }
        .check.warning { background: rgba(255, 152, 0, 0.1); border-left: 3px solid var(--warning-color); }
        .check.error { background: rgba(244, 67, 54, 0.1); border-left: 3px solid var(--error-color); }
        .check.info { background: rgba(33, 150, 243, 0.1); border-left: 3px solid var(--info-color); }
        
        .check-icon { font-size: 18px; flex-shrink: 0; }
        .check-content { flex: 1; min-width: 0; }
        
        .check-name {
            font-weight: 600;
            margin-bottom: 2px;
        }
        
        .check-message {
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
        }
        
        .check-details {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
            font-family: var(--vscode-editor-font-family);
        }
        
        .check-fix {
            margin-top: 8px;
        }
        
        .dns-record {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 10px 12px;
            background: var(--vscode-input-background);
            border-radius: 4px;
            margin-bottom: 6px;
            font-family: var(--vscode-editor-font-family);
            font-size: 13px;
        }
        
        .dns-type {
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: bold;
            min-width: 50px;
            text-align: center;
        }
        
        .dns-type.CNAME { background: #e3f2fd; color: #1565c0; }
        .dns-type.A { background: #e8f5e9; color: #2e7d32; }
        .dns-type.TXT { background: #fff3e0; color: #ef6c00; }
        .dns-type.NS { background: #f3e5f5; color: #7b1fa2; }
        
        .dns-value {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        
        .copy-btn {
            padding: 4px 8px;
            font-size: 11px;
            background: transparent;
            border: 1px solid var(--border-color);
        }
        
        .copy-btn:hover {
            background: var(--vscode-input-background);
        }
        
        .ssl-info {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 12px;
        }
        
        .ssl-item {
            padding: 12px;
            background: var(--vscode-input-background);
            border-radius: 6px;
        }
        
        .ssl-label {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
        }
        
        .ssl-value {
            font-weight: 500;
        }
        
        .ssl-value.valid { color: var(--success-color); }
        .ssl-value.invalid { color: var(--error-color); }
        .ssl-value.warning { color: var(--warning-color); }
        
        .config-box {
            background: var(--vscode-input-background);
            border-radius: 6px;
            padding: 12px;
            font-family: var(--vscode-editor-font-family);
            font-size: 13px;
        }
        
        .config-row {
            display: flex;
            justify-content: space-between;
            padding: 6px 0;
            border-bottom: 1px solid var(--border-color);
        }
        
        .config-row:last-child { border-bottom: none; }
        
        .loading {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 40px;
            color: var(--vscode-descriptionForeground);
        }
        
        .spinner {
            width: 32px;
            height: 32px;
            border: 3px solid var(--border-color);
            border-top-color: var(--vscode-focusBorder);
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-bottom: 12px;
        }
        
        @keyframes spin { to { transform: rotate(360deg); } }
        
        .empty-state {
            text-align: center;
            padding: 60px 20px;
            color: var(--vscode-descriptionForeground);
        }
        
        .empty-state-icon {
            font-size: 48px;
            margin-bottom: 16px;
        }
        
        .quick-links {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
            margin-top: 16px;
        }
    </style>
</head>
<body>
    <h1>🌐 Custom Domain Validator</h1>
    <p class="subtitle">Validate DNS, SSL, and Amplify configuration for your custom domain</p>
    
    <div class="input-group">
        <input type="text" id="domain-input" placeholder="Enter domain (e.g., example.com or app.example.com)" />
        <button id="validate-btn" onclick="validate()">🔍 Validate</button>
    </div>
    
    <div id="content">
        <div class="empty-state">
            <div class="empty-state-icon">🌍</div>
            <div style="font-size: 16px; margin-bottom: 8px;">Enter a domain to validate</div>
            <div>We'll check DNS records, SSL certificates, and Amplify configuration</div>
        </div>
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        const domainInput = document.getElementById('domain-input');
        const validateBtn = document.getElementById('validate-btn');
        
        domainInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') validate();
        });
        
        window.addEventListener('message', event => {
            const message = event.data;
            
            if (message.command === 'validating') {
                showLoading();
            } else if (message.command === 'validationResult') {
                if (message.error) {
                    showError(message.error);
                } else {
                    showResult(message.result);
                }
            }
        });
        
        function validate() {
            const domain = domainInput.value.trim();
            if (!domain) {
                alert('Please enter a domain');
                return;
            }
            vscode.postMessage({ command: 'validate', domain });
        }
        
        function showLoading() {
            validateBtn.disabled = true;
            document.getElementById('content').innerHTML = \`
                <div class="loading">
                    <div class="spinner"></div>
                    <div>Checking DNS records, SSL certificate, and configuration...</div>
                </div>
            \`;
        }
        
        function showError(error) {
            validateBtn.disabled = false;
            document.getElementById('content').innerHTML = \`
                <div class="card">
                    <div class="check error">
                        <div class="check-icon">❌</div>
                        <div class="check-content">
                            <div class="check-name">Validation Error</div>
                            <div class="check-message">\${error}</div>
                        </div>
                    </div>
                </div>
            \`;
        }
        
        function showResult(result) {
            validateBtn.disabled = false;
            
            const html = \`
                <div class="card">
                    <div class="domain-info">
                        <span class="domain-name">\${result.domain}</span>
                        <span class="domain-badge \${result.isApex ? 'apex' : 'subdomain'}">
                            \${result.isApex ? '🏠 Apex Domain' : '📁 Subdomain'}
                        </span>
                    </div>
                    
                    <div class="summary-grid">
                        <div class="summary-item passed">
                            <div class="count">\${result.summary.passed}</div>
                            <div class="label">Passed</div>
                        </div>
                        <div class="summary-item warnings">
                            <div class="count">\${result.summary.warnings}</div>
                            <div class="label">Warnings</div>
                        </div>
                        <div class="summary-item errors">
                            <div class="count">\${result.summary.errors}</div>
                            <div class="label">Errors</div>
                        </div>
                        <div class="summary-item">
                            <div class="count">\${result.dnsRecords.length}</div>
                            <div class="label">DNS Records</div>
                        </div>
                    </div>
                </div>
                
                <div class="card">
                    <h2>📋 Validation Checks</h2>
                    \${result.checks.map(check => \`
                        <div class="check \${check.status}">
                            <div class="check-icon">\${getStatusIcon(check.status)}</div>
                            <div class="check-content">
                                <div class="check-name">\${check.name}</div>
                                <div class="check-message">\${check.message}</div>
                                \${check.details ? \`<div class="check-details">\${check.details}</div>\` : ''}
                                \${check.fix ? \`
                                    <div class="check-fix">
                                        <button class="secondary" onclick="showFix('\${check.fix.action}', '\${check.fix.description}')">
                                            🔧 \${check.fix.description}
                                        </button>
                                    </div>
                                \` : ''}
                            </div>
                        </div>
                    \`).join('')}
                </div>
                
                \${result.dnsRecords.length > 0 ? \`
                    <div class="card">
                        <h2>🔤 DNS Records Found</h2>
                        \${result.dnsRecords.map(record => \`
                            <div class="dns-record">
                                <span class="dns-type \${record.type}">\${record.type}</span>
                                <span class="dns-value" title="\${record.value}">\${record.value}</span>
                                <button class="copy-btn" onclick="copyToClipboard('\${record.value.replace(/'/g, "\\\\'")}')">📋 Copy</button>
                            </div>
                        \`).join('')}
                    </div>
                \` : ''}
                
                <div class="card">
                    <h2>🔒 SSL Certificate</h2>
                    \${result.ssl.error ? \`
                        <div class="check error">
                            <div class="check-icon">❌</div>
                            <div class="check-content">
                                <div class="check-name">Certificate Error</div>
                                <div class="check-message">\${result.ssl.error}</div>
                            </div>
                        </div>
                    \` : \`
                        <div class="ssl-info">
                            <div class="ssl-item">
                                <div class="ssl-label">Status</div>
                                <div class="ssl-value \${result.ssl.valid ? 'valid' : 'invalid'}">
                                    \${result.ssl.valid ? '✅ Valid' : '❌ Invalid'}
                                </div>
                            </div>
                            <div class="ssl-item">
                                <div class="ssl-label">Issuer</div>
                                <div class="ssl-value">\${result.ssl.issuer || 'Unknown'}</div>
                            </div>
                            <div class="ssl-item">
                                <div class="ssl-label">Valid Until</div>
                                <div class="ssl-value">\${result.ssl.validTo || 'N/A'}</div>
                            </div>
                            <div class="ssl-item">
                                <div class="ssl-label">Days Remaining</div>
                                <div class="ssl-value \${result.ssl.daysRemaining < 30 ? 'warning' : ''}">
                                    \${result.ssl.daysRemaining !== undefined ? result.ssl.daysRemaining + ' days' : 'N/A'}
                                </div>
                            </div>
                        </div>
                    \`}
                </div>
                
                <div class="card">
                    <h2>⚙️ Required Configuration</h2>
                    <p style="color: var(--vscode-descriptionForeground); margin-bottom: 12px;">
                        Add these records in your DNS provider:
                    </p>
                    <div class="config-box">
                        \${result.isApex ? \`
                            <div class="config-row">
                                <span>Type</span>
                                <span><strong>ALIAS</strong> or <strong>A</strong> (Route 53)</span>
                            </div>
                            <div class="config-row">
                                <span>Name</span>
                                <span>@ (or blank)</span>
                            </div>
                            <div class="config-row">
                                <span>Value</span>
                                <span>Your Amplify CloudFront domain</span>
                            </div>
                        \` : \`
                            <div class="config-row">
                                <span>Type</span>
                                <span><strong>CNAME</strong></span>
                            </div>
                            <div class="config-row">
                                <span>Name</span>
                                <span>\${result.domain.split('.')[0]}</span>
                            </div>
                            <div class="config-row">
                                <span>Value</span>
                                <span>\${result.amplifyConfig.expectedCname || '[Your Amplify domain].cloudfront.net'}</span>
                            </div>
                        \`}
                    </div>
                    
                    <div class="quick-links">
                        <button class="secondary" onclick="openAmplifyConsole()">🔗 Amplify Console</button>
                        <button class="secondary" onclick="openUrl('https://docs.aws.amazon.com/amplify/latest/userguide/custom-domains.html')">📚 Docs</button>
                    </div>
                </div>
            \`;
            
            document.getElementById('content').innerHTML = html;
        }
        
        function getStatusIcon(status) {
            const icons = { success: '✅', warning: '⚠️', error: '❌', info: '💡' };
            return icons[status] || '📌';
        }
        
        function copyToClipboard(text) {
            vscode.postMessage({ command: 'copyToClipboard', text });
        }
        
        function openUrl(url) {
            vscode.postMessage({ command: 'openUrl', url });
        }
        
        function openAmplifyConsole() {
            vscode.postMessage({ command: 'openAmplifyConsole' });
        }
        
        function showFix(action, description) {
            alert('Fix: ' + description + '\\n\\nAction: ' + action);
        }
    </script>
</body>
</html>`;
    }
}
