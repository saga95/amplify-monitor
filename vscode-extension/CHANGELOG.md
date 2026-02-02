# Changelog

## [0.1.37] - 2026-02-02

### Added
- **Documentation Images** - Added dashboard screenshots and new logo
  - Main dashboard screenshot
  - Dashboard view screenshot
  - Multi-account apps panel screenshot
  - New extension logo

### Updated
- **README** - Updated What's New section, removed deprecated watcher documentation

## [0.1.36] - 2026-02-02

### Removed
- **Post-Push Build Watcher** - Removed the build watcher functionality
  - Redundant with webhook notifications feature
  - Removed `watchBuild`, `stopWatching`, `showWatchedBuilds`, `showBuildWatcherLogs` commands
  - Removed `autoWatchBuilds` and `buildPollInterval` settings
  - Cleaner extension with less background polling

## [0.1.35] - 2026-02-02

### Fixed
- **Jobs not loading when clicking branch** - Fixed "App not found" error when clicking on a branch in the Apps panel
  - Branch selection now properly passes appId, region, and profile to the selectBranch command
  - Jobs tree provider now uses the selectedProfile when fetching jobs
  - Fixed parameter order bug in performanceAlerts selectBranch call

## [0.1.34] - 2026-02-01

### Fixed
- **Default profile apps missing** - Apps from the default/configured AWS profile are now always included, even when multi-account mode is enabled
  - Multi-account mode now automatically includes the default profile alongside configured profiles
  - No need to manually add the default profile to the profiles list

- **Environment variables not loading** - Fixed "App not found" error when loading environment variables for cross-account apps
  - Added `selectedProfile` tracking to CLI
  - Environment variables panel now uses the correct profile for the selected app
  - All app selection commands now properly track and pass the profile

- **Profile context propagation** - Profile is now properly passed through all operations
  - Dashboard logs/actions use the correct profile
  - Branch listing uses the correct profile credentials

## [0.1.33] - 2026-02-01

### Fixed
- **Multi-Account Dashboard Branches** - Dashboard now properly loads branches and jobs for apps across different AWS profiles
  - Added profile parameter to `listBranches` and `listJobs` CLI methods
  - Dashboard passes profile when fetching branch and job data

### Improved
- **Apps Panel Multi-Account Support** - Sidebar Apps tree now displays apps from all configured AWS profiles
  - Shows profile badge next to each app when multi-account mode is enabled
  - Branches are fetched using the correct profile credentials

### Removed
- **Status Bar Items** - Removed AWS profile and app count status bar indicators
  - Multi-account mode is now the standard approach
  - Configure profiles in Settings → Amplify Monitor → Multi Account → Profiles

## [0.1.32] - 2026-02-01

### Fixed
- **Multi-Account Dashboard Support** - Dashboard now properly displays apps from all configured AWS profiles
  - Dashboard reads `multiAccount.enabled` and `multiAccount.profiles` settings
  - Apps are fetched in parallel from all configured profiles
  - Profile badges show which AWS profile each app belongs to
  - "Multi-Account" badge displayed in dashboard header when enabled
  - Summary bar shows profile count in multi-account mode
  - Improved error message when no apps found in configured profiles

## [0.1.31] - 2025-02-02

### Fixed
- **Duplicate build notifications** - Notifications no longer appear multiple times after clicking Cancel or interacting with the notification
  - Added deduplication tracking for build started, succeeded, failed, and cancelled notifications
  - Each notification (per job ID and status) will only appear once

## [0.1.30] - 2025-02-02

### Added
- **🔐 Multi-Account Support** - View Amplify apps across all AWS profiles
  - See apps from all configured AWS profiles in one unified panel
  - Switch between profiles with a single click
  - Real-time loading of apps from multiple accounts in parallel
  - Visual indicators for active profile and app counts
  - Error handling for invalid/expired credentials

- **⚙️ AWS Profile Configuration Wizard** - Manage AWS credentials without CLI
  - Create new AWS profiles with guided wizard
  - Edit existing profile credentials and regions
  - Delete profiles safely with confirmation
  - View all profiles with active indicator
  - Open credentials/config files directly in VS Code
  - Support for all major AWS regions
  - Automatic switching to newly created profiles

