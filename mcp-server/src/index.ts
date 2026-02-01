#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { AmplifyMonitorCli } from './cli.js';

// Initialize CLI wrapper
const cli = new AmplifyMonitorCli(process.env.AMPLIFY_MONITOR_CLI_PATH || 'amplify-monitor');

// ============================================================================
// Input Validation Schemas
// ============================================================================

const BaseSchema = z.object({
    region: z.string().optional(),
    profile: z.string().optional(),
});

const ListAppsSchema = BaseSchema;

const ListBranchesSchema = BaseSchema.extend({
    appId: z.string().min(1, 'appId is required'),
});

const ListJobsSchema = BaseSchema.extend({
    appId: z.string().min(1, 'appId is required'),
    branch: z.string().min(1, 'branch is required'),
});

const DiagnoseSchema = BaseSchema.extend({
    appId: z.string().min(1, 'appId is required'),
    branch: z.string().min(1, 'branch is required'),
    jobId: z.string().optional(),
});

const LatestFailedSchema = BaseSchema.extend({
    appId: z.string().min(1, 'appId is required'),
    branch: z.string().min(1, 'branch is required'),
});

const EnvVarsSchema = BaseSchema.extend({
    appId: z.string().min(1, 'appId is required'),
    branch: z.string().min(1, 'branch is required'),
});

const SetEnvVarSchema = BaseSchema.extend({
    appId: z.string().min(1, 'appId is required'),
    branch: z.string().min(1, 'branch is required'),
    name: z.string().min(1, 'name is required'),
    value: z.string().min(1, 'value is required'),
});

const DeleteEnvVarSchema = BaseSchema.extend({
    appId: z.string().min(1, 'appId is required'),
    branch: z.string().min(1, 'branch is required'),
    name: z.string().min(1, 'name is required'),
});

const StartBuildSchema = BaseSchema.extend({
    appId: z.string().min(1, 'appId is required'),
    branch: z.string().min(1, 'branch is required'),
});

const StopBuildSchema = BaseSchema.extend({
    appId: z.string().min(1, 'appId is required'),
    branch: z.string().min(1, 'branch is required'),
    jobId: z.string().min(1, 'jobId is required'),
});

const MigrationAnalysisSchema = z.object({
    projectPath: z.string().min(1, 'projectPath is required'),
});

const MonitorBuildSchema = BaseSchema.extend({
    appId: z.string().min(1, 'appId is required'),
    branch: z.string().min(1, 'branch is required'),
    jobId: z.string().optional(),
    waitForCompletion: z.boolean().optional().default(true),
    timeoutSeconds: z.number().optional().default(1800),
});

const GetBuildLogsSchema = BaseSchema.extend({
    appId: z.string().min(1, 'appId is required'),
    branch: z.string().min(1, 'branch is required'),
    jobId: z.string().optional(),
    logType: z.enum(['build', 'deploy', 'both']).optional().default('both'),
});

// ============================================================================
// Tool Definitions
// ============================================================================

