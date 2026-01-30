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