### Commands Added
- `Amplify Monitor: Toggle Multi-Account Mode` - Open multi-account panel
- `Amplify Monitor: Select Profiles for Multi-Account View` - Open multi-account panel
- `Amplify Monitor: Configure AWS Profile` - Open profile configuration wizard

### Settings Added
- `amplifyMonitor.multiAccount.enabled` - Enable multi-account mode
- `amplifyMonitor.multiAccount.profiles` - AWS profiles to show in multi-account mode

## [0.1.29] - 2025-02-02

### Added
- **🔧 Auto-Fix in Copilot Chat** - Automatic fix buttons in `@amplify` responses
  - Lock file mismatch → Delete conflicting lock files
  - Node.js version mismatch → Create `.nvmrc` file
  - ESLint errors → Add `CI=false` to build settings
  - Missing `amplify.yml` → Generate starter buildspec

- **💰 Build Cost Estimator** - Real-time AWS cost analysis
  - View estimated build costs based on AWS Amplify pricing
  - Calculate costs by time period (7/30/90 days)
  - Free tier tracking and remaining minutes
  - Monthly cost projections
  - Export cost reports to CSV

- **📋 Build Queue Visualization** - Monitor all pending/running builds
  - Real-time view of running and pending builds across all apps
  - Auto-refresh every 15 seconds
  - One-click stop build functionality
  - Direct links to AWS Console
  - Animated progress indicators

- **↩️ Rollback Helper** - Quick deployment rollback
  - View deployment history per branch
  - One-click redeploy to previous successful versions
  - Side-by-side comparison of deployments
  - Visual job status timeline

- **🔀 PR Preview Environments Manager** - Manage preview branches
  - Automatically detects PR/feature branches
  - Categorizes as Active, Failed, or Stale (30+ days)
  - Quick actions: Open preview, View console, Rebuild, Diagnose
  - Delete stale preview environments

- **📊 Performance Regression Alerts** - Proactive monitoring
  - Duration spike detection (50%+ increase)
  - Consecutive failure alerts
  - Slow build warnings (10+ minutes)
  - Flaky build detection (high failure rate)
  - Build time trend analysis with sparkline charts

- **🔔 Webhook Notifications** - Slack/Teams/Discord integration
  - Configure webhooks for build notifications
  - Support for Slack, Microsoft Teams, Discord, and custom webhooks
  - Rich message formatting with build details
  - Optional log excerpts and @mentions on failure
  - Test webhook functionality

### Commands Added
- `Amplify Monitor: Build Cost Estimator` - Open cost analysis panel
- `Amplify Monitor: Build Queue` - View pending/running builds
- `Amplify Monitor: Rollback Helper` - Access deployment rollback
- `Amplify Monitor: PR Preview Environments` - Manage previews
- `Amplify Monitor: Performance Alerts` - View performance issues
- `Amplify Monitor: Configure Webhook Notifications` - Setup webhooks
- `Amplify Monitor: Test Webhook` - Send test notification
- `Amplify Monitor: Show Webhook Logs` - View webhook activity

### Settings Added
- `amplifyMonitor.webhook.enabled` - Enable webhook notifications
- `amplifyMonitor.webhook.url` - Webhook endpoint URL
- `amplifyMonitor.webhook.type` - Webhook type (slack/teams/discord/custom)
- `amplifyMonitor.webhook.events.*` - Event toggles
- `amplifyMonitor.webhook.includeLogExcerpt` - Include log snippets
- `amplifyMonitor.webhook.mentionOnFailure` - @channel on failures

## [0.1.26] - 2025-02-01

### Added
- **🤖 Copilot Chat Integration** - Talk to `@amplify` in GitHub Copilot Chat to analyze and fix build failures
  - **@amplify diagnose** - Analyze the latest failed build with full context
  - **@amplify logs** - View complete build logs in chat
  - **@amplify fix** - Get detailed fix suggestions with code samples
  - **@amplify status** - Check status of all your Amplify apps
  - **Smart Error Extraction** - Automatically identifies relevant log sections
  - **Follow-up Suggestions** - Contextual next steps after each response
  - **Full Log Access** - Copilot can read entire build logs to understand failures

