# Amplify Monitor MCP Server

Model Context Protocol (MCP) server for AWS Amplify build monitoring and diagnosis. This allows AI assistants like Claude to directly interact with your Amplify applications.

## Features

- **List Apps**: Discover all Amplify apps across AWS regions
- **List Branches**: Get branches for any app
- **List Jobs**: View recent build/deploy jobs
- **Diagnose Failures**: Analyze failed builds with AI-powered pattern detection
- **Cross-Account Support**: Use AWS profiles for different accounts

## Prerequisites

1. **amplify-monitor CLI** must be installed and in your PATH:
   ```bash
   # From GitHub releases or build from source
   cargo install --git https://github.com/saga95/amplify-monitor
   ```

2. **AWS credentials** configured via environment or AWS CLI profiles

## Installation

```bash
cd mcp-server
npm install
npm run build
```

## Usage with Claude Desktop

Add to your Claude Desktop configuration (`claude_desktop_config.json`):

### macOS
```json
{
  "mcpServers": {
    "amplify-monitor": {
      "command": "node",
      "args": ["/path/to/amplify-monitor/mcp-server/dist/index.js"],
      "env": {
        "AWS_REGION": "us-east-1"
      }
    }
  }
}
```

### Windows
```json
{
  "mcpServers": {
    "amplify-monitor": {
      "command": "node",
      "args": ["C:\\path\\to\\amplify-monitor\\mcp-server\\dist\\index.js"],
      "env": {
        "AWS_REGION": "us-east-1"
      }
    }
  }
}
```

## Available Tools

### `amplify_list_apps`
List all AWS Amplify applications.

**Parameters:**
- `region` (optional): Specific AWS region
- `profile` (optional): AWS profile name

**Example prompt:** "List all my Amplify apps"

---

### `amplify_list_branches`
List branches for an application.

**Parameters:**
- `appId` (required): Amplify app ID
- `region` (optional): AWS region
- `profile` (optional): AWS profile name

**Example prompt:** "Show me the branches for app d1234567890"

---

### `amplify_list_jobs`
List recent build/deploy jobs.

**Parameters:**
- `appId` (required): Amplify app ID
- `branch` (required): Branch name
- `region` (optional): AWS region
- `profile` (optional): AWS profile name

**Example prompt:** "What are the recent builds for the main branch of my friday.lk app?"

---

### `amplify_diagnose`
Diagnose a failed build with pattern detection.

**Parameters:**
- `appId` (required): Amplify app ID
- `branch` (required): Branch name
- `jobId` (optional): Specific job ID (defaults to latest failed)
- `region` (optional): AWS region
- `profile` (optional): AWS profile name

**Example prompt:** "Why did my latest Amplify build fail?"

---

### `amplify_get_latest_failed`
Get the most recent failed job.

**Parameters:**
- `appId` (required): Amplify app ID
- `branch` (required): Branch name
- `region` (optional): AWS region
- `profile` (optional): AWS profile name

**Example prompt:** "Is there a failed build on my main branch?"

## Environment Variables

| Variable | Description |
|----------|-------------|
| `AMPLIFY_MONITOR_CLI_PATH` | Custom path to amplify-monitor CLI |
| `AWS_REGION` | Default AWS region |
| `AWS_PROFILE` | Default AWS profile |

## Example Conversation with Claude

```
You: List my Amplify apps

Claude: [Uses amplify_list_apps tool]
I found 4 Amplify applications:
1. friday.lk (ap-south-1) - d1xxxxx
2. curalogic (us-west-2) - d2xxxxx
3. politica (us-west-2) - d3xxxxx
4. digital-product (us-east-2) - d4xxxxx

You: Why did the friday.lk main branch fail?

Claude: [Uses amplify_diagnose tool]
I analyzed the latest failed build and found 2 issues:

1. **Lock File Mismatch**
   Root Cause: Found both package-lock.json and pnpm-lock.yaml
   Fix: Remove one lock file and use consistent package manager

2. **Node.js Version Mismatch**  
   Root Cause: Build uses Node 16 but package requires Node 18+
   Fix: Update amplify.yml to specify Node 18
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run in development
npm run dev
```

## License

MIT
