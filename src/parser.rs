//! Log parsing and error classification
//!
//! Analyzes Amplify build/deploy logs to detect common failure patterns
//! and provide actionable suggested fixes.

use serde::Serialize;

use crate::logs::LogContent;

/// A detected issue with root cause and suggested fixes
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub pattern: String,
    pub root_cause: String,
    pub suggested_fixes: Vec<String>,
}

/// Helper to check if any pattern matches (case-sensitive)
fn matches_any(content: &str, patterns: &[&str]) -> bool {
    patterns.iter().any(|p| content.contains(p))
}

/// Helper to check if any pattern matches (case-insensitive)
fn matches_any_ci(content: &str, patterns: &[&str]) -> bool {
    let lower = content.to_lowercase();
    patterns
        .iter()
        .any(|p| lower.contains(&p.to_lowercase()))
}

/// Helper to check if any pattern matches along with any error indicator
fn matches_with_indicator(content: &str, patterns: &[&str], indicators: &[&str]) -> bool {
    let lower = content.to_lowercase();
    patterns.iter().any(|p| content.contains(p) || lower.contains(&p.to_lowercase()))
        && indicators
            .iter()
            .any(|i| lower.contains(&i.to_lowercase()))
}

/// Macro to reduce boilerplate for simple pattern checkers
macro_rules! define_checker {
    (
        $fn_name:ident,
        pattern: $pattern:expr,
        root_cause: $root_cause:expr,
        fixes: [$($fix:expr),+ $(,)?],
        patterns: [$($p:expr),+ $(,)?]
    ) => {
        fn $fn_name(content: &str) -> Option<Issue> {
            let patterns = [$($p),+];
            if matches_any_ci(content, &patterns) {
                return Some(Issue {
                    pattern: $pattern.to_string(),
                    root_cause: $root_cause.to_string(),
                    suggested_fixes: vec![$($fix.to_string()),+],
                });
            }
            None
        }
    };
    (
        $fn_name:ident,
        pattern: $pattern:expr,
        root_cause: $root_cause:expr,
        fixes: [$($fix:expr),+ $(,)?],
        patterns: [$($p:expr),+ $(,)?],
        indicators: [$($i:expr),+ $(,)?]
    ) => {
        fn $fn_name(content: &str) -> Option<Issue> {
            let patterns = [$($p),+];
            let indicators = [$($i),+];
            if matches_with_indicator(content, &patterns, &indicators) {
                return Some(Issue {
                    pattern: $pattern.to_string(),
                    root_cause: $root_cause.to_string(),
                    suggested_fixes: vec![$($fix.to_string()),+],
                });
            }
            None
        }
    };
}

/// Analyze logs and return all matching failure patterns
pub fn analyze_logs(logs: &LogContent) -> Vec<Issue> {
    let mut issues = Vec::new();
    let content = &logs.raw_content;

    // All pattern checkers
    let checkers: Vec<fn(&str) -> Option<Issue>> = vec![
        check_lockfile_mismatch,
        check_package_manager_conflict,
        check_node_version_mismatch,
        check_missing_env_vars,
        check_npm_ci_failure,
        check_pnpm_install_failure,
        check_yarn_install_failure,
        check_amplify_yml_error,
        check_out_of_memory,
        check_timeout,
        check_artifact_path_error,
        check_typescript_error,
        check_eslint_error,
        check_module_not_found,
        check_permission_denied,
        check_network_error,
        check_docker_error,
        check_python_error,
        check_next_js_error,
        check_vite_error,
    ];

    for checker in checkers {
        if let Some(issue) = checker(content) {
            issues.push(issue);
        }
    }

    issues
}

// ============================================================================
// Pattern Checkers - Using macros for common patterns
// ============================================================================

// Simple pattern matchers (no indicators needed)
define_checker!(
    check_npm_ci_failure,
    pattern: "npm_ci_failure",
    root_cause: "npm ci failed - likely due to package-lock.json sync issues",
    fixes: [
        "Run 'npm install' locally to regenerate package-lock.json",
        "Commit the updated package-lock.json",
        "Ensure package-lock.json is not in .gitignore"
    ],
    patterns: [
        "npm ERR! cipm can only install",
        "npm ERR! `npm ci` can only install",
        "npm ERR! code EUSAGE",
        "npm ERR! The `npm ci` command"
    ]
);