### CLI Updates
- `amplify-monitor logs --app-id X --branch Y --job-id Z` - Fetch raw build logs
- `amplify-monitor diagnose --include-logs` - Include raw logs in diagnosis output

### How to Use
1. Open GitHub Copilot Chat (Ctrl+Alt+I)
2. Type `@amplify diagnose` to analyze a failed build
3. Ask follow-up questions like "fix this" or "what changes should I make?"
4. Copilot will suggest code changes based on the actual build logs

## [0.1.25] - 2025-02-01

### Added
- **Diagnosis Sharing & Export** - Share and export job diagnoses for team collaboration
  - **Share Options QuickPick** - One-click menu to choose share format
  - **Markdown Export** - Copy diagnosis as formatted Markdown for Slack, Teams, or GitHub
  - **GitHub Issue Template** - Auto-generated issue with checkboxes for fixes
  - **Plain Text** - Simple format for email or basic text sharing
  - **Short Summary** - One-line summary with AWS Console link for quick chat messages
  - **Console Link** - Copy direct AWS Console URL to the specific job
  - **File Export** - Save diagnosis as JSON or Markdown file for documentation
  - **Reference ID** - Unique identifier format: `amplify://appId/branch/jobId`

### Commands Added
- `Amplify Monitor: Share Diagnosis...` - Open share options menu
- `Amplify Monitor: Copy Diagnosis as Markdown` - Copy as Markdown
- `Amplify Monitor: Copy as GitHub Issue` - Copy as GitHub issue template
- `Amplify Monitor: Copy Diagnosis as Text` - Copy as plain text
- `Amplify Monitor: Copy Short Summary` - Copy one-liner with link
- `Amplify Monitor: Copy AWS Console Link` - Copy direct link to AWS
- `Amplify Monitor: Export Diagnosis to File` - Save to file

## [0.1.24] - 2025-02-01

### Added
- **Gen1 → Gen2 Migration Helper** - Complete wizard for migrating Amplify projects to Gen2
  - **Project Analysis** - Scans Gen1 project structure and shows detailed compatibility report
  - **5-Step Wizard** - Guided migration process: Analyze → Review → Initialize → Migrate → Verify
  - **Code Generation** - Auto-generates Gen2 TypeScript code for each category:
    - Auth (Cognito) - `defineAuth()` configuration
    - API (GraphQL/REST) - `defineData()` with schema
    - Storage (S3) - `defineStorage()` with access rules
    - Functions (Lambda) - `defineFunction()` with handlers
  - **Feature Mapping** - Shows which Gen1 features map to Gen2 and their compatibility
  - **CDK Indicators** - Identifies features requiring AWS CDK for migration
  - **Blocking Issues** - Highlights features that may block migration
  - **Documentation Links** - Quick access to official Amplify migration guides
  - **Terminal Integration** - Run `npm create amplify@latest` directly from wizard

### Commands Added
- `Amplify Monitor: Gen1 → Gen2 Migration Helper` - Opens the migration wizard

## [0.1.23] - 2025-02-01

### Added
- **Post-Push Build Watcher** - Automatic build monitoring after git push
  - **Auto-Detection** - Detects git push and starts watching builds automatically
  - **Real-Time Status Bar** - Shows spinning indicator with build count while watching
  - **Smart Notifications** - Immediate alerts when builds succeed (✅) or fail (❌)
  - **Auto-Diagnosis** - Failed builds are automatically analyzed for root cause
  - **Quick Actions** - View diagnosis, logs, or open in AWS Console from notification
  - **Manual Watch** - Start/stop watching any branch with commands
  - **Configurable Settings** - Poll interval, auto-watch toggle, notification preferences

### MCP Server Updates
- **amplify_monitor_build** - Monitor build status with optional wait for completion
- **amplify_get_build_logs** - Fetch and analyze build logs with error detection

### Commands Added
- `Amplify Monitor: Watch Build After Push` - Start watching builds for current branch
- `Amplify Monitor: Stop Watching Builds` - Stop watching builds
- `Amplify Monitor: Show Watched Builds` - View all currently watched builds
- `Amplify Monitor: Show Build Watcher Logs` - View watcher debug output