// Define available tools
const tools: Tool[] = [
    {
        name: 'amplify_list_apps',
        description: 'List all AWS Amplify applications across all regions. Returns app IDs, names, and regions.',
        inputSchema: {
            type: 'object',
            properties: {
                region: {
                    type: 'string',
                    description: 'Specific AWS region to query (optional, defaults to all regions)'
                },
                profile: {
                    type: 'string',
                    description: 'AWS profile name for cross-account access (optional)'
                }
            },
            required: []
        }
    },
    {
        name: 'amplify_list_branches',
        description: 'List all branches for a specific Amplify application.',
        inputSchema: {
            type: 'object',
            properties: {
                appId: {
                    type: 'string',
                    description: 'The Amplify application ID (e.g., d1234567890)'
                },
                region: {
                    type: 'string',
                    description: 'AWS region where the app is located (optional)'
                },
                profile: {
                    type: 'string',
                    description: 'AWS profile name for cross-account access (optional)'
                }
            },
            required: ['appId']
        }
    },
    {
        name: 'amplify_list_jobs',
        description: 'List recent build/deploy jobs for a specific branch of an Amplify application.',
        inputSchema: {
            type: 'object',
            properties: {
                appId: {
                    type: 'string',
                    description: 'The Amplify application ID'
                },
                branch: {
                    type: 'string',
                    description: 'The branch name (e.g., main, master, develop)'
                },
                region: {
                    type: 'string',
                    description: 'AWS region where the app is located (optional)'
                },
                profile: {
                    type: 'string',
                    description: 'AWS profile name for cross-account access (optional)'
                }
            },
            required: ['appId', 'branch']
        }
    },
    {
        name: 'amplify_diagnose',
        description: 'Diagnose a failed Amplify build job. Downloads logs and analyzes them for common failure patterns like lock file mismatches, Node.js version conflicts, missing environment variables, package installation failures, and more. Returns detected issues with root causes and suggested fixes.',
        inputSchema: {
            type: 'object',
            properties: {
                appId: {
                    type: 'string',
                    description: 'The Amplify application ID'
                },
                branch: {
                    type: 'string',
                    description: 'The branch name'
                },
                jobId: {
                    type: 'string',
                    description: 'Specific job ID to diagnose (optional, defaults to latest failed job)'
                },
                region: {
                    type: 'string',
                    description: 'AWS region where the app is located (optional)'
                },
                profile: {
                    type: 'string',
                    description: 'AWS profile name for cross-account access (optional)'
                }
            },
            required: ['appId', 'branch']
        }
    },
    {
        name: 'amplify_get_latest_failed',
        description: 'Get the most recent failed job for a branch. Useful to quickly identify if there are any build failures.',
        inputSchema: {
            type: 'object',
            properties: {
                appId: {
                    type: 'string',
                    description: 'The Amplify application ID'
                },
                branch: {
                    type: 'string',
                    description: 'The branch name'
                },
                region: {
                    type: 'string',
                    description: 'AWS region where the app is located (optional)'
                },
                profile: {
                    type: 'string',
                    description: 'AWS profile name for cross-account access (optional)'
                }
            },
            required: ['appId', 'branch']
        }
    },
    {
        name: 'amplify_get_env_vars',
        description: 'Get all environment variables for an Amplify branch. Returns variable names and values.',
        inputSchema: {
            type: 'object',
            properties: {
                appId: {
                    type: 'string',
                    description: 'The Amplify application ID'
                },
                branch: {
                    type: 'string',
                    description: 'The branch name'
                },
                region: {
                    type: 'string',
                    description: 'AWS region where the app is located (optional)'
                },
                profile: {
                    type: 'string',
                    description: 'AWS profile name for cross-account access (optional)'
                }
            },
            required: ['appId', 'branch']
        }
    },
    {
        name: 'amplify_set_env_var',
        description: 'Set or update an environment variable for an Amplify branch.',
        inputSchema: {
            type: 'object',
            properties: {
                appId: {
                    type: 'string',
                    description: 'The Amplify application ID'
                },
                branch: {
                    type: 'string',
                    description: 'The branch name'
                },
                name: {
                    type: 'string',
                    description: 'The environment variable name'
                },
                value: {
                    type: 'string',
                    description: 'The environment variable value'
                },
                region: {
                    type: 'string',
                    description: 'AWS region where the app is located (optional)'
                },
                profile: {
                    type: 'string',
                    description: 'AWS profile name for cross-account access (optional)'
                }
            },
            required: ['appId', 'branch', 'name', 'value']
        }
    },
    {
        name: 'amplify_delete_env_var',
        description: 'Delete an environment variable from an Amplify branch.',
        inputSchema: {
            type: 'object',
            properties: {
                appId: {
                    type: 'string',
                    description: 'The Amplify application ID'
                },
                branch: {
                    type: 'string',
                    description: 'The branch name'
                },
                name: {
                    type: 'string',
                    description: 'The environment variable name to delete'
                },
                region: {
                    type: 'string',
                    description: 'AWS region where the app is located (optional)'
                },
                profile: {
                    type: 'string',
                    description: 'AWS profile name for cross-account access (optional)'
                }
            },
            required: ['appId', 'branch', 'name']
        }
    },
    {
        name: 'amplify_start_build',
        description: 'Start a new build/deploy job for an Amplify branch.',
        inputSchema: {
            type: 'object',
            properties: {
                appId: {
                    type: 'string',
                    description: 'The Amplify application ID'
                },
                branch: {
                    type: 'string',
                    description: 'The branch name'
                },
                region: {
                    type: 'string',
                    description: 'AWS region where the app is located (optional)'
                },
                profile: {
                    type: 'string',
                    description: 'AWS profile name for cross-account access (optional)'
                }
            },
            required: ['appId', 'branch']
        }
    },
    {
        name: 'amplify_stop_build',
        description: 'Stop a running build/deploy job for an Amplify branch.',
        inputSchema: {
            type: 'object',
            properties: {
                appId: {
                    type: 'string',
                    description: 'The Amplify application ID'
                },
                branch: {
                    type: 'string',
                    description: 'The branch name'
                },
                jobId: {
                    type: 'string',
                    description: 'The job ID to stop'
                },
                region: {
                    type: 'string',
                    description: 'AWS region where the app is located (optional)'
                },
                profile: {
                    type: 'string',
                    description: 'AWS profile name for cross-account access (optional)'
                }
            },
            required: ['appId', 'branch', 'jobId']
        }
    },
    {
        name: 'amplify_migration_analysis',
        description: 'Analyze an Amplify Gen1 project for migration readiness to Gen2. Returns detailed information about feature compatibility, blocking issues, and migration hints.',
        inputSchema: {
            type: 'object',
            properties: {
                projectPath: {
                    type: 'string',
                    description: 'The absolute path to the project directory containing the amplify/ folder'
                }
            },
            required: ['projectPath']
        }
    },
    {
        name: 'amplify_monitor_build',
        description: 'Monitor a build and get real-time status with automatic failure diagnosis. Use this after a git push to track build progress and get immediate failure analysis.',
        inputSchema: {
            type: 'object',
            properties: {
                appId: {
                    type: 'string',
                    description: 'The Amplify application ID'
                },
                branch: {
                    type: 'string',
                    description: 'The branch name to monitor'
                },
                jobId: {
                    type: 'string',
                    description: 'Specific job ID to monitor (optional, defaults to latest)'
                },
                waitForCompletion: {
                    type: 'boolean',
                    description: 'Wait for build to complete and return final status with diagnosis (default: true)'
                },
                timeoutSeconds: {
                    type: 'number',
                    description: 'Maximum time to wait for build completion in seconds (default: 1800 = 30 min)'
                },
                region: {
                    type: 'string',
                    description: 'AWS region where the app is located (optional)'
                },
                profile: {
                    type: 'string',
                    description: 'AWS profile name for cross-account access (optional)'
                }
            },
            required: ['appId', 'branch']
        }
    },
    {
        name: 'amplify_get_build_logs',
        description: 'Fetch and analyze build/deploy logs for a specific job. Returns log content with error analysis.',
        inputSchema: {
            type: 'object',
            properties: {
                appId: {
                    type: 'string',
                    description: 'The Amplify application ID'
                },
                branch: {
                    type: 'string',
                    description: 'The branch name'
                },
                jobId: {
                    type: 'string',
                    description: 'The job ID (optional, defaults to latest failed job)'
                },
                logType: {
                    type: 'string',
                    enum: ['build', 'deploy', 'both'],
                    description: 'Type of logs to fetch (default: both)'
                },
                region: {
                    type: 'string',
                    description: 'AWS region where the app is located (optional)'
                },
                profile: {
                    type: 'string',
                    description: 'AWS profile name for cross-account access (optional)'
                }
            },
            required: ['appId', 'branch']
        }
    }
];

