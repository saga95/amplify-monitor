# Copilot Instructions – amplify-monitor

Rust CLI tool for monitoring AWS Amplify builds and diagnosing failures. This is the **core engine** for future VS Code extension and MCP server integrations.

## Architecture

- **Entry**: `main.rs` – CLI entry point with subcommands
- **Modules**: `amplify.rs` (AWS API), `logs.rs` (download/extract), `parser.rs` (error classification)
- **Output**: All commands produce structured JSON for downstream tool consumption

## Dependencies

```toml
clap = { version = "4", features = ["derive"] }
tokio = { version = "1", features = ["full"] }
aws-config = "1"
aws-sdk-amplify = "1"
reqwest = { version = "0.12", features = ["stream"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
anyhow = "1"
zip = "2"
```

## AWS Integration

```rust
// Authentication via environment variables only
// AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION
let config = aws_config::load_defaults(BehaviorVersion::latest()).await;
let client = aws_sdk_amplify::Client::new(&config);
```

## Rust Conventions

- Edition 2021, async with `tokio`
- Error handling: `anyhow::Result<T>` – no `unwrap()` or `expect()` in production
- Small, focused functions with clear names: `latest_failed_job()`, `download_job_logs()`
- Streaming downloads for large log files via `reqwest` streams
- Always fetch logs fresh (no local caching)

## Core Capabilities

1. List Amplify apps, branches, and jobs
2. Detect latest failed job for a branch
3. Download and extract BUILD/DEPLOY logs (ZIP format)
4. Parse logs for failure patterns → return **all matches** with root causes + suggested fixes

## Failure Patterns to Detect

Report **all** matching patterns found in logs:

- Lock file mismatches (`package-lock.json` vs `pnpm-lock.yaml`)
- Package manager conflicts (npm/pnpm/yarn)
- Node.js version mismatches
- Missing environment variables
- `npm ci` / `pnpm install` failures
- `amplify.yml` buildspec errors
- Out-of-memory / timeout failures

## Output Structure

```json
{
  "appId": "string",
  "branch": "main",
  "jobId": "string",
  "status": "FAILED",
  "issues": [
    { "pattern": "string", "rootCause": "string", "suggestedFixes": ["string"] }
  ]
}
```

## Non-Goals

- ❌ UI logic or frontend code
- ❌ Mutating Amplify state (no redeploys)
- ❌ Hardcoded credentials
- ❌ Browser/console automation
- ❌ Local log caching
