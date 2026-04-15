# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.50] - 2026-04-15

### Added
- `--log-output-dir <dir>` flag on `diagnose` command — writes BUILD.txt and DEPLOY.txt directly to disk, returns file paths in JSON output. Avoids stdout buffer overflow for large build logs.
- `buildLogPath` and `deployLogPath` fields in diagnosis JSON output when `--log-output-dir` is used

## [0.1.49] - 2026-04-15

### Changed
- `DiagnosisResultWithLogs` now includes `build_log` and `deploy_log` as separate fields
- `LogsResult` now includes `build_log` and `deploy_log` as separate fields
- `Issue` struct in parser now includes `matched_lines: Vec<String>` with actual log lines that triggered each pattern
- All failure pattern checkers (macro and custom) populate `matched_lines` with contextual log excerpts
- Added `extract_matched_lines()` helper for efficient log line extraction with deduplication

## [0.1.0] - 2026-01-29

### Added

- Initial release
- `apps` command to list all Amplify apps
- `branches` command to list branches for an app
- `jobs` command to list jobs for a branch
- `latest-failed` command to get the most recent failed job
- `diagnose` command to analyze build logs and detect failure patterns
- `init` command to create config file
- Config file support (`~/.amplify-monitor.toml`)
- 20 failure pattern detectors:
  - Lock file mismatches
  - Package manager conflicts (npm/pnpm/yarn)
  - Node.js version issues
  - Missing environment variables
  - npm ci / pnpm / yarn install failures
  - TypeScript compilation errors
  - ESLint validation failures
  - Module not found errors
  - Permission denied errors
  - Network connectivity issues
  - Docker/container errors
  - Python dependency errors
  - Next.js build failures
  - Vite/Rollup bundling failures
  - Out-of-memory errors
  - Build timeouts
  - Artifact path errors
  - amplify.yml configuration errors
- Multiple output formats: JSON, JSON-pretty, text
- Cross-platform support (Linux, Windows, macOS)