// Create the MCP server
const server = new Server(
    {
        name: 'amplify-monitor',
        version: '0.1.0',
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        switch (name) {
            case 'amplify_list_apps': {
                const validated = ListAppsSchema.parse(args);
                const apps = await cli.listApps(!validated.region, validated.region, validated.profile);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(apps, null, 2)
                        }
                    ]
                };
            }

            case 'amplify_list_branches': {
                const validated = ListBranchesSchema.parse(args);
                const branches = await cli.listBranches(validated.appId, validated.region, validated.profile);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(branches, null, 2)
                        }
                    ]
                };
            }

            case 'amplify_list_jobs': {
                const validated = ListJobsSchema.parse(args);
                const jobs = await cli.listJobs(validated.appId, validated.branch, validated.region, validated.profile);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(jobs, null, 2)
                        }
                    ]
                };
            }

            case 'amplify_diagnose': {
                const validated = DiagnoseSchema.parse(args);
                const diagnosis = await cli.diagnose(validated.appId, validated.branch, validated.jobId, validated.region, validated.profile);
                
                // Format the diagnosis for better readability
                let formattedOutput = `## Diagnosis for ${validated.appId} / ${validated.branch}\n\n`;
                formattedOutput += `**Job ID:** ${diagnosis.jobId}\n`;
                formattedOutput += `**Status:** ${diagnosis.status}\n\n`;
                
                if (diagnosis.issues.length === 0) {
                    formattedOutput += '✅ No common failure patterns detected.\n';
                } else {
                    formattedOutput += `### Detected Issues (${diagnosis.issues.length})\n\n`;
                    diagnosis.issues.forEach((issue, index) => {
                        formattedOutput += `#### ${index + 1}. ${issue.pattern}\n`;
                        formattedOutput += `**Root Cause:** ${issue.rootCause}\n\n`;
                        formattedOutput += `**Suggested Fixes:**\n`;
                        issue.suggestedFixes.forEach((fix, i) => {
                            formattedOutput += `${i + 1}. ${fix}\n`;
                        });
                        formattedOutput += '\n';
                    });
                }
                
                return {
                    content: [
                        {
                            type: 'text',
                            text: formattedOutput
                        }
                    ]
                };
            }

            case 'amplify_get_latest_failed': {
                const validated = LatestFailedSchema.parse(args);
                const job = await cli.getLatestFailedJob(validated.appId, validated.branch, validated.region, validated.profile);
                
                if (!job) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `✅ No failed jobs found for ${validated.appId} / ${validated.branch}`
                            }
                        ]
                    };
                }
                
                return {
                    content: [
                        {
                            type: 'text',
                            text: `❌ Latest failed job:\n${JSON.stringify(job, null, 2)}`
                        }
                    ]
                };
            }

            case 'amplify_get_env_vars': {
                const validated = EnvVarsSchema.parse(args);
                const envVars = await cli.getEnvVariables(validated.appId, validated.branch, validated.region, validated.profile);
                
                if (envVars.length === 0) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `No environment variables found for ${validated.appId} / ${validated.branch}`
                            }
                        ]
                    };
                }
                
                let output = `## Environment Variables for ${validated.appId} / ${validated.branch}\n\n`;
                envVars.forEach(v => {
                    const masked = v.value.length > 4 ? v.value.substring(0, 4) + '****' : '****';
                    output += `- **${v.name}**: ${masked}\n`;
                });
                
                return {
                    content: [
                        {
                            type: 'text',
                            text: output
                        }
                    ]
                };
            }

            case 'amplify_set_env_var': {
                const validated = SetEnvVarSchema.parse(args);
                await cli.setEnvVariable(validated.appId, validated.branch, validated.name, validated.value, validated.region, validated.profile);
                
                return {
                    content: [
                        {
                            type: 'text',
                            text: `✅ Environment variable "${validated.name}" has been set for ${validated.appId} / ${validated.branch}`
                        }
                    ]
                };
            }

            case 'amplify_delete_env_var': {
                const validated = DeleteEnvVarSchema.parse(args);
                await cli.deleteEnvVariable(validated.appId, validated.branch, validated.name, validated.region, validated.profile);
                
                return {
                    content: [
                        {
                            type: 'text',
                            text: `✅ Environment variable "${validated.name}" has been deleted from ${validated.appId} / ${validated.branch}`
                        }
                    ]
                };
            }

            case 'amplify_start_build': {
                const validated = StartBuildSchema.parse(args);
                const result = await cli.startBuild(validated.appId, validated.branch, validated.region, validated.profile);
                
                return {
                    content: [
                        {
                            type: 'text',
                            text: `🚀 Build started!\n\n**Job ID:** ${result.jobId}\n**Status:** ${result.status}`
                        }
                    ]
                };
            }

            case 'amplify_stop_build': {
                const validated = StopBuildSchema.parse(args);
                const result = await cli.stopBuild(validated.appId, validated.branch, validated.jobId, validated.region, validated.profile);
                
                return {
                    content: [
                        {
                            type: 'text',
                            text: `🛑 Build stopped!\n\n**Job ID:** ${result.jobId}\n**Status:** ${result.status}`
                        }
                    ]
                };
            }

            case 'amplify_migration_analysis': {
                const validated = MigrationAnalysisSchema.parse(args);
                const analysis = await cli.analyzeMigration(validated.projectPath);
                
                let output = `## Amplify Gen1 → Gen2 Migration Analysis\n\n`;
                output += `**Project:** ${analysis.projectPath}\n`;
                output += `**Generation:** ${analysis.generation}\n\n`;
                
                if (analysis.generation === 'Gen2') {
                    output += '✅ This project is already using Amplify Gen2!\n';
                } else if (analysis.generation === 'Unknown') {
                    output += '⚠️ Could not detect an Amplify project in this directory.\n';
                } else {
                    // Gen1 project
                    output += `### Summary\n\n`;
                    output += `| Metric | Count |\n|--------|-------|\n`;
                    output += `| Total Features | ${analysis.summary.totalFeatures} |\n`;
                    output += `| ✅ Fully Supported | ${analysis.summary.fullySupported} |\n`;
                    output += `| 🔧 Supported with CDK | ${analysis.summary.supportedWithCdk} |\n`;
                    output += `| ❌ Not Supported | ${analysis.summary.notSupported} |\n`;
                    output += `| ⚠️ Manual Migration | ${analysis.summary.manualMigration} |\n\n`;
                    
                    if (analysis.readyForMigration) {
                        output += '### ✅ Ready for Migration\n\nYour project can be migrated to Gen2.\n\n';
                    } else {
                        output += '### ❌ Blocking Issues\n\n';
                        analysis.blockingIssues.forEach(issue => {
                            output += `- ${issue}\n`;
                        });
                        output += '\n';
                    }
                    
                    if (analysis.warnings.length > 0) {
                        output += '### ⚠️ Warnings\n\n';
                        analysis.warnings.forEach(warning => {
                            output += `- ${warning}\n`;
                        });
                        output += '\n';
                    }
                    
                    output += `### Detected Categories\n\n`;
                    analysis.categoriesDetected.forEach(cat => {
                        output += `- ${cat}\n`;
                    });
                    output += '\n';
                    
                    output += `**Documentation:** https://docs.amplify.aws/react/start/migrate-to-gen2/\n`;
                }
                
                return {
                    content: [
                        {
                            type: 'text',
                            text: output
                        }
                    ]
                };
            }

            case 'amplify_monitor_build': {
                const validated = MonitorBuildSchema.parse(args);
                
                // Get current job status
                const jobs = await cli.listJobs(validated.appId, validated.branch, validated.region, validated.profile);
                
                if (jobs.length === 0) {
                    return {
                        content: [{
                            type: 'text',
                            text: '⚠️ No builds found for this branch. Push code to trigger a build.'
                        }]
                    };
                }

                let targetJob = validated.jobId 
                    ? jobs.find(j => j.jobId === validated.jobId) 
                    : jobs[0];

                if (!targetJob) {
                    return {
                        content: [{
                            type: 'text',
                            text: `❌ Job ${validated.jobId} not found`
                        }]
                    };
                }

                // If not waiting for completion, return current status
                if (!validated.waitForCompletion) {
                    return {
                        content: [{
                            type: 'text',
                            text: `## Build Status\n\n**Job:** #${targetJob.jobId}\n**Branch:** ${targetJob.branch}\n**Status:** ${targetJob.status}\n**Started:** ${targetJob.startTime || 'N/A'}`
                        }]
                    };
                }

                // Poll until completion or timeout
                const startTime = Date.now();
                const timeout = (validated.timeoutSeconds || 1800) * 1000;
                const pollInterval = 10000; // 10 seconds

                while (targetJob.status === 'PENDING' || targetJob.status === 'RUNNING') {
                    if (Date.now() - startTime > timeout) {
                        return {
                            content: [{
                                type: 'text',
                                text: `⏱️ Timeout waiting for build completion.\n\n**Current Status:** ${targetJob.status}\n**Job:** #${targetJob.jobId}`
                            }]
                        };
                    }

                    // Wait before polling again
                    await new Promise(resolve => setTimeout(resolve, pollInterval));

                    // Refresh job status
                    const refreshedJobs = await cli.listJobs(validated.appId, validated.branch, validated.region, validated.profile);
                    targetJob = refreshedJobs.find(j => j.jobId === targetJob!.jobId) || targetJob;
                }

                // Build completed - get diagnosis if failed
                let output = `## Build ${targetJob.status === 'SUCCEED' ? 'Succeeded ✅' : 'Failed ❌'}\n\n`;
                output += `**Job:** #${targetJob.jobId}\n`;
                output += `**Branch:** ${targetJob.branch}\n`;
                output += `**Status:** ${targetJob.status}\n`;
                output += `**Started:** ${targetJob.startTime || 'N/A'}\n`;
                output += `**Ended:** ${targetJob.endTime || 'N/A'}\n`;

                if (targetJob.status === 'FAILED') {
                    // Auto-diagnose the failure
                    try {
                        const diagnosis = await cli.diagnose(validated.appId, validated.branch, targetJob.jobId, validated.region, validated.profile);
                        
                        if (diagnosis.issues && diagnosis.issues.length > 0) {
                            output += `\n### Issues Detected (${diagnosis.issues.length})\n\n`;
                            
                            for (const issue of diagnosis.issues) {
                                output += `#### ⚠️ ${issue.pattern}\n`;
                                output += `**Root Cause:** ${issue.rootCause}\n\n`;
                                output += `**Suggested Fixes:**\n`;
                                issue.suggestedFixes.forEach(fix => {
                                    output += `- ${fix}\n`;
                                });
                                output += '\n';
                            }
                        } else {
                            output += `\n### No specific issues detected\nCheck the build logs for more details.\n`;
                        }
                    } catch {
                        output += `\n⚠️ Could not auto-diagnose failure. Check build logs manually.\n`;
                    }
                }

                const elapsedMs = Date.now() - startTime;
                output += `\n---\n*Monitored for ${Math.round(elapsedMs / 1000)} seconds*`;

                return {
                    content: [{
                        type: 'text',
                        text: output
                    }]
                };
            }

            case 'amplify_get_build_logs': {
                const validated = GetBuildLogsSchema.parse(args);
                
                // Get jobs to find the target
                const jobs = await cli.listJobs(validated.appId, validated.branch, validated.region, validated.profile);
                
                let targetJobId = validated.jobId;
                
                if (!targetJobId) {
                    // Find latest failed job
                    const failedJob = jobs.find(j => j.status === 'FAILED');
                    if (failedJob) {
                        targetJobId = failedJob.jobId;
                    } else if (jobs.length > 0) {
                        targetJobId = jobs[0].jobId;
                    }
                }

                if (!targetJobId) {
                    return {
                        content: [{
                            type: 'text',
                            text: '⚠️ No jobs found to get logs from.'
                        }]
                    };
                }

                // Get diagnosis which includes log analysis
                const diagnosis = await cli.diagnose(validated.appId, validated.branch, targetJobId, validated.region, validated.profile);
                
                let output = `## Build Logs Analysis\n\n`;
                output += `**App:** ${diagnosis.appId}\n`;
                output += `**Branch:** ${diagnosis.branch}\n`;
                output += `**Job:** #${diagnosis.jobId}\n`;
                output += `**Status:** ${diagnosis.status}\n\n`;

                if (diagnosis.issues && diagnosis.issues.length > 0) {
                    output += `### Detected Issues (${diagnosis.issues.length})\n\n`;
                    
                    for (const issue of diagnosis.issues) {
                        output += `#### ${issue.pattern}\n`;
                        output += `- **Root Cause:** ${issue.rootCause}\n`;
                        output += `- **Fixes:**\n`;
                        issue.suggestedFixes.forEach(fix => {
                            output += `  - ${fix}\n`;
                        });
                        output += '\n';
                    }
                } else {
                    output += `### ✅ No issues detected in logs\n`;
                    output += `The build completed with status: ${diagnosis.status}\n`;
                }

                return {
                    content: [{
                        type: 'text',
                        text: output
                    }]
                };
            }

            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return {
            content: [
                {
                    type: 'text',
                    text: `Error: ${errorMessage}`
                }
            ],
            isError: true
        };
    }
});

// Start the server
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Amplify Monitor MCP server running on stdio');
}

main().catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
});
