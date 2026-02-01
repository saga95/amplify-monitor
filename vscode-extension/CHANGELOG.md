# Changelog

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
