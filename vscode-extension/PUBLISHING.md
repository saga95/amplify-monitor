# Publishing Amplify Monitor to VS Code Marketplace

This guide walks you through publishing the extension to make it publicly available.

## Prerequisites

1. **Microsoft Account** - You need a Microsoft account (Outlook, Hotmail, or Azure)
2. **Azure DevOps Organization** - Free to create
3. **Personal Access Token (PAT)** - For authentication

---

## Step 1: Create Azure DevOps Organization

1. Go to https://dev.azure.com
2. Sign in with your Microsoft account
3. Click "Create new organization"
4. Choose a name (e.g., `saga95-vscode`)
5. Complete the setup

---

## Step 2: Create Personal Access Token (PAT)

1. In Azure DevOps, click your profile icon (top right)
2. Select **Personal access tokens**
3. Click **+ New Token**
4. Configure:
   - **Name**: `vscode-marketplace`
   - **Organization**: Select your organization
   - **Expiration**: Choose duration (max 1 year)
   - **Scopes**: Select **Custom defined**, then:
     - Find **Marketplace** → Check **Manage**
5. Click **Create**
6. **IMPORTANT**: Copy the token immediately (you won't see it again!)

---

## Step 3: Create Publisher

1. Go to https://marketplace.visualstudio.com/manage
2. Sign in with your Microsoft account
3. Click **Create publisher**
4. Fill in:
   - **Publisher ID**: `saga95` (must match package.json)
   - **Display Name**: `saga95` or your preferred name
   - **Description**: "Developer tools for AWS Amplify"
5. Accept the agreement and create

---

## Step 4: Publish Extension

### Option A: Using Command Line (Recommended)

```bash
# Install vsce globally (if not installed)
npm install -g @vscode/vsce

# Navigate to extension directory
cd vscode-extension

# Login with your PAT
npx vsce login saga95
# Paste your Personal Access Token when prompted

# Publish!
npx vsce publish
```

### Option B: Manual Upload

1. Go to https://marketplace.visualstudio.com/manage
2. Click your publisher
3. Click **+ New extension** → **Visual Studio Code**
4. Drag and drop `amplify-monitor-0.1.0.vsix`
5. Wait for validation

---

## Step 5: Add Screenshots (Important for Discoverability!)

Before publishing, add screenshots to improve your marketplace page:

1. Create a `docs` folder in your repo
2. Add screenshots:
   - `screenshot.png` - Main extension view
   - `screenshot-diagnosis.png` - Diagnosis panel
   - `screenshot-jobs.png` - Jobs view

3. Push to GitHub:
   ```bash
   git add docs/
   git commit -m "Add marketplace screenshots"
   git push
   ```

The README references:
```
https://raw.githubusercontent.com/saga95/amplify-monitor/main/docs/screenshot.png
```

---

## Step 6: Verify Publication

1. Wait 5-10 minutes for processing
2. Search "Amplify Monitor" on https://marketplace.visualstudio.com
3. Verify your extension appears with correct:
   - Icon
   - Description
   - README content
   - Badges

---

## Updating the Extension

When you release new versions:

```bash
# Update version in package.json (e.g., 0.1.1)

# Package and publish
npx vsce publish

# Or publish with auto-increment
npx vsce publish patch  # 0.1.0 → 0.1.1
npx vsce publish minor  # 0.1.0 → 0.2.0
npx vsce publish major  # 0.1.0 → 1.0.0
```

---

## Troubleshooting

### "Publisher not found"
- Ensure publisher ID in package.json matches your Marketplace publisher ID exactly

### "Personal access token invalid"
- Token must have **Marketplace: Manage** scope
- Token must be from the same organization

### "Extension validation failed"
- Check icon is 128x128 PNG
- Verify all paths in package.json are correct
- Run `npx vsce ls` to see what files will be included

---

## Quick Commands Reference

```bash
# Login to marketplace
npx vsce login saga95

# Package without publishing
npx vsce package

# Publish new version
npx vsce publish

# Unpublish (use carefully!)
npx vsce unpublish saga95.amplify-monitor
```

---

## Best Practices

1. **Test locally first**: Install `.vsix` with `code --install-extension`
2. **Add meaningful screenshots**: Users browse visually
3. **Keep README updated**: It's your main marketing page
4. **Respond to issues**: Builds trust and community
5. **Iterate based on feedback**: Check reviews regularly

---

Good luck with your publication! 🚀
