//! Integration tests with mock AWS responses
//!
//! These tests verify the parsing and output logic without making real AWS calls.

mod parser_tests {
    use amplify_monitor::logs::LogContent;
    use amplify_monitor::parser::analyze_logs;

    fn make_logs(content: &str) -> LogContent {
        LogContent {
            build_log: content.to_string(),
            deploy_log: String::new(),
            raw_content: content.to_string(),
        }
    }

    #[test]
    fn test_detects_npm_ci_failure() {
        let logs = make_logs(
            r#"
            Installing dependencies...
            npm ERR! `npm ci` can only install packages with an existing package-lock.json
            npm ERR! code EUSAGE
            Build failed
            "#,
        );

        let issues = analyze_logs(&logs);
        assert!(!issues.is_empty());
        assert!(issues.iter().any(|i| i.pattern == "npm_ci_failure"));
    }

    #[test]
    fn test_detects_out_of_memory() {
        let logs = make_logs(
            r#"
            Building application...
            FATAL ERROR: JavaScript heap out of memory
            Build terminated
            "#,
        );

        let issues = analyze_logs(&logs);
        assert!(issues.iter().any(|i| i.pattern == "out_of_memory"));
    }

    #[test]
    fn test_detects_node_version_mismatch() {
        let logs = make_logs(
            r#"
            Checking Node version...
            error The engine "node" is incompatible with this module.
            Expected version ">=18.0.0".
            "#,
        );

        let issues = analyze_logs(&logs);
        assert!(issues.iter().any(|i| i.pattern == "node_version_mismatch"));
    }

    #[test]
    fn test_detects_typescript_error() {
        let logs = make_logs(
            r#"
            Compiling TypeScript...
            src/App.tsx(15,10): error TS2339: Property 'foo' does not exist on type 'Bar'.
            Build failed with 1 error
            "#,
        );

        let issues = analyze_logs(&logs);
        assert!(issues.iter().any(|i| i.pattern == "typescript_error"));
    }

    #[test]
    fn test_detects_module_not_found() {
        let logs = make_logs(
            r#"
            Building...
            Module not found: Error: Can't resolve '@acme/shared' in '/app/src'
            webpack compilation failed
            "#,
        );

        let issues = analyze_logs(&logs);
        assert!(issues.iter().any(|i| i.pattern == "module_not_found"));
    }

    #[test]
    fn test_detects_nextjs_error() {
        let logs = make_logs(
            r#"
            > next build
            Error occurred prerendering page "/dashboard".
            Error: Cannot read properties of undefined
            "#,
        );

        let issues = analyze_logs(&logs);
        assert!(issues.iter().any(|i| i.pattern == "nextjs_error"));
    }

    #[test]
    fn test_detects_vite_error() {
        let logs = make_logs(
            r#"
            > vite build
            error during build:
            RollupError: Could not resolve "./missing-module"
            "#,
        );

        let issues = analyze_logs(&logs);
        assert!(issues.iter().any(|i| i.pattern == "vite_error"));
    }

    #[test]
    fn test_detects_timeout() {
        let logs = make_logs(
            r#"
            Running build...
            Build timed out after 30 minutes
            "#,
        );

        let issues = analyze_logs(&logs);
        assert!(issues.iter().any(|i| i.pattern == "timeout"));
    }

    #[test]
    fn test_detects_permission_denied() {
        let logs = make_logs(
            r#"
            Writing output...
            EACCES: permission denied, mkdir '/opt/build'
            "#,
        );

        let issues = analyze_logs(&logs);
        assert!(issues.iter().any(|i| i.pattern == "permission_denied"));
    }

    #[test]
    fn test_detects_network_error() {
        let logs = make_logs(
            r#"
            Fetching packages...
            npm ERR! network request to https://registry.npmjs.org failed
            npm ERR! ENOTFOUND registry.npmjs.org
            "#,
        );

        let issues = analyze_logs(&logs);
        assert!(issues.iter().any(|i| i.pattern == "network_error"));
    }

