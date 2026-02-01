import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface ProfileConfig {
    name: string;
    accessKeyId: string;
    secretAccessKey: string;
    region?: string;
    sessionToken?: string;
}

export async function configureAwsProfile(): Promise<void> {
    const wizard = new ProfileConfigurationWizard();
    await wizard.start();
}

class ProfileConfigurationWizard {
    private credentialsPath: string;
    private configPath: string;

    constructor() {
        this.credentialsPath = process.env.AWS_SHARED_CREDENTIALS_FILE || 
            path.join(os.homedir(), '.aws', 'credentials');
        this.configPath = process.env.AWS_CONFIG_FILE || 
            path.join(os.homedir(), '.aws', 'config');
    }

    async start(): Promise<void> {
        const action = await vscode.window.showQuickPick([
            { label: '$(add) Create New Profile', value: 'create' },
            { label: '$(edit) Edit Existing Profile', value: 'edit' },
            { label: '$(trash) Delete Profile', value: 'delete' },
            { label: '$(list-unordered) View All Profiles', value: 'view' },
            { label: '$(file) Open Credentials File', value: 'open-credentials' },
            { label: '$(file) Open Config File', value: 'open-config' },
        ], {
            title: 'AWS Profile Configuration',
            placeHolder: 'What would you like to do?'
        });

        if (!action) return;

        switch (action.value) {
            case 'create':
                await this.createProfile();
                break;
            case 'edit':
                await this.editProfile();
                break;
            case 'delete':
                await this.deleteProfile();
                break;
            case 'view':
                await this.viewProfiles();
                break;
            case 'open-credentials':
                await this.openFile(this.credentialsPath);
                break;
            case 'open-config':
                await this.openFile(this.configPath);
                break;
        }
    }

    private async createProfile(): Promise<void> {
        // Step 1: Profile name
        const profileName = await vscode.window.showInputBox({
            title: 'Create AWS Profile (1/4)',
            prompt: 'Enter profile name',
            placeHolder: 'e.g., my-client, production, staging',
            validateInput: (value) => {
                if (!value || value.trim() === '') {
                    return 'Profile name is required';
                }
                if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
                    return 'Profile name can only contain letters, numbers, hyphens, and underscores';
                }
                // Check if profile already exists
                const existingProfiles = this.getExistingProfiles();
                if (existingProfiles.includes(value)) {
                    return `Profile "${value}" already exists. Use edit to modify it.`;
                }
                return undefined;
            }
        });

        if (!profileName) return;

        // Step 2: Access Key ID
        const accessKeyId = await vscode.window.showInputBox({
            title: 'Create AWS Profile (2/4)',
            prompt: 'Enter AWS Access Key ID',
            placeHolder: 'AKIAIOSFODNN7EXAMPLE',
            ignoreFocusOut: true,
            validateInput: (value) => {
                if (!value || value.trim() === '') {
                    return 'Access Key ID is required';
                }
                if (!/^[A-Z0-9]{16,128}$/.test(value)) {
                    return 'Invalid Access Key ID format';
                }
                return undefined;
            }
        });

        if (!accessKeyId) return;

        // Step 3: Secret Access Key
        const secretAccessKey = await vscode.window.showInputBox({
            title: 'Create AWS Profile (3/4)',
            prompt: 'Enter AWS Secret Access Key',
            placeHolder: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
            password: true,
            ignoreFocusOut: true,
            validateInput: (value) => {
                if (!value || value.trim() === '') {
                    return 'Secret Access Key is required';
                }
                return undefined;
            }
        });

        if (!secretAccessKey) return;

