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

/// Check for Node.js version mismatch
fn check_node_version_mismatch(content: &str) -> Option<Issue> {
    let patterns = [
        "engine \"node\" is incompatible",
        "The engine \"node\" is incompatible",
        "expected node version",
        "NODE_VERSION",
        "nvm use",
        "unsupported engine",
    ];

    for pattern in patterns {
        if content.to_lowercase().contains(&pattern.to_lowercase()) {
            return Some(Issue {
                pattern: "node_version_mismatch".to_string(),
                root_cause: "Node.js version in Amplify doesn't match project requirements"
                    .to_string(),
                suggested_fixes: vec![
                    "Add 'nvm use' to preBuild commands in amplify.yml".to_string(),
                    "Set Node.js version in Amplify console build settings".to_string(),
                    "Add .nvmrc file to repository root".to_string(),
                    "Update package.json engines field".to_string(),
                ],
            });
        }
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

/// Check for npm ci failures
fn check_npm_ci_failure(content: &str) -> Option<Issue> {
    let patterns = [
        "npm ERR! cipm can only install",
        "npm ERR! `npm ci` can only install",
        "npm ERR! code EUSAGE",
        "npm ERR! The `npm ci` command",
    ];

    for pattern in patterns {
        if content.contains(pattern) {
            return Some(Issue {
                pattern: "npm_ci_failure".to_string(),
                root_cause: "npm ci failed - likely due to package-lock.json sync issues"
                    .to_string(),
                suggested_fixes: vec![
                    "Run 'npm install' locally to regenerate package-lock.json".to_string(),
                    "Commit the updated package-lock.json".to_string(),
                    "Ensure package-lock.json is not in .gitignore".to_string(),
                ],
            });
        }
    }

    None
}

/// Check for pnpm install failures
fn check_pnpm_install_failure(content: &str) -> Option<Issue> {
    let patterns = [
        "ERR_PNPM_",
        "pnpm: command not found",
        "WARN  Moving",
        "ERR_PNPM_PEER_DEP_ISSUES",
        "ERR_PNPM_LOCKFILE_BREAKING_CHANGE",
    ];

    for pattern in patterns {
        if content.contains(pattern) {
            return Some(Issue {
                pattern: "pnpm_install_failure".to_string(),
                root_cause: "pnpm installation failed".to_string(),
                suggested_fixes: vec![
                    "Install pnpm in preBuild: 'npm install -g pnpm'".to_string(),
                    "Run 'pnpm install' locally to update lock file".to_string(),
                    "Check pnpm version compatibility".to_string(),
                ],
            });
        }
    }

    None
}

/// Check for amplify.yml configuration errors
fn check_amplify_yml_error(content: &str) -> Option<Issue> {
    let patterns = [
        "amplify.yml",
        "buildspec",
        "YAMLException",
        "Invalid buildspec",
        "build specification",
    ];

    let error_indicators = ["error", "invalid", "failed to parse", "syntax"];

    for pattern in patterns {
        if content.to_lowercase().contains(&pattern.to_lowercase()) {
            for indicator in error_indicators {
                if content.to_lowercase().contains(indicator) {
                    return Some(Issue {
                        pattern: "amplify_yml_error".to_string(),
                        root_cause: "amplify.yml buildspec has configuration errors".to_string(),
                        suggested_fixes: vec![
                            "Validate YAML syntax in amplify.yml".to_string(),
                            "Check indentation (use spaces, not tabs)".to_string(),
                            "Verify all required phases are defined (preBuild, build, artifacts)"
                                .to_string(),
                            "Reference: https://docs.aws.amazon.com/amplify/latest/userguide/build-settings.html".to_string(),
                        ],
                    });
                }
            }
        }
    }

    None
}

/// Check for out-of-memory errors
fn check_out_of_memory(content: &str) -> Option<Issue> {
    let patterns = [
        "FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed",
        "FATAL ERROR: Ineffective mark-compacts",
        "JavaScript heap out of memory",
        "ENOMEM",
        "out of memory",
        "OOMKilled",
    ];

    for pattern in patterns {
        if content.to_lowercase().contains(&pattern.to_lowercase()) {
            return Some(Issue {
                pattern: "out_of_memory".to_string(),
                root_cause: "Build process ran out of memory".to_string(),
                suggested_fixes: vec![
                    "Add NODE_OPTIONS=--max_old_space_size=4096 to environment variables"
                        .to_string(),
                    "Optimize build by reducing bundle size".to_string(),
                    "Consider using a larger Amplify build instance".to_string(),
                ],
            });
        }
    }

    None
}

/// Check for timeout errors
fn check_timeout(content: &str) -> Option<Issue> {
    let patterns = [
        "timed out",
        "timeout",
        "Build timeout",
        "exceeded time limit",
        "ETIMEDOUT",
    ];

    for pattern in patterns {
        if content.to_lowercase().contains(&pattern.to_lowercase()) {
            return Some(Issue {
                pattern: "timeout".to_string(),
                root_cause: "Build exceeded time limit".to_string(),
                suggested_fixes: vec![
                    "Increase build timeout in Amplify console".to_string(),
                    "Optimize build steps to run faster".to_string(),
                    "Check for hanging processes or infinite loops".to_string(),
                    "Consider caching node_modules".to_string(),
                ],
            });
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

/// Check for yarn install failures
fn check_yarn_install_failure(content: &str) -> Option<Issue> {
    let patterns = [
        "error An unexpected error occurred",
        "yarn install",
        "YN0001",
        "YN0002",
        "YARN_",
        "yarn.lock",
    ];

    let error_indicators = ["error", "failed", "ENOENT", "EPERM"];

    for pattern in patterns {
        if content.contains(pattern) {
            for indicator in error_indicators {
                if content.to_lowercase().contains(&indicator.to_lowercase()) {
                    return Some(Issue {
                        pattern: "yarn_install_failure".to_string(),
                        root_cause: "Yarn installation failed".to_string(),
                        suggested_fixes: vec![
                            "Run 'yarn install' locally and commit yarn.lock".to_string(),
                            "Ensure yarn is installed in preBuild: 'npm install -g yarn'"
                                .to_string(),
                            "Check yarn version compatibility".to_string(),
                        ],
                    });
                }
            }
        }
    }

    None
}

/// Check for TypeScript compilation errors
fn check_typescript_error(content: &str) -> Option<Issue> {
    let patterns = [
        "error TS",
        "TS2304",
        "TS2307",
        "TS2345",
        "TS2339",
        "Cannot find module",
        "Type error:",
        "tsc exited with code",
    ];

    for pattern in patterns {
        if content.contains(pattern) {
            return Some(Issue {
                pattern: "typescript_error".to_string(),
                root_cause: "TypeScript compilation failed".to_string(),
                suggested_fixes: vec![
                    "Fix TypeScript errors locally before pushing".to_string(),
                    "Run 'npx tsc --noEmit' to check for errors".to_string(),
                    "Ensure all type definitions are installed (@types/*)".to_string(),
                    "Check tsconfig.json for correct configuration".to_string(),
                ],
            });
        }
    }

    None
}

/// Check for ESLint errors
fn check_eslint_error(content: &str) -> Option<Issue> {
    let patterns = ["eslint", "ESLint", "Parsing error:", "error  ", "✖ "];

    let error_indicators = ["problems", "error", "Rule:", "eslint-disable"];

    for pattern in patterns {
        if content.contains(pattern) {
            for indicator in error_indicators {
                if content.contains(indicator) && content.contains("eslint") {
                    return Some(Issue {
                        pattern: "eslint_error".to_string(),
                        root_cause: "ESLint validation failed".to_string(),
                        suggested_fixes: vec![
                            "Run 'npm run lint' or 'npx eslint .' locally".to_string(),
                            "Fix linting errors or adjust rules in .eslintrc".to_string(),
                            "Consider adding 'CI=false' to skip lint warnings as errors"
                                .to_string(),
                        ],
                    });
                }
            }
        }
    }

    None
}

/// Check for module not found errors
fn check_module_not_found(content: &str) -> Option<Issue> {
    let patterns = [
        "Module not found",
        "Cannot find module",
        "Module build failed",
        "ModuleNotFoundError",
        "Error: Cannot resolve",
    ];

    for pattern in patterns {
        if content.contains(pattern) {
            return Some(Issue {
                pattern: "module_not_found".to_string(),
                root_cause: "Required module/package not found".to_string(),
                suggested_fixes: vec![
                    "Ensure all dependencies are listed in package.json".to_string(),
                    "Check import paths for typos or case sensitivity".to_string(),
                    "Verify the module is not in devDependencies when needed in production"
                        .to_string(),
                    "Run 'npm install' to ensure all packages are installed".to_string(),
                ],
            });
        }
    }

    None
}

/// Check for permission denied errors
fn check_permission_denied(content: &str) -> Option<Issue> {
    let patterns = [
        "EACCES",
        "permission denied",
        "Permission denied",
        "EPERM",
        "operation not permitted",
    ];

    for pattern in patterns {
        if content.contains(pattern) {
            return Some(Issue {
                pattern: "permission_denied".to_string(),
                root_cause: "File system permission error".to_string(),
                suggested_fixes: vec![
                    "Avoid writing to read-only directories".to_string(),
                    "Use /tmp for temporary files in Amplify builds".to_string(),
                    "Check file permissions in repository".to_string(),
                ],
            });
        }
    }

    None
}

/// Check for network-related errors
fn check_network_error(content: &str) -> Option<Issue> {
    let patterns = [
        "ENOTFOUND",
        "ECONNREFUSED",
        "ECONNRESET",
        "EAI_AGAIN",
        "getaddrinfo",
        "network request failed",
        "socket hang up",
    ];

    for pattern in patterns {
        if content.contains(pattern) {
            return Some(Issue {
                pattern: "network_error".to_string(),
                root_cause: "Network connectivity issue during build".to_string(),
                suggested_fixes: vec![
                    "Retry the build - may be a transient network issue".to_string(),
                    "Check if npm registry or external services are accessible".to_string(),
                    "Consider using a private npm registry or cache".to_string(),
                ],
            });
        }
    }

    None
}

/// Check for Docker-related errors
fn check_docker_error(content: &str) -> Option<Issue> {
    let patterns = ["docker", "Dockerfile", "container", "DOCKER_"];

    let error_indicators = ["error", "failed", "not found", "denied"];

    for pattern in patterns {
        if content.to_lowercase().contains(&pattern.to_lowercase()) {
            for indicator in error_indicators {
                if content.to_lowercase().contains(indicator) {
                    return Some(Issue {
                        pattern: "docker_error".to_string(),
                        root_cause: "Docker/container build issue".to_string(),
                        suggested_fixes: vec![
                            "Verify Dockerfile syntax and base image availability".to_string(),
                            "Check Docker build context and .dockerignore".to_string(),
                            "Ensure Docker commands are supported in Amplify build environment"
                                .to_string(),
                        ],
                    });
                }
            }
        }
    }

    None
}

/// Check for Python-related errors (for builds with Python dependencies)
fn check_python_error(content: &str) -> Option<Issue> {
    let patterns = [
        "ModuleNotFoundError: No module named",
        "pip install",
        "python:",
        "SyntaxError:",
        "ImportError:",
    ];

    let error_indicators = ["error", "failed", "not found"];

    for pattern in patterns {
        if content.contains(pattern) {
            for indicator in error_indicators {
                if content.to_lowercase().contains(indicator) {
                    return Some(Issue {
                        pattern: "python_error".to_string(),
                        root_cause: "Python dependency or syntax error".to_string(),
                        suggested_fixes: vec![
                            "Add Python packages to requirements.txt".to_string(),
                            "Install Python dependencies in preBuild phase".to_string(),
                            "Verify Python version compatibility".to_string(),
                        ],
                    });
                }
            }
        }
    }

    None
}

/// Check for Next.js specific errors
fn check_next_js_error(content: &str) -> Option<Issue> {
    let patterns = [
        "next build",
        "Error occurred prerendering",
        "getStaticProps",
        "getServerSideProps",
        "next.config",
        "NEXT_",
    ];

    let error_indicators = ["error", "failed", "Error:"];

    for pattern in patterns {
        if content.contains(pattern) {
            for indicator in error_indicators {
                if content.contains(indicator) {
                    return Some(Issue {
                        pattern: "nextjs_error".to_string(),
                        root_cause: "Next.js build or configuration error".to_string(),
                        suggested_fixes: vec![
                            "Run 'npm run build' locally to reproduce the error".to_string(),
                            "Check getStaticProps/getServerSideProps for runtime errors"
                                .to_string(),
                            "Verify NEXT_PUBLIC_* environment variables are set".to_string(),
                            "Set baseDirectory to '.next' in amplify.yml artifacts".to_string(),
                        ],
                    });
                }
            }
        }
    }

    None
}

/// Check for Vite specific errors
fn check_vite_error(content: &str) -> Option<Issue> {
    let patterns = ["vite build", "vite:", "VITE_", "rollup", "esbuild"];

    let error_indicators = ["error", "failed", "Error:"];

    for pattern in patterns {
        if content.contains(pattern) {
            for indicator in error_indicators {
                if content.contains(indicator) {
                    return Some(Issue {
                        pattern: "vite_error".to_string(),
                        root_cause: "Vite build or bundling error".to_string(),
                        suggested_fixes: vec![
                            "Run 'npm run build' locally to reproduce".to_string(),
                            "Verify VITE_* environment variables are set in Amplify".to_string(),
                            "Set baseDirectory to 'dist' in amplify.yml artifacts".to_string(),
                            "Check vite.config.ts for build configuration issues".to_string(),
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