define_checker!(
    check_pnpm_install_failure,
    pattern: "pnpm_install_failure",
    root_cause: "pnpm installation failed",
    fixes: [
        "Install pnpm in preBuild: 'npm install -g pnpm'",
        "Run 'pnpm install' locally to update lock file",
        "Check pnpm version compatibility"
    ],
    patterns: [
        "ERR_PNPM_",
        "pnpm: command not found",
        "ERR_PNPM_PEER_DEP_ISSUES",
        "ERR_PNPM_LOCKFILE_BREAKING_CHANGE"
    ]
);

define_checker!(
    check_out_of_memory,
    pattern: "out_of_memory",
    root_cause: "Build process ran out of memory",
    fixes: [
        "Add NODE_OPTIONS=--max_old_space_size=4096 to environment variables",
        "Optimize build by reducing bundle size",
        "Consider using a larger Amplify build instance"
    ],
    patterns: [
        "FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed",
        "FATAL ERROR: Ineffective mark-compacts",
        "JavaScript heap out of memory",
        "ENOMEM",
        "out of memory",
        "OOMKilled"
    ]
);

define_checker!(
    check_timeout,
    pattern: "timeout",
    root_cause: "Build exceeded time limit",
    fixes: [
        "Increase build timeout in Amplify console",
        "Optimize build steps to run faster",
        "Check for hanging processes or infinite loops",
        "Consider caching node_modules"
    ],
    patterns: [
        "timed out",
        "timeout",
        "Build timeout",
        "exceeded time limit",
        "ETIMEDOUT"
    ]
);

define_checker!(
    check_typescript_error,
    pattern: "typescript_error",
    root_cause: "TypeScript compilation failed",
    fixes: [
        "Fix TypeScript errors locally before pushing",
        "Run 'npx tsc --noEmit' to check for errors",
        "Ensure all type definitions are installed (@types/*)",
        "Check tsconfig.json for correct configuration"
    ],
    patterns: [
        "error TS",
        "TS2304",
        "TS2307",
        "TS2345",
        "TS2339",
        "Cannot find module",
        "Type error:",
        "tsc exited with code"
    ]
);

define_checker!(
    check_module_not_found,
    pattern: "module_not_found",
    root_cause: "Required module/package not found",
    fixes: [
        "Ensure all dependencies are listed in package.json",
        "Check import paths for typos or case sensitivity",
        "Verify the module is not in devDependencies when needed in production",
        "Run 'npm install' to ensure all packages are installed"
    ],
    patterns: [
        "Module not found",
        "Cannot find module",
        "Module build failed",
        "ModuleNotFoundError",
        "Error: Cannot resolve"
    ]
);

define_checker!(
    check_permission_denied,
    pattern: "permission_denied",
    root_cause: "File system permission error",
    fixes: [
        "Avoid writing to read-only directories",
        "Use /tmp for temporary files in Amplify builds",
        "Check file permissions in repository"
    ],
    patterns: [
        "EACCES",
        "permission denied",
        "Permission denied",
        "EPERM",
        "operation not permitted"
    ]
);

define_checker!(
    check_network_error,
    pattern: "network_error",
    root_cause: "Network connectivity issue during build",
    fixes: [
        "Retry the build - may be a transient network issue",
        "Check if npm registry or external services are accessible",
        "Consider using a private npm registry or cache"
    ],
    patterns: [
        "ENOTFOUND",
        "ECONNREFUSED",
        "ECONNRESET",
        "EAI_AGAIN",
        "getaddrinfo",
        "network request failed",
        "socket hang up"
    ]
);

// Pattern matchers with indicators (require both pattern AND indicator)
define_checker!(
    check_node_version_mismatch,
    pattern: "node_version_mismatch",
    root_cause: "Node.js version in Amplify doesn't match project requirements",
    fixes: [
        "Add 'nvm use' to preBuild commands in amplify.yml",
        "Set Node.js version in Amplify console build settings",
        "Add .nvmrc file to repository root",
        "Update package.json engines field"
    ],
    patterns: [
        "engine \"node\" is incompatible",
        "The engine \"node\" is incompatible",
        "expected node version",
        "NODE_VERSION",
        "nvm use",
        "unsupported engine"
    ],
    indicators: ["incompatible", "expected", "unsupported", "error", "mismatch"]
);

