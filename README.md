# amplify-monitor

A Rust CLI tool for monitoring AWS Amplify builds and diagnosing failures.

## Features

- 📋 List Amplify apps, branches, and jobs
- 🔍 Detect the latest failed build
- 📥 Download and analyze build/deploy logs
- 🩺 Diagnose **20+ common failure patterns**
- 📤 Output as JSON or human-readable text

## Installation

### From Source

```bash
# Clone the repository
git clone https://github.com/yourusername/amplify-monitor.git
cd amplify-monitor

# Build release binary
cargo build --release

# Binary is at ./target/release/amplify-monitor
```

### Prerequisites

- Rust 1.70+ (install via [rustup](https://rustup.rs))
- AWS credentials with Amplify read access

## Configuration

### Config File

Create a config file to set defaults and skip repetitive CLI arguments:

```bash
# Generate sample config
amplify-monitor init
```

This creates `~/.amplify-monitor.toml`:

```toml
# Default app ID (find with `amplify-monitor apps`)
default_app_id = "d1234567890"

# Default branch name
default_branch = "main"

# Default output format: json, json-pretty, or text
default_format = "text"

# AWS region (overrides AWS_REGION env var)
# aws_region = "us-east-1"
```

With config set, you can simply run:

```bash
amplify-monitor diagnose    # Uses defaults from config
```

### AWS Credentials

Set AWS credentials via environment variables:

```bash
# Linux/macOS
export AWS_ACCESS_KEY_ID="your-access-key"
export AWS_SECRET_ACCESS_KEY="your-secret-key"
export AWS_REGION="us-east-1"

# Windows PowerShell
$env:AWS_ACCESS_KEY_ID = "your-access-key"
$env:AWS_SECRET_ACCESS_KEY = "your-secret-key"
$env:AWS_REGION = "us-east-1"
```

### Required IAM Permissions

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "amplify:ListApps",
        "amplify:ListBranches",
        "amplify:ListJobs",
        "amplify:GetJob"
      ],
      "Resource": "*"
    }
  ]
}
```

## Usage

### List all apps

```bash
amplify-monitor apps
```

```json
[
  {
    "appId": "d1234567890",
    "name": "my-react-app",
    "repository": "https://github.com/user/my-react-app",
    "defaultDomain": "main.d1234567890.amplifyapp.com"
  }
]
```

### List branches

```bash
amplify-monitor branches --app-id d1234567890
```

### List jobs for a branch

```bash
amplify-monitor jobs --app-id d1234567890 --branch main
```

### Get latest failed job

```bash
amplify-monitor latest-failed --app-id d1234567890 --branch main
```

### Diagnose a failed build

```bash
# Diagnose the latest failed job
amplify-monitor diagnose --app-id d1234567890 --branch main

# Diagnose a specific job
amplify-monitor diagnose --app-id d1234567890 --branch main --job-id 123
```

Example output:

```json
{
  "appId": "d1234567890",
  "branch": "main",
  "jobId": "42",
  "status": "FAILED",
  "issues": [
    {
      "pattern": "npm_ci_failure",
      "rootCause": "npm ci failed - likely due to package-lock.json sync issues",
      "suggestedFixes": [
        "Run 'npm install' locally to regenerate package-lock.json",
        "Commit the updated package-lock.json",
        "Ensure package-lock.json is not in .gitignore"
      ]
    }
  ]
}
```

### Output Formats

```bash
# Compact JSON (default, best for piping)
amplify-monitor --format json apps

# Pretty JSON (human-readable)
amplify-monitor --format json-pretty apps

# Text output (human-readable)
amplify-monitor --format text diagnose --app-id d1234567890 --branch main
```

## Detected Failure Patterns

| Pattern | Description |
|---------|-------------|
| `lockfile_mismatch` | Conflicting lock files (npm/pnpm/yarn) |
| `package_manager_conflict` | Multiple package managers detected |
| `node_version_mismatch` | Node.js version incompatibility |
| `missing_env_vars` | Required environment variables not set |
| `npm_ci_failure` | npm ci command failed |
| `pnpm_install_failure` | pnpm install failed |
| `yarn_install_failure` | yarn install failed |
| `amplify_yml_error` | Invalid amplify.yml configuration |
| `out_of_memory` | JavaScript heap out of memory |
| `timeout` | Build exceeded time limit |
| `artifact_path_error` | Build output directory not found |
| `typescript_error` | TypeScript compilation failed |
| `eslint_error` | ESLint validation failed |
| `module_not_found` | Missing npm module |
| `permission_denied` | File system permission error |
| `network_error` | Network connectivity issue |
| `docker_error` | Docker/container build issue |
| `python_error` | Python dependency error |
| `nextjs_error` | Next.js build failure |
| `vite_error` | Vite/Rollup bundling failure |

## Examples

### Quick diagnosis workflow

```bash
# 1. Find your app ID
amplify-monitor apps --format text

# 2. Check recent jobs
amplify-monitor jobs --app-id d1234567890 --branch main --format text

# 3. Diagnose the failure
amplify-monitor diagnose --app-id d1234567890 --branch main --format text
```

### Pipe to jq

```bash
# Get just the issue patterns
amplify-monitor diagnose --app-id d1234567890 --branch main | jq '.issues[].pattern'

# Count issues
amplify-monitor diagnose --app-id d1234567890 --branch main | jq '.issues | length'
```

### Use in scripts

```bash
#!/bin/bash
RESULT=$(amplify-monitor diagnose --app-id $APP_ID --branch main)
ISSUES=$(echo $RESULT | jq '.issues | length')

if [ "$ISSUES" -gt 0 ]; then
  echo "Found $ISSUES issues in build"
  echo $RESULT | jq '.issues[].suggestedFixes[]'
fi
```

## Development

```bash
# Run tests
cargo test

# Run with debug logging
RUST_LOG=debug cargo run -- apps

# Check for issues
cargo clippy

# Format code
cargo fmt
```

## CI/CD

This project uses GitHub Actions for:

- **CI** ([.github/workflows/ci.yml](.github/workflows/ci.yml)): Tests on Linux, Windows, macOS
- **Release** ([.github/workflows/release.yml](.github/workflows/release.yml)): Build binaries on tag push

To create a release:

```bash
git tag v0.1.0
git push origin v0.1.0
```

## Roadmap

- [x] Config file support (`~/.amplify-monitor.toml`)
- [x] GitHub Actions CI
- [ ] `watch` command for polling build status
- [ ] VS Code extension
- [ ] MCP server for AI agent integration

## License

MIT
