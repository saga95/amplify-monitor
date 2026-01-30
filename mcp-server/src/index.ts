#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { AmplifyMonitorCli } from './cli.js';

// Initialize CLI wrapper
const cli = new AmplifyMonitorCli(process.env.AMPLIFY_MONITOR_CLI_PATH || 'amplify-monitor');

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
                const { region, profile } = args as { region?: string; profile?: string };
                const apps = await cli.listApps(!region, region, profile);
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
                const { appId, region, profile } = args as { appId: string; region?: string; profile?: string };
                const branches = await cli.listBranches(appId, region, profile);
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
                const { appId, branch, region, profile } = args as { appId: string; branch: string; region?: string; profile?: string };
                const jobs = await cli.listJobs(appId, branch, region, profile);
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
                const { appId, branch, jobId, region, profile } = args as { 
                    appId: string; 
                    branch: string; 
                    jobId?: string; 
                    region?: string; 
                    profile?: string 
                };
                const diagnosis = await cli.diagnose(appId, branch, jobId, region, profile);
                
                // Format the diagnosis for better readability
                let formattedOutput = `## Diagnosis for ${appId} / ${branch}\n\n`;
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
                const { appId, branch, region, profile } = args as { appId: string; branch: string; region?: string; profile?: string };
                const job = await cli.getLatestFailedJob(appId, branch, region, profile);
                
                if (!job) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `✅ No failed jobs found for ${appId} / ${branch}`
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
