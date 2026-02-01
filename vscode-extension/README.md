# Amplify Monitor

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/SagaraHarasgama.amplify-monitor)](https://marketplace.visualstudio.com/items?itemName=SagaraHarasgama.amplify-monitor)
[![Downloads](https://img.shields.io/visual-studio-marketplace/d/SagaraHarasgama.amplify-monitor)](https://marketplace.visualstudio.com/items?itemName=SagaraHarasgama.amplify-monitor)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/SagaraHarasgama.amplify-monitor)](https://marketplace.visualstudio.com/items?itemName=SagaraHarasgama.amplify-monitor)
[![GitHub](https://img.shields.io/github/license/saga95/amplify-monitor)](https://github.com/saga95/amplify-monitor/blob/main/LICENSE)

**The ultimate AWS Amplify development toolkit for VS Code.** Monitor builds, diagnose failures with AI-powered analysis, migrate to Gen2, and manage your entire Amplify portfolio — all without leaving your editor.

![Amplify Monitor Dashboard](https://raw.githubusercontent.com/saga95/amplify-monitor/main/docs/dashboard.png)

---

## 🚀 What's New in v0.1.15

- 🔐 **Secrets Manager Integration** - Sync env vars from AWS SSM/Secrets Manager
- ✅ **Pre-Deploy Validation** - Catch issues BEFORE they cause failed builds
- 🧙 **Build Optimization Wizard** - Guided recommendations to speed up builds
- 📦 **Bundle Size Analyzer** - Visualize build output against 230MB limit
- 📈 **Build Performance Tracker** - Track build times and detect regressions

---

## ✨ Features

### 📊 **Portfolio Dashboard**
Get a bird's-eye view of your entire Amplify infrastructure:
- Visual grid showing all apps, branches, and build statuses
- Summary bar with total apps, succeeded, failed, and running builds
- Quick action buttons: Start Build, Stop Build, View Logs, Open Console
- Relative timestamps ("5m ago", "2h ago") for last build time
- Responsive design adapts to your VS Code window

![Dashboard](https://raw.githubusercontent.com/saga95/amplify-monitor/main/docs/dashboard-view.png)

### ⚡ **Quick Fixes (One-Click Resolution)**
Stop manually fixing the same issues over and over! When you diagnose a failed build, Amplify Monitor offers **automated fixes**:

| Issue | Available Fixes |
|-------|----------------|
| **Lock file mismatch** | Switch to npm/pnpm, delete conflicting lock files |
| **Node version mismatch** | Create .nvmrc, add `nvm use` to amplify.yml |
| **Missing env vars** | Open AWS Console, create .env.example template |
| **npm install failed** | Clear cache, use legacy peer deps |
| **Build command failed** | Add CI=false, open package.json |
| **Out of memory** | Increase Node heap size to 8GB |
| **amplify.yml errors** | Create template, validate syntax |
| **pnpm install failed** | Enable corepack, pin pnpm version |

Click the ⚡ wand icon on any fixable issue to apply instantly!

### 🔍 **Smart Build Diagnosis**
Automatically analyze failed builds and identify root causes:
- 20+ detection patterns for common issues
- Lock file mismatches (npm vs pnpm vs yarn)
- Node.js version conflicts
- Missing environment variables
- Package installation failures
- TypeScript/ESLint errors
- Amplify buildspec configuration errors

### 🔀 **Gen2 Migration Assistant**
Planning to migrate from Amplify Gen1 to Gen2? Get a full compatibility report:
- Detects all Gen1 features in your project
- Shows migration compatibility for each feature:
  - ✅ **Fully Supported** - Works out of the box
  - 🔧 **Supported with CDK** - Requires CDK configuration
  - ❌ **Not Supported** - Manual migration needed
  - ⚠️ **Blocking** - Must be resolved before migration
- Links to official AWS migration documentation

### 🔐 **Secrets Manager Integration** (NEW)
Centralize your secrets management with AWS SSM and Secrets Manager:
- **Browse SSM Parameters** - Search by prefix, view SecureString/String types
- **Browse Secrets Manager** - List and select secrets to sync
- **Sync to Amplify** - Push secrets as environment variables with one click
- **Backup to SSM** - Export Amplify env vars to Parameter Store
- **Create .env.example** - Generate template from selected parameters
- **Multi-region Support** - Switch regions on the fly

### ✅ **Pre-Deploy Validation** (NEW)
Catch issues BEFORE they cause failed builds:
- **Git Checks** - Uncommitted changes, unpushed commits
- **Dependency Checks** - Lock files, version mismatches
- **Build Validation** - TypeScript errors, missing scripts
- **Environment Checks** - Secrets in code, .env gitignored
- **One-Click Deploy** - Deploy directly when all checks pass

### 🧙 **Build Optimization Wizard**
Speed up your Amplify builds with guided optimization:
- **Caching Analysis** - Enable Amplify build cache, Next.js cache, node_modules caching
- **Dependency Checks** - Use npm ci, detect duplicate packages, optimize lock files
- **Build Config** - Enable skipLibCheck, upgrade Node.js version, parallel builds
- **Asset Optimization** - Find large images, font optimization suggestions
- **One-Click Fixes** - Apply optimizations with a single button
- **Estimated Savings** - See potential build time reduction

### 📦 **Bundle Size Analyzer** (NEW)
Prevent "build output exceeds max size" errors:
- Visualize build output size vs Amplify's 230MB limit
- See largest files and directories with percentage breakdown
- Auto-detects .next, dist, build, out directories
- Get actionable recommendations to reduce bundle size

### 📈 **Build Performance Tracker** (NEW)
Track and optimize build times over time:
- Historical build duration tracking per branch
- Success rate metrics and trend analysis
- Detect build time regressions
- Compare performance across branches

### 🏗️ **Monorepo Support** (NEW)
First-class support for monorepo architectures:
- Auto-detects TurboRepo, Nx, Lerna, npm/pnpm/yarn workspaces
- One-click amplify.yml generation with proper baseDirectory
- Package dependency visualization

### 🎯 **Smart Auto-Detection**
The extension "just works" when you open an Amplify project:
- Automatically detects `amplify/` folder in workspace
- Fetches apps when AWS credentials are available
- Shows connection status in status bar
- Prompts for credential configuration if needed
- Re-detects when workspace folders change

### 🌍 **Multi-Region & Cross-Account Support**
- Discovers apps across **all AWS regions** automatically
- Switch AWS profiles with one click from the status bar
- Perfect for consultants managing multiple client accounts

### 🔐 **Environment Variables Manager**
Manage branch environment variables without leaving VS Code:
- View all variables (securely masked by default)
- Add, edit, and delete with one click
- Reveal values with copy-to-clipboard
- Changes apply immediately

### ⚡ **Quick Actions**
- **Start Build** - Trigger deployments instantly
- **Stop Build** - Cancel running builds
- **Open in Console** - Jump to AWS Console

### 📝 **amplify.yml IntelliSense**
- JSON schema validation with error highlighting
- 14+ code snippets for Next.js, Vite, pnpm, monorepos
- Auto-completion for all buildspec properties

---

## 🚀 Getting Started

### Prerequisites

1. **Install the CLI** (required):
   ```bash
   # Download from GitHub releases
   # https://github.com/saga95/amplify-monitor/releases
   
   # Or build from source
   cargo install --git https://github.com/saga95/amplify-monitor
   ```

2. **Configure AWS Credentials**:
   ```bash
   # Option 1: Environment variables
   export AWS_ACCESS_KEY_ID=your_key
   export AWS_SECRET_ACCESS_KEY=your_secret
   export AWS_REGION=us-east-1
   
   # Option 2: AWS CLI profile
   aws configure
   ```

### Quick Start

1. Install the extension from VS Code Marketplace
2. Open any project — the extension auto-detects Amplify configurations
3. Check the status bar for connection status
4. Open the **Amplify Monitor** panel from the Activity Bar
5. Click the 📊 dashboard icon to see all your apps at a glance!

---

## 📋 Detected Issues

| Category | Patterns Detected |
|----------|-------------------|
| **Package Manager** | Lock file mismatch, npm/pnpm/yarn conflicts, corepack issues |
| **Node.js** | Version mismatch, incompatible dependencies, nvm errors |
| **Environment** | Missing env vars, invalid configuration, build secrets |
| **Build Tools** | TypeScript errors, ESLint failures, Vite/Next.js issues |
| **Infrastructure** | Out of memory, timeout, permission denied |
| **Network** | Download failures, registry issues, certificate errors |
| **Amplify** | amplify.yml syntax errors, invalid build phases |

---

## ⚙️ Configuration

Access settings via **Amplify Monitor: Open Settings** or `Ctrl+,` → search "amplify".

| Setting | Default | Description |
|---------|---------|-------------|
| `amplifyMonitor.cliPath` | `amplify-monitor` | Path to CLI executable |
| `amplifyMonitor.awsProfile` | - | AWS profile for cross-account access |
| `amplifyMonitor.defaultAppId` | - | Default app ID for commands |
| `amplifyMonitor.defaultBranch` | `main` | Default branch to monitor |
| `amplifyMonitor.autoRefresh` | `false` | Enable auto-refresh |
| `amplifyMonitor.autoRefreshInterval` | `60` | Refresh interval (seconds) |

---

## 🎯 Commands

Open Command Palette (`Ctrl+Shift+P`) and type "Amplify Monitor":

| Command | Description |
|---------|-------------|
| **Open Dashboard** | Visual overview of all apps |
| **Manage Secrets** | Sync env vars from SSM/Secrets Manager |
| **Pre-Deploy Validation** | Check for issues before deploying |
| **Diagnose Latest Failed Build** | Analyze the most recent failed job |
| **Apply Quick Fix** | Fix common issues with one click |
| **Build Optimization Wizard** | Guided build speed improvements |
| **Analyze Bundle Size** | Check build output against 230MB limit |
| **Show Build Performance** | View build time trends |
| **Detect Monorepo Structure** | Auto-detect and configure monorepos |
| **Analyze Gen1 → Gen2 Migration** | Check migration readiness |
| **List Apps** | Refresh the apps list |
| **Switch AWS Profile** | Change AWS profile |
| **Start Build** | Trigger a new deployment |
| **Stop Build** | Cancel a running deployment |
| **Add Environment Variable** | Add new env var to branch |
| **Open in AWS Console** | Open app in browser |

---

## 🔒 Security

- **No credentials stored** - Uses AWS CLI/environment configuration
- **Secure value masking** - Environment variables hidden by default
- **Read-only by default** - Write operations require explicit action
- **Open source** - Full code available on [GitHub](https://github.com/saga95/amplify-monitor)

---

## 🛠️ Architecture

This extension is powered by a Rust CLI for maximum performance:

```
┌─────────────────────────────────────────────────────────┐
│                    VS Code Extension                     │
│  ┌─────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────┐  │
│  │Dashboard│ │Diagnosis │ │Migration │ │Quick Fixes  │  │
│  │ Panel   │ │  Tree    │ │  Tree    │ │  Service    │  │
│  └────┬────┘ └────┬─────┘ └────┬─────┘ └──────┬──────┘  │
│       │           │            │              │          │
│       └───────────┴─────┬──────┴──────────────┘          │
│                         │                                 │
│                   ┌─────▼─────┐                           │
│                   │  CLI.ts   │                           │
│                   └─────┬─────┘                           │
└─────────────────────────┼───────────────────────────────┘
                          │
                   ┌──────▼──────┐
                   │ amplify-    │
                   │ monitor CLI │ (Rust)
                   └──────┬──────┘
                          │
                   ┌──────▼──────┐
                   │  AWS SDK    │
                   │  Amplify    │
                   └─────────────┘
```

---

## 🤝 Contributing

Contributions are welcome! See our [Contributing Guide](https://github.com/saga95/amplify-monitor/blob/main/CONTRIBUTING.md).

- 🐛 [Report bugs](https://github.com/saga95/amplify-monitor/issues)
- 💡 [Request features](https://github.com/saga95/amplify-monitor/issues)
- 📖 [Read the docs](https://github.com/saga95/amplify-monitor#readme)

---

## 📄 License

MIT © [saga95](https://github.com/saga95)

---

**If this extension helped you, please [⭐ star the repo](https://github.com/saga95/amplify-monitor) and [rate it on the marketplace](https://marketplace.visualstudio.com/items?itemName=SagaraHarasgama.amplify-monitor&ssr=false#review-details)!**
