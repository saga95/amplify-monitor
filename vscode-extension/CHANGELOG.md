# Changelog

## [0.1.6] - 2026-01-30

### Added
- **Environment Variables Manager**: New tree view to view, add, edit, and delete branch environment variables
- **Quick Actions**: Start and stop builds directly from VS Code
- **Open in AWS Console**: Quick link to open app in AWS Console
- **amplify.yml IntelliSense**: 
  - JSON schema validation for amplify.yml files
  - 14 code snippets for common configurations (Next.js, Vite, pnpm, monorepo, etc.)
  - Auto-completion for build phases, artifacts, and cache settings

### New Commands
- `Add Environment Variable` - Add new env var to selected branch
- `Edit Environment Variable` - Update existing env var value
- `Delete Environment Variable` - Remove env var (with confirmation)
- `Reveal Value` - Show masked env var value with copy option
- `Start Build` - Trigger a new deployment
- `Stop Build` - Cancel a running deployment
- `Open in AWS Console` - Open Amplify app in browser

### Improved
- Better tree view organization with Environment Variables section
- Context menu actions on env var items (reveal, edit, delete)
- Inline action buttons on job items for quick build control

## [0.1.5] - 2026-01-29

### Improved
- Code quality improvements from comprehensive audit
- Better error handling throughout the codebase
- Resolved all TypeScript warnings

## [0.1.3] - 2026-01-28

### Added
- **Cross-account support**: New `AWS Profile` setting for multi-account access
- **Switch AWS Profile** command for quick profile switching
- **Status bar indicator** showing current AWS profile (clickable to switch)
- Views auto-refresh when AWS profile changes

### Improved
- Better developer experience for consultants/developers working on client projects

## [0.1.2] - 2026-01-27

### Added
- Multi-region support: Apps from all AWS regions displayed automatically
- Region displayed next to app name in tree view

### Fixed
- CLI flag ordering issue causing extension errors

## [0.1.0] - 2026-01-25

### Added
- Initial release
- Apps tree view with app and branch browsing
- Jobs tree view with status indicators
- Diagnosis tree view with issue detection
- Commands: list apps, diagnose, select app/branch, refresh, settings
- Configuration options for CLI path, defaults, and auto-refresh
- Support for 20+ failure pattern detection
