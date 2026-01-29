# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