        // Step 4: Region (optional)
        const region = await vscode.window.showQuickPick([
            { label: 'us-east-1', description: 'US East (N. Virginia)' },
            { label: 'us-east-2', description: 'US East (Ohio)' },
            { label: 'us-west-1', description: 'US West (N. California)' },
            { label: 'us-west-2', description: 'US West (Oregon)' },
            { label: 'eu-west-1', description: 'Europe (Ireland)' },
            { label: 'eu-west-2', description: 'Europe (London)' },
            { label: 'eu-central-1', description: 'Europe (Frankfurt)' },
            { label: 'ap-northeast-1', description: 'Asia Pacific (Tokyo)' },
            { label: 'ap-northeast-2', description: 'Asia Pacific (Seoul)' },
            { label: 'ap-southeast-1', description: 'Asia Pacific (Singapore)' },
            { label: 'ap-southeast-2', description: 'Asia Pacific (Sydney)' },
            { label: 'ap-south-1', description: 'Asia Pacific (Mumbai)' },
            { label: 'sa-east-1', description: 'South America (São Paulo)' },
            { label: 'ca-central-1', description: 'Canada (Central)' },
            { label: '$(edit) Enter custom region', description: 'Type a custom region' },
        ], {
            title: 'Create AWS Profile (4/4)',
            placeHolder: 'Select default region (optional)'
        });

        let selectedRegion: string | undefined;
        if (region?.label === '$(edit) Enter custom region') {
            selectedRegion = await vscode.window.showInputBox({
                prompt: 'Enter custom region',
                placeHolder: 'e.g., eu-north-1'
            });
        } else {
            selectedRegion = region?.label;
        }

        // Save the profile
        try {
            await this.saveProfile({
                name: profileName,
                accessKeyId,
                secretAccessKey,
                region: selectedRegion
            });

            const switchNow = await vscode.window.showInformationMessage(
                `AWS profile "${profileName}" created successfully!`,
                'Switch to this profile',
                'Close'
            );

            if (switchNow === 'Switch to this profile') {
                const config = vscode.workspace.getConfiguration('amplifyMonitor');
                await config.update('awsProfile', profileName, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`Switched to profile: ${profileName}`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to create profile: ${error}`);
        }
    }

    private async editProfile(): Promise<void> {
        const profiles = this.getExistingProfiles();
        
        if (profiles.length === 0) {
            vscode.window.showInformationMessage('No AWS profiles found. Create one first.');
            return;
        }

        const profileName = await vscode.window.showQuickPick(profiles, {
            title: 'Edit AWS Profile',
            placeHolder: 'Select profile to edit'
        });

        if (!profileName) return;

        const editOption = await vscode.window.showQuickPick([
            { label: '$(key) Update Access Keys', value: 'keys' },
            { label: '$(globe) Update Region', value: 'region' },
            { label: '$(file) Open in Editor', value: 'open' },
        ], {
            title: `Edit Profile: ${profileName}`,
            placeHolder: 'What would you like to update?'
        });

        if (!editOption) return;

        switch (editOption.value) {
            case 'keys':
                await this.updateAccessKeys(profileName);
                break;
            case 'region':
                await this.updateRegion(profileName);
                break;
            case 'open':
                await this.openFile(this.credentialsPath);
                break;
        }
    }

    private async updateAccessKeys(profileName: string): Promise<void> {
        const accessKeyId = await vscode.window.showInputBox({
            title: `Update Access Keys for "${profileName}"`,
            prompt: 'Enter new AWS Access Key ID',
            placeHolder: 'AKIAIOSFODNN7EXAMPLE',
            ignoreFocusOut: true
        });

        if (!accessKeyId) return;

        const secretAccessKey = await vscode.window.showInputBox({
            prompt: 'Enter new AWS Secret Access Key',
            password: true,
            ignoreFocusOut: true
        });

        if (!secretAccessKey) return;

        try {
            await this.updateProfileCredentials(profileName, accessKeyId, secretAccessKey);
            vscode.window.showInformationMessage(`Updated access keys for profile: ${profileName}`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to update profile: ${error}`);
        }
    }