### Configuration Added
- `amplifyMonitor.autoWatchBuilds` - Enable/disable automatic watching (default: true)
- `amplifyMonitor.buildPollInterval` - Polling interval in seconds (default: 10)
- `amplifyMonitor.showBuildNotifications` - Enable/disable notifications (default: true)
- `amplifyMonitor.autoDiagnoseFailures` - Auto-diagnose failures (default: true)

## [0.1.22] - 2025-02-01

### Added
- **Build Comparison** - Compare two builds to see what changed between them
  - **Side-by-Side Selection** - Pick two builds from the last 20 builds
  - **Status Comparison** - See if builds went from success to failure
  - **Duration Analysis** - Track build time changes with delta indicators
  - **Error Diff** - See new errors added and errors that were fixed
  - **Build Phase Timing** - Compare how long each phase took (Provisioning, Build, Deploy)
  - **Commit History** - See which commits are between the two builds
  - **Visual Diff Indicators** - Color-coded added/removed/changed items
  - **Summary Bar** - Quick count of changes at a glance

### Commands Added
- `Amplify Monitor: Compare Builds` - Opens the Build Comparison panel

## [0.1.21] - 2025-02-01

### Added
- **Custom Failure Patterns** - Define your own error detection patterns for build logs
  - **Pattern Editor** - Create patterns with regex or plain text matching
  - **Real-Time Testing** - Test patterns against sample log output before saving
  - **Presets Library** - 10+ pre-built patterns for common errors:
    - ESLint errors
    - TypeScript compilation errors
    - Webpack module resolution failures
    - NPM peer dependency conflicts
    - JavaScript heap out of memory
    - Next.js build optimization failures
    - Amplify build timeout
    - Undefined environment variables
    - Node.js deprecation warnings
    - Vite build errors
  - **Import/Export** - Share patterns with your team as JSON files
  - **Category Labels** - Categorize patterns as error, warning, or info
  - **Toggle On/Off** - Enable/disable patterns without deleting
  - **Rich Metadata** - Add root cause descriptions and suggested fixes
  - **Duplicate Patterns** - Copy existing patterns as starting point

### Commands Added
- `Amplify Monitor: Manage Custom Failure Patterns` - Opens the Custom Patterns panel

## [0.1.20] - 2025-02-01

### Added
- **Multi-Account AWS Profile Manager** - Seamlessly work across multiple AWS accounts
  - **Profile Discovery** - Auto-discovers all profiles from ~/.aws/credentials and ~/.aws/config
  - **Quick Switch** - Change active profile with one click from status bar or Profile Manager panel
  - **Credential Validation** - Test credentials for each profile, see account ID and user/role
  - **Visual Status** - Active profile clearly marked with orange badge, others show validation status
  - **Add New Profiles** - Create new AWS profiles directly in VS Code
  - **Edit Config Files** - Quick access to credentials and config files for manual editing
  - **SSO Support** - Full support for AWS SSO profiles and assumed roles
  - **Region Per Profile** - Each profile shows its configured default region
  - **AWS Console Integration** - One-click launch to AWS Console with correct region
  - **Status Bar Indicator** - Current profile always visible, click to quick-switch

### Commands Added
- `Amplify Monitor: Manage AWS Profiles` - Opens the full Profile Manager panel
- `Amplify Monitor: Switch AWS Profile` - Quick pick to switch between profiles

### Improved
- Status bar now shows current AWS profile and is clickable to switch
- All Amplify operations respect the selected profile
- Profile changes automatically refresh all views

## [0.1.19] - 2025-01-31

### Added
- **Custom Domain Validator** - Validate DNS, SSL, and Amplify configuration for custom domains
  - DNS record validation (CNAME, A, TXT records)
  - SSL certificate verification
  - CDN/CloudFront detection
  - Propagation status checking

## [0.1.15] - 2026-01-31

### Fixed
- **Critical: Dashboard Logs button** - Fixed `[object Object]` error when clicking "Logs" button in Amplify Dashboard
  - The command was incorrectly passing an object instead of individual parameters
  - Now properly passes appId, branch, and jobId to the diagnosis command
  
- **Parameter Validation** - Added validation for all CLI parameters
  - Catches object-instead-of-string errors early with clear messages
  - Prevents invalid API calls that would fail with cryptic AWS errors