define_checker!(
    check_amplify_yml_error,
    pattern: "amplify_yml_error",
    root_cause: "amplify.yml buildspec has configuration errors",
    fixes: [
        "Validate YAML syntax in amplify.yml",
        "Check indentation (use spaces, not tabs)",
        "Verify all required phases are defined (preBuild, build, artifacts)",
        "Reference: https://docs.aws.amazon.com/amplify/latest/userguide/build-settings.html"
    ],
    patterns: [
        "amplify.yml",
        "buildspec",
        "YAMLException",
        "Invalid buildspec",
        "build specification"
    ],
    indicators: ["error", "invalid", "failed to parse", "syntax"]
);

define_checker!(
    check_yarn_install_failure,
    pattern: "yarn_install_failure",
    root_cause: "Yarn installation failed",
    fixes: [
        "Run 'yarn install' locally and commit yarn.lock",
        "Ensure yarn is installed in preBuild: 'npm install -g yarn'",
        "Check yarn version compatibility"
    ],
    patterns: [
        "error An unexpected error occurred",
        "yarn install",
        "YN0001",
        "YN0002",
        "YARN_",
        "yarn.lock"
    ],
    indicators: ["error", "failed", "ENOENT", "EPERM"]
);

define_checker!(
    check_eslint_error,
    pattern: "eslint_error",
    root_cause: "ESLint validation failed",
    fixes: [
        "Run 'npm run lint' or 'npx eslint .' locally",
        "Fix linting errors or adjust rules in .eslintrc",
        "Consider adding 'CI=false' to skip lint warnings as errors"
    ],
    patterns: ["eslint", "ESLint", "Parsing error:", "eslint-disable"],
    indicators: ["problems", "error", "Rule:"]
);

define_checker!(
    check_docker_error,
    pattern: "docker_error",
    root_cause: "Docker/container build issue",
    fixes: [
        "Verify Dockerfile syntax and base image availability",
        "Check Docker build context and .dockerignore",
        "Ensure Docker commands are supported in Amplify build environment"
    ],
    patterns: ["docker", "Dockerfile", "container", "DOCKER_"],
    indicators: ["error", "failed", "not found", "denied"]
);

define_checker!(
    check_python_error,
    pattern: "python_error",
    root_cause: "Python dependency or syntax error",
    fixes: [
        "Add Python packages to requirements.txt",
        "Install Python dependencies in preBuild phase",
        "Verify Python version compatibility"
    ],
    patterns: [
        "ModuleNotFoundError: No module named",
        "pip install",
        "python:",
        "SyntaxError:",
        "ImportError:"
    ],
    indicators: ["error", "failed", "not found"]
);

define_checker!(
    check_next_js_error,
    pattern: "nextjs_error",
    root_cause: "Next.js build or configuration error",
    fixes: [
        "Run 'npm run build' locally to reproduce the error",
        "Check getStaticProps/getServerSideProps for runtime errors",
        "Verify NEXT_PUBLIC_* environment variables are set",
        "Set baseDirectory to '.next' in amplify.yml artifacts"
    ],
    patterns: [
        "next build",
        "Error occurred prerendering",
        "getStaticProps",
        "getServerSideProps",
        "next.config",
        "NEXT_"
    ],
    indicators: ["error", "failed", "Error:"]
);

define_checker!(
    check_vite_error,
    pattern: "vite_error",
    root_cause: "Vite build or bundling error",
    fixes: [
        "Run 'npm run build' locally to reproduce",
        "Verify VITE_* environment variables are set in Amplify",
        "Set baseDirectory to 'dist' in amplify.yml artifacts",
        "Check vite.config.ts for build configuration issues"
    ],
    patterns: ["vite build", "vite:", "VITE_", "rollup", "esbuild"],
    indicators: ["error", "failed", "Error:"]
);

// ============================================================================
// Complex checkers that need custom logic
// ============================================================================