    private async updateRegion(profileName: string): Promise<void> {
        const region = await vscode.window.showQuickPick([
            'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
            'eu-west-1', 'eu-west-2', 'eu-central-1',
            'ap-northeast-1', 'ap-northeast-2', 'ap-southeast-1', 'ap-southeast-2',
            'ap-south-1', 'sa-east-1', 'ca-central-1'
        ], {
            title: `Update Region for "${profileName}"`,
            placeHolder: 'Select new default region'
        });

        if (!region) return;

        try {
            await this.updateProfileRegion(profileName, region);
            vscode.window.showInformationMessage(`Updated region for profile "${profileName}" to ${region}`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to update region: ${error}`);
        }
    }

    private async deleteProfile(): Promise<void> {
        const profiles = this.getExistingProfiles();
        
        if (profiles.length === 0) {
            vscode.window.showInformationMessage('No AWS profiles found.');
            return;
        }

        const profileName = await vscode.window.showQuickPick(profiles, {
            title: 'Delete AWS Profile',
            placeHolder: 'Select profile to delete'
        });

        if (!profileName) return;

        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to delete the AWS profile "${profileName}"? This cannot be undone.`,
            { modal: true },
            'Delete'
        );

        if (confirm !== 'Delete') return;

        try {
            await this.removeProfile(profileName);
            vscode.window.showInformationMessage(`Deleted profile: ${profileName}`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to delete profile: ${error}`);
        }
    }

    private async viewProfiles(): Promise<void> {
        const profiles = this.getExistingProfiles();
        
        if (profiles.length === 0) {
            vscode.window.showInformationMessage('No AWS profiles found. Create one to get started.');
            return;
        }

        // Create a simple view
        const items = profiles.map(name => {
            const currentProfile = vscode.workspace.getConfiguration('amplifyMonitor').get<string>('awsProfile');
            const isActive = name === currentProfile || (name === 'default' && !currentProfile);
            return {
                label: `${isActive ? '$(check) ' : ''}${name}`,
                description: isActive ? 'Active' : '',
                name
            };
        });

        const selected = await vscode.window.showQuickPick(items, {
            title: 'AWS Profiles',
            placeHolder: 'Select a profile to switch to it'
        });

        if (selected) {
            const config = vscode.workspace.getConfiguration('amplifyMonitor');
            await config.update('awsProfile', selected.name, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`Switched to profile: ${selected.name}`);
        }
    }

    private getExistingProfiles(): string[] {
        const profiles = new Set<string>();

        // Parse credentials file
        if (fs.existsSync(this.credentialsPath)) {
            const content = fs.readFileSync(this.credentialsPath, 'utf-8');
            const matches = content.match(/\[([^\]]+)\]/g);
            if (matches) {
                matches.forEach(m => profiles.add(m.slice(1, -1)));
            }
        }

        // Parse config file
        if (fs.existsSync(this.configPath)) {
            const content = fs.readFileSync(this.configPath, 'utf-8');
            const matches = content.match(/\[(?:profile )?([^\]]+)\]/g);
            if (matches) {
                matches.forEach(m => {
                    const name = m.replace(/\[(?:profile )?/, '').replace(']', '');
                    profiles.add(name);
                });
            }
        }

        return Array.from(profiles).sort((a, b) => {
            if (a === 'default') return -1;
            if (b === 'default') return 1;
            return a.localeCompare(b);
        });
    }

    private async saveProfile(config: ProfileConfig): Promise<void> {
        // Ensure .aws directory exists
        const awsDir = path.dirname(this.credentialsPath);
        if (!fs.existsSync(awsDir)) {
            fs.mkdirSync(awsDir, { recursive: true });
        }

        // Add to credentials file
        let credentialsContent = '';
        if (fs.existsSync(this.credentialsPath)) {
            credentialsContent = fs.readFileSync(this.credentialsPath, 'utf-8');
        }

        const credentialsEntry = `\n[${config.name}]\naws_access_key_id = ${config.accessKeyId}\naws_secret_access_key = ${config.secretAccessKey}\n`;
        fs.writeFileSync(this.credentialsPath, credentialsContent + credentialsEntry);

        // Add region to config file if specified
        if (config.region) {
            let configContent = '';
            if (fs.existsSync(this.configPath)) {
                configContent = fs.readFileSync(this.configPath, 'utf-8');
            }

            const profileSection = config.name === 'default' ? '[default]' : `[profile ${config.name}]`;
            const configEntry = `\n${profileSection}\nregion = ${config.region}\n`;
            fs.writeFileSync(this.configPath, configContent + configEntry);
        }
    }

    private async updateProfileCredentials(profileName: string, accessKeyId: string, secretAccessKey: string): Promise<void> {
        if (!fs.existsSync(this.credentialsPath)) {
            throw new Error('Credentials file not found');
        }

        let content = fs.readFileSync(this.credentialsPath, 'utf-8');
        
        // Find and update the profile section
        const profileRegex = new RegExp(`(\\[${profileName}\\][^\\[]*?aws_access_key_id\\s*=\\s*)([^\\n]+)`, 'm');
        const secretRegex = new RegExp(`(\\[${profileName}\\][^\\[]*?aws_secret_access_key\\s*=\\s*)([^\\n]+)`, 'm');
        
        content = content.replace(profileRegex, `$1${accessKeyId}`);
        content = content.replace(secretRegex, `$1${secretAccessKey}`);
        
        fs.writeFileSync(this.credentialsPath, content);
    }

    private async updateProfileRegion(profileName: string, region: string): Promise<void> {
        // Ensure config file exists
        const awsDir = path.dirname(this.configPath);
        if (!fs.existsSync(awsDir)) {
            fs.mkdirSync(awsDir, { recursive: true });
        }

        let content = '';
        if (fs.existsSync(this.configPath)) {
            content = fs.readFileSync(this.configPath, 'utf-8');
        }

        const profileSection = profileName === 'default' ? '[default]' : `[profile ${profileName}]`;
        const sectionRegex = new RegExp(`(${profileSection.replace(/[[\]]/g, '\\$&')}[^\\[]*?)(region\\s*=\\s*)([^\\n]+)`, 'm');
        
        if (sectionRegex.test(content)) {
            // Update existing region
            content = content.replace(sectionRegex, `$1$2${region}`);
        } else if (content.includes(profileSection)) {
            // Add region to existing section
            content = content.replace(profileSection, `${profileSection}\nregion = ${region}`);
        } else {
            // Create new section
            content += `\n${profileSection}\nregion = ${region}\n`;
        }

        fs.writeFileSync(this.configPath, content);
    }

    private async removeProfile(profileName: string): Promise<void> {
        // Remove from credentials file
        if (fs.existsSync(this.credentialsPath)) {
            let content = fs.readFileSync(this.credentialsPath, 'utf-8');
            // Remove the entire profile section
            const regex = new RegExp(`\\[${profileName}\\][^\\[]*`, 'g');
            content = content.replace(regex, '').trim() + '\n';
            fs.writeFileSync(this.credentialsPath, content);
        }

        // Remove from config file
        if (fs.existsSync(this.configPath)) {
            let content = fs.readFileSync(this.configPath, 'utf-8');
            const profileSection = profileName === 'default' ? 'default' : `profile ${profileName}`;
            const regex = new RegExp(`\\[${profileSection}\\][^\\[]*`, 'g');
            content = content.replace(regex, '').trim() + '\n';
            fs.writeFileSync(this.configPath, content);
        }
    }

    private async openFile(filePath: string): Promise<void> {
        // Create the file if it doesn't exist
        if (!fs.existsSync(filePath)) {
            const awsDir = path.dirname(filePath);
            if (!fs.existsSync(awsDir)) {
                fs.mkdirSync(awsDir, { recursive: true });
            }
            fs.writeFileSync(filePath, '');
        }

        const document = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(document);
    }
}