### Improved
- **Error Messages** - More user-friendly error messages for common failures:
  - AWS `NotFoundException` → "App not found: [id]. Please check the App ID in your Amplify Console."
  - AWS `ValidationException` → Clear guidance about parameter types
  - AWS `AccessDeniedException` → "Please check your credentials and permissions"
  - Expired credentials → "AWS credentials have expired. Please refresh."
  - CLI version mismatch → "Please update the amplify-monitor CLI to the latest version"

- **Backwards Compatibility** - `diagnoseJob` command now accepts both:
  - Positional arguments: `(appId, branch, jobId)`  
  - Object argument: `{ appId, branch, jobId }` (for flexibility)

## [0.1.14] - 2026-01-31

### Added
- **Pre-Deploy Validation** - Prevent failed builds by validating before deploying

## [0.1.12] - 2026-01-31

### Added
- **Bundle Size Analyzer**: Visualize what's taking space in your build output
  - Auto-detects build directories (.next, dist, build, out)
  - Shows total size vs Amplify's 230MB limit with progress bar
  - Lists largest directories and files with size breakdown
  - Smart recommendations for reducing bundle size:
    - Source map detection and removal suggestions
    - Image optimization recommendations
    - node_modules bloat detection
    - Large file code-splitting suggestions
- **Build Performance Tracker**: Track build times and identify regressions
  - Records build duration, status, and branch
  - Shows success rate, average/min/max duration
  - Visual trend chart for recent builds
  - Per-branch statistics
  - Detects improving/degrading/stable trends
- **Monorepo Detector**: Automatic detection of monorepo structure
  - Supports TurboRepo, Nx, Lerna, pnpm/yarn/npm workspaces
  - Detects package manager and lock files
  - Lists all workspaces with framework detection
  - Generates optimized amplify.yml suggestions
  - One-click copy or create amplify.yml file
  - Recommendations for common monorepo issues

### New Commands
- `Analyze Bundle Size` - Open bundle analyzer panel
- `Show Build Performance` - View build performance history
- `Detect Monorepo Structure` - Analyze project structure

## [0.1.11] - 2026-01-31

### Added
- **Expanded Quick Fixes**: Now covering 20 issue patterns with 50+ one-click fixes
  - **TypeScript errors**: Open tsconfig, skip lib check, run tsc check
  - **ESLint errors**: Disable CI warnings, run auto-fix, open config
  - **Module not found**: Install deps, clean install, open package.json
  - **Next.js errors**: Set artifacts, open config, create env template
  - **Vite errors**: Set dist artifacts, open config, create env template
  - **Yarn failures**: Switch to npm, install yarn, delete lock file
  - **Timeout**: Enable caching, parallel builds
  - **Artifact path errors**: Multiple artifact directory options (dist/build/out/.next)
  - **Network errors**: Retry build, npm registry mirror
  - **Permission denied**: Use /tmp, fix npm permissions
  - **npm ci failure**: Regenerate lock file, use npm install
  - **Package manager conflict**: Standardize on npm, remove extra locks
  - **Lock file mismatch**: Full coverage for npm/pnpm/yarn switching

### Improved
- Updated README with comprehensive feature documentation
- Better architecture diagram showing extension components
- More detailed quick fix descriptions

## [0.1.10] - 2026-01-31

### Added
- **Quick Fixes**: One-click automated fixes for common build issues
  - Click the ⚡ wand icon on any fixable issue to apply fix instantly
  - Supported fix patterns:
    - **Lock file mismatch**: Switch to npm/pnpm, delete conflicting lock files
    - **Node version mismatch**: Create .nvmrc, add nvm use to amplify.yml
    - **Missing env vars**: Open console, create .env.example template
    - **npm install failures**: Clear cache, use legacy peer deps
    - **Build failures**: Add CI=false, open package.json
    - **Out of memory**: Increase Node heap size
    - **amplify.yml errors**: Create template, validate syntax
    - **pnpm failures**: Enable corepack, pin pnpm version
- New commands:
  - `Apply Quick Fix` - Apply a specific fix to resolve build issues
  - `Show Quick Fixes` - Browse all available quick fixes
- Quick fix button appears inline on fixable issues in diagnosis panel

### Improved
- Diagnosis tree reorganized to show Quick Fixes prominently
- Better categorization of automated vs manual fix steps

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