/// Check for lock file mismatch (package-lock.json vs pnpm-lock.yaml)
fn check_lockfile_mismatch(content: &str) -> Option<Issue> {
    let has_npm_lock_error = content.contains("npm WARN")
        && (content.contains("package-lock.json") || content.contains("npm-shrinkwrap.json"));
    let has_pnpm_lock = content.contains("pnpm-lock.yaml");
    let has_yarn_lock = content.contains("yarn.lock");

    if has_npm_lock_error && (has_pnpm_lock || has_yarn_lock) {
        return Some(Issue {
            pattern: "lockfile_mismatch".to_string(),
            root_cause: "Multiple lock files detected or package manager mismatch".to_string(),
            suggested_fixes: vec![
                "Remove conflicting lock files (keep only one)".to_string(),
                "Update amplify.yml to use the correct package manager".to_string(),
                "Run 'npm ci' with package-lock.json OR 'pnpm install --frozen-lockfile' with pnpm-lock.yaml".to_string(),
            ],
        });
    }

    None
}

/// Check for package manager conflicts
fn check_package_manager_conflict(content: &str) -> Option<Issue> {
    let uses_npm = content.contains("npm install") || content.contains("npm ci");
    let uses_pnpm = content.contains("pnpm install");
    let uses_yarn = content.contains("yarn install");

    let count = [uses_npm, uses_pnpm, uses_yarn]
        .iter()
        .filter(|&&x| x)
        .count();

    if count > 1 {
        return Some(Issue {
            pattern: "package_manager_conflict".to_string(),
            root_cause: "Multiple package managers detected in build".to_string(),
            suggested_fixes: vec![
                "Use only one package manager consistently".to_string(),
                "Update amplify.yml preBuild and build commands".to_string(),
                "Ensure CI environment matches local development".to_string(),
            ],
        });
    }

    None
}

/// Check for missing environment variables
fn check_missing_env_vars(content: &str) -> Option<Issue> {
    let patterns = [
        "environment variable",
        "env var",
        "process.env",
        "undefined variable",
        "REACT_APP_",
        "NEXT_PUBLIC_",
        "VITE_",
    ];

    let error_indicators = ["undefined", "not set", "missing", "required"];

    for pattern in patterns {
        if content.contains(pattern) {
            for indicator in error_indicators {
                if content.to_lowercase().contains(indicator) {
                    return Some(Issue {
                        pattern: "missing_env_vars".to_string(),
                        root_cause: "Required environment variables are not configured".to_string(),
                        suggested_fixes: vec![
                            "Add missing environment variables in Amplify console".to_string(),
                            "Check for typos in variable names".to_string(),
                            "Ensure variables are set for the correct branch/environment"
                                .to_string(),
                        ],
                    });
                }
            }
        }
    }

    None
}

/// Check for artifact path errors
fn check_artifact_path_error(content: &str) -> Option<Issue> {
    let patterns = [
        "artifacts baseDirectory",
        "No such file or directory",
        "ENOENT",
        "build artifacts not found",
        "baseDirectory",
    ];

    let error_context = ["artifacts", "output", "dist", "build", ".next"];

    for pattern in patterns {
        if content.contains(pattern) {
            for ctx in error_context {
                if content.contains(ctx) {
                    return Some(Issue {
                        pattern: "artifact_path_error".to_string(),
                        root_cause: "Build artifacts directory not found or misconfigured"
                            .to_string(),
                        suggested_fixes: vec![
                            "Verify baseDirectory in amplify.yml matches actual build output"
                                .to_string(),
                            "Common paths: 'dist', 'build', '.next', 'out'".to_string(),
                            "Ensure build command actually generates output".to_string(),
                        ],
                    });
                }
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_npm_ci_failure() {
        let content =
            "npm ERR! `npm ci` can only install packages with an existing package-lock.json";
        let issue = check_npm_ci_failure(content);
        assert!(issue.is_some());
        assert_eq!(issue.unwrap().pattern, "npm_ci_failure");
    }

    #[test]
    fn test_detect_out_of_memory() {
        let content = "FATAL ERROR: JavaScript heap out of memory";
        let issue = check_out_of_memory(content);
        assert!(issue.is_some());
        assert_eq!(issue.unwrap().pattern, "out_of_memory");
    }

    #[test]
    fn test_no_false_positive() {
        let content = "Build completed successfully";
        let logs = LogContent {
            build_log: content.to_string(),
            deploy_log: String::new(),
            raw_content: content.to_string(),
        };
        let issues = analyze_logs(&logs);
        assert!(issues.is_empty());
    }
}