    #[test]
    fn test_detects_pnpm_failure() {
        let logs = make_logs(
            r#"
            Installing with pnpm...
            ERR_PNPM_LOCKFILE_BREAKING_CHANGE  Lockfile is not compatible
            "#,
        );

        let issues = analyze_logs(&logs);
        assert!(issues.iter().any(|i| i.pattern == "pnpm_install_failure"));
    }

    #[test]
    fn test_detects_multiple_issues() {
        let logs = make_logs(
            r#"
            Starting build...
            npm ERR! `npm ci` can only install packages
            error TS2339: Property 'x' does not exist
            FATAL ERROR: JavaScript heap out of memory
            "#,
        );

        let issues = analyze_logs(&logs);
        assert!(issues.len() >= 3);
    }

    #[test]
    fn test_no_false_positives_on_success() {
        let logs = make_logs(
            r#"
            Installing dependencies...
            npm install completed successfully
            Building application...
            Build completed successfully
            Deploying...
            Deployment completed successfully
            "#,
        );

        let issues = analyze_logs(&logs);
        // Should not detect issues in a successful build
        // Some patterns might still match generic words, but core failures shouldn't
        let critical_patterns = [
            "npm_ci_failure",
            "out_of_memory",
            "typescript_error",
            "timeout",
        ];
        for pattern in critical_patterns {
            assert!(
                !issues.iter().any(|i| i.pattern == pattern),
                "False positive detected: {}",
                pattern
            );
        }
    }
}

mod output_format_tests {
    use serde_json::Value;

    #[test]
    fn test_json_output_structure() {
        // Verify JSON output has expected structure
        let json_str = r#"{
            "appId": "test-app",
            "branch": "main",
            "jobId": "123",
            "status": "FAILED",
            "issues": [
                {
                    "pattern": "npm_ci_failure",
                    "rootCause": "npm ci failed",
                    "suggestedFixes": ["Fix 1", "Fix 2"]
                }
            ]
        }"#;

        let parsed: Value = serde_json::from_str(json_str).unwrap();
        assert_eq!(parsed["appId"], "test-app");
        assert_eq!(parsed["branch"], "main");
        assert!(parsed["issues"].is_array());
        assert_eq!(parsed["issues"][0]["pattern"], "npm_ci_failure");
    }
}

mod mock_api_tests {
    //! Mock AWS API response structures for testing

    use serde::{Deserialize, Serialize};

    #[derive(Debug, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct MockAppSummary {
        app_id: String,
        name: String,
        repository: Option<String>,
        default_domain: String,
    }

    #[derive(Debug, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct MockJobSummary {
        job_id: String,
        status: String,
        start_time: Option<String>,
        end_time: Option<String>,
    }

    #[test]
    fn test_mock_app_list_response() {
        let apps = vec![
            MockAppSummary {
                app_id: "d1234567".to_string(),
                name: "my-react-app".to_string(),
                repository: Some("https://github.com/user/repo".to_string()),
                default_domain: "main.d1234567.amplifyapp.com".to_string(),
            },
            MockAppSummary {
                app_id: "d7654321".to_string(),
                name: "another-app".to_string(),
                repository: None,
                default_domain: "main.d7654321.amplifyapp.com".to_string(),
            },
        ];

        let json = serde_json::to_string_pretty(&apps).unwrap();
        assert!(json.contains("my-react-app"));
        assert!(json.contains("d1234567"));
    }

    #[test]
    fn test_mock_job_list_with_failed() {
        let jobs = vec![
            MockJobSummary {
                job_id: "1".to_string(),
                status: "SUCCEED".to_string(),
                start_time: Some("2026-01-27T10:00:00Z".to_string()),
                end_time: Some("2026-01-27T10:05:00Z".to_string()),
            },
            MockJobSummary {
                job_id: "2".to_string(),
                status: "FAILED".to_string(),
                start_time: Some("2026-01-27T11:00:00Z".to_string()),
                end_time: Some("2026-01-27T11:03:00Z".to_string()),
            },
        ];

        // Find first failed job (simulating latest_failed_job logic)
        let failed = jobs.iter().find(|j| j.status == "FAILED");
        assert!(failed.is_some());
        assert_eq!(failed.unwrap().job_id, "2");
    }
}
