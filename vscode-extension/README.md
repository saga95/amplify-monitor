# Amplify Monitor

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/saga95.amplify-monitor)](https://marketplace.visualstudio.com/items?itemName=saga95.amplify-monitor)
[![Downloads](https://img.shields.io/visual-studio-marketplace/d/saga95.amplify-monitor)](https://marketplace.visualstudio.com/items?itemName=saga95.amplify-monitor)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/saga95.amplify-monitor)](https://marketplace.visualstudio.com/items?itemName=saga95.amplify-monitor)
[![GitHub](https://img.shields.io/github/license/saga95/amplify-monitor)](https://github.com/saga95/amplify-monitor/blob/main/LICENSE)

**Monitor AWS Amplify builds and diagnose failures with AI-powered root cause analysis directly in VS Code.**

Stop wasting time scrolling through build logs! Amplify Monitor automatically detects 20+ common build failure patterns and provides actionable fixes.

![Amplify Monitor Screenshot](https://raw.githubusercontent.com/saga95/amplify-monitor/main/docs/screenshot.png)

---

## ✨ Features

### 🔍 **Smart Build Diagnosis**
Automatically analyze failed builds and identify root causes:
- Lock file mismatches (npm vs pnpm vs yarn)
- Node.js version conflicts
- Missing environment variables
- Package installation failures
- TypeScript/ESLint errors
- And 15+ more patterns!

### 📊 **Real-time Job Monitoring**
- View all your Amplify apps and branches
- Track build/deploy job status with color-coded indicators
- Auto-refresh support for continuous monitoring

### 💡 **Actionable Fixes**
Each detected issue comes with:
- Clear root cause explanation
- Step-by-step suggested fixes
- Copy-to-clipboard for easy sharing

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

1. Open the **Amplify Monitor** panel from the Activity Bar (left sidebar)
2. Select an app from the **Apps** panel
3. Choose a branch to view recent jobs
4. Click on any **FAILED** job to diagnose it
5. Review detected issues with root causes and fixes!

---

## 📋 Detected Issues

| Category | Patterns Detected |
|----------|-------------------|
| **Package Manager** | Lock file mismatch, npm/pnpm/yarn conflicts |
| **Node.js** | Version mismatch, incompatible dependencies |
| **Environment** | Missing env vars, invalid configuration |
| **Build Tools** | TypeScript errors, ESLint failures, Vite/Next.js issues |
| **Infrastructure** | Out of memory, timeout, permission denied |
| **Network** | Download failures, registry issues |

---

## ⚙️ Configuration

Access settings via **Amplify Monitor: Open Settings** or `Ctrl+,` → search "amplify".

| Setting | Default | Description |
|---------|---------|-------------|
| `amplifyMonitor.cliPath` | `amplify-monitor` | Path to CLI executable |
| `amplifyMonitor.defaultAppId` | - | Default app ID for commands |
| `amplifyMonitor.defaultBranch` | `main` | Default branch to monitor |
| `amplifyMonitor.autoRefresh` | `false` | Enable auto-refresh |
| `amplifyMonitor.autoRefreshInterval` | `60` | Refresh interval (seconds) |

---

## 🎯 Commands

Open Command Palette (`Ctrl+Shift+P`) and type "Amplify Monitor":

| Command | Description |
|---------|-------------|
| **Diagnose Latest Failed Build** | Analyze the most recent failed job |
| **List Apps** | Refresh the apps list |
| **Select App** | Choose an app to monitor |
| **Select Branch** | Choose a branch to monitor |
| **Refresh** | Refresh all panels |
| **Open Settings** | Open extension settings |

---

## 🔒 Security

- **No credentials stored** - Uses AWS CLI/environment configuration
- **Read-only access** - Never modifies your Amplify resources
- **Open source** - Full code available on [GitHub](https://github.com/saga95/amplify-monitor)

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

**If this extension helped you, please [⭐ star the repo](https://github.com/saga95/amplify-monitor) and [rate it on the marketplace](https://marketplace.visualstudio.com/items?itemName=saga95.amplify-monitor&ssr=false#review-details)!**
