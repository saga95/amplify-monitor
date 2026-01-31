# Changelog

## [0.1.9] - 2026-01-30

### Added
- **Portfolio Dashboard**: New webview panel showing all apps, branches, and build statuses at a glance
  - Visual summary with total apps, branches, succeeded, failed, and running builds
  - Grid layout showing each app with all branches and their latest build status
  - Quick action buttons: Start Build, Stop Build, View Logs, Open Console
  - Real-time status icons and relative timestamps
  - Responsive design adapts to VS Code window size
- New command: `Amplify Monitor: Open Dashboard` (also available in Apps tree title)

### Improved
- Better visibility into multi-app deployments
- Batch operations capability from a single view

## [0.1.8] - 2026-01-30

### Added
- **Smart Auto-Detection**: Extension now automatically detects Amplify projects on startup
  - Scans workspace for `amplify/` folder
  - Auto-fetches apps from AWS when credentials are available
  - Shows connection status in status bar with app count
- **Connection Status Bar**: New status bar item showing AWS connection state
  - `$(cloud) Amplify: X apps` - Connected with app count
  - `$(cloud-offline) Amplify: Not Connected` - No credentials or connection error
  - Click to refresh app list
- **Smart Credential Prompts**: If Amplify project detected but no AWS credentials:
  - Prompts to configure credentials
  - Option to run local migration analysis without AWS
- **Workspace Change Detection**: Re-detects when workspace folders change

### Improved
- Better "just works" experience - extension activates and shows relevant info automatically
- Contextual notifications based on project state

## [0.1.7] - 2026-01-30

### Added
- **Gen2 Migration Assistant**: Analyze your Amplify Gen1 project for migration readiness
  - Detects all Gen1 features and their Gen2 compatibility
  - Identifies blocking issues that prevent migration
  - Provides migration hints and documentation links
  - Shows summary with fully supported vs. requiring CDK vs. not supported features
- New commands:
  - `Analyze Gen1 → Gen2 Migration` - Run migration analysis on workspace
  - `Open Migration Documentation` - Link to official AWS migration docs
- New "Gen2 Migration" panel in the sidebar

### Supported Migration Patterns
- GraphQL directives: @model, @auth, @function, @http
- Blocking patterns: @searchable, @predictions, @manyToMany, DataStore
- Auth features: MFA, OAuth, triggers, admin queries
- Storage: S3 buckets, Lambda triggers
- Functions: Node.js, Python (CDK), Lambda layers detection
- Other categories: Geo, Analytics, Interactions (CDK required)

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
