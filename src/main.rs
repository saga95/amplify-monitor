mod amplify;
mod config;
mod logs;
mod migration;
mod parser;

use anyhow::{anyhow, Result};
use clap::{Parser, Subcommand, ValueEnum};
use config::Config;
use serde::Serialize;

#[derive(Parser)]
#[command(name = "amplify-monitor")]
#[command(about = "Monitor AWS Amplify builds and diagnose failures", long_about = None)]
struct Cli {
    /// Output format
    #[arg(long, short, value_enum)]
    format: Option<OutputFormat>,

    /// AWS region (overrides config and environment)
    #[arg(long, short)]
    region: Option<String>,

    /// AWS profile name (for multi-account access)
    #[arg(long, short)]
    profile: Option<String>,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Copy, Clone, PartialEq, Eq, ValueEnum)]
enum OutputFormat {
    /// JSON output (default, machine-readable)
    Json,
    /// Pretty-printed JSON with indentation
    JsonPretty,
    /// Compact text output for humans
    Text,
}

impl OutputFormat {
    fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "json" => Some(OutputFormat::Json),
            "json-pretty" | "jsonpretty" => Some(OutputFormat::JsonPretty),
            "text" => Some(OutputFormat::Text),
            _ => None,
        }
    }
}

#[derive(Subcommand)]
enum Commands {
    /// List all Amplify apps (in current region, use --region to change)
    Apps {
        /// Scan all common AWS regions for apps
        #[arg(long)]
        all_regions: bool,
    },

    /// List branches for an app
    Branches {
        /// The Amplify app ID (uses config default if not specified)
        #[arg(long)]
        app_id: Option<String>,
    },

    /// List jobs for a branch
    Jobs {
        /// The Amplify app ID (uses config default if not specified)
        #[arg(long)]
        app_id: Option<String>,

        /// The branch name (uses config default if not specified)
        #[arg(long)]
        branch: Option<String>,
    },

    /// Get the latest failed job for a branch
    LatestFailed {
        /// The Amplify app ID (uses config default if not specified)
        #[arg(long)]
        app_id: Option<String>,

        /// The branch name (uses config default if not specified)
        #[arg(long)]
        branch: Option<String>,
    },

    /// Diagnose a failed job by analyzing its logs
    Diagnose {
        /// The Amplify app ID (uses config default if not specified)
        #[arg(long)]
        app_id: Option<String>,

        /// The branch name (uses config default if not specified)
        #[arg(long)]
        branch: Option<String>,

        /// The job ID (optional, defaults to latest failed)
        #[arg(long)]
        job_id: Option<String>,

        /// Include raw build logs in output
        #[arg(long)]
        include_logs: bool,
    },

    /// Get raw build logs for a job
    Logs {
        /// The Amplify app ID (uses config default if not specified)
        #[arg(long)]
        app_id: Option<String>,

        /// The branch name (uses config default if not specified)
        #[arg(long)]
        branch: Option<String>,

        /// The job ID
        #[arg(long)]
        job_id: String,
    },

    /// List environment variables for a branch
    EnvVars {
        /// The Amplify app ID (uses config default if not specified)
        #[arg(long)]
        app_id: Option<String>,

        /// The branch name (uses config default if not specified)
        #[arg(long)]
        branch: Option<String>,
    },

    /// Set an environment variable for a branch
    SetEnv {
        /// The Amplify app ID (uses config default if not specified)
        #[arg(long)]
        app_id: Option<String>,

        /// The branch name (uses config default if not specified)
        #[arg(long)]
        branch: Option<String>,

        /// Environment variable name
        #[arg(long)]
        name: String,

        /// Environment variable value
        #[arg(long)]
        value: String,
    },

    /// Delete an environment variable from a branch
    DeleteEnv {
        /// The Amplify app ID (uses config default if not specified)
        #[arg(long)]
        app_id: Option<String>,

        /// The branch name (uses config default if not specified)
        #[arg(long)]
        branch: Option<String>,

        /// Environment variable name to delete
        #[arg(long)]
        name: String,
    },

    /// Start a new build for a branch
    StartBuild {
        /// The Amplify app ID (uses config default if not specified)
        #[arg(long)]
        app_id: Option<String>,

        /// The branch name (uses config default if not specified)
        #[arg(long)]
        branch: Option<String>,
    },

    /// Stop a running build
    StopBuild {
        /// The Amplify app ID (uses config default if not specified)
        #[arg(long)]
        app_id: Option<String>,

        /// The branch name (uses config default if not specified)
        #[arg(long)]
        branch: Option<String>,

        /// The job ID to stop
        #[arg(long)]
        job_id: String,
    },

    /// Analyze a project for Gen1 → Gen2 migration readiness
    MigrationAnalysis {
        /// Path to the project directory (defaults to current directory)
        #[arg(long, short)]
        path: Option<String>,
    },

    /// Initialize a config file with sample settings
    Init,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    // Load config file
    let config = Config::load().unwrap_or_default();

    // Determine output format (CLI > config > default)
    let format = cli
        .format
        .or_else(|| {
            config
                .default_format
                .as_ref()
                .and_then(|s| OutputFormat::from_str(s))
        })
        .unwrap_or(OutputFormat::Json);

    // Handle init command before AWS client creation
    if matches!(cli.command, Commands::Init) {
        let path = Config::create_sample()?;
        println!("Created config file at: {}", path.display());
        println!("Edit this file to set your default app ID and branch.");
        return Ok(());
    }

    // Initialize AWS client with region and profile
    let region_str = cli.region.as_deref().or(config.aws_region.as_deref());
    let profile_str = cli.profile.as_deref();
    let client = amplify::create_client(region_str, profile_str).await;
    let current_region = amplify::get_current_region(region_str, profile_str).await;

    match cli.command {
        Commands::Apps { all_regions } => {
            if all_regions {
                // Scan common AWS regions for Amplify apps
                let regions = vec![
                    "us-east-1",
                    "us-east-2",
                    "us-west-1",
                    "us-west-2",
                    "eu-west-1",
                    "eu-west-2",
                    "eu-central-1",
                    "ap-south-1",
                    "ap-southeast-1",
                    "ap-southeast-2",
                    "ap-northeast-1",
                    "sa-east-1",
                    "ca-central-1",
                ];

                let mut all_apps = Vec::new();
                for region in regions {
                    let client = amplify::create_client(Some(region), profile_str).await;
                    if let Ok(apps) = amplify::list_apps(&client, Some(region)).await {
                        all_apps.extend(apps);
                    }
                }
                output(&all_apps, format)?;
            } else {
                let apps = amplify::list_apps(&client, current_region.as_deref()).await?;
                output(&apps, format)?;
            }
        }

        Commands::Branches { app_id } => {
            let app_id = resolve_app_id(app_id, &config)?;
            let branches = amplify::list_branches(&client, &app_id).await?;
            output(&branches, format)?;
        }

        Commands::Jobs { app_id, branch } => {
            let app_id = resolve_app_id(app_id, &config)?;
            let branch = resolve_branch(branch, &config)?;
            let jobs = amplify::list_jobs(&client, &app_id, &branch).await?;
            output(&jobs, format)?;
        }

        Commands::LatestFailed { app_id, branch } => {
            let app_id = resolve_app_id(app_id, &config)?;
            let branch = resolve_branch(branch, &config)?;
            let job = amplify::latest_failed_job(&client, &app_id, &branch).await?;
            output(&job, format)?;
        }

        Commands::Diagnose {
            app_id,
            branch,
            job_id,
            include_logs,
        } => {
            let app_id = resolve_app_id(app_id, &config)?;
            let branch = resolve_branch(branch, &config)?;

            // Get the job to diagnose (specified or latest failed)
            let job = match job_id {
                Some(id) => amplify::get_job(&client, &app_id, &branch, &id).await?,
                None => amplify::latest_failed_job(&client, &app_id, &branch).await?,
            };

            // Download and extract logs
            let log_content =
                logs::download_job_logs(&client, &app_id, &branch, &job.job_id).await?;

            // Parse logs for failure patterns
            let issues = parser::analyze_logs(&log_content);

            // Build diagnosis output
            let diagnosis = DiagnosisResultWithLogs {
                app_id,
                branch,
                job_id: job.job_id,
                status: job.status,
                issues,
                raw_logs: if include_logs { Some(log_content.raw_content.clone()) } else { None },
            };

            output(&diagnosis, format)?;
        }

        Commands::Logs {
            app_id,
            branch,
            job_id,
        } => {
            let app_id = resolve_app_id(app_id, &config)?;
            let branch = resolve_branch(branch, &config)?;

            // Download and extract logs
            let log_content = logs::download_job_logs(&client, &app_id, &branch, &job_id).await?;

            let result = LogsResult {
                app_id,
                branch,
                job_id,
                logs: log_content.raw_content,
            };

            output(&result, format)?;
        }

        Commands::EnvVars { app_id, branch } => {
            let app_id = resolve_app_id(app_id, &config)?;
            let branch = resolve_branch(branch, &config)?;
            let env_vars = amplify::get_env_variables(&client, &app_id, &branch).await?;
            output(&env_vars, format)?;
        }

        Commands::SetEnv {
            app_id,
            branch,
            name,
            value,
        } => {
            let app_id = resolve_app_id(app_id, &config)?;
            let branch = resolve_branch(branch, &config)?;

            // Get existing env vars and add/update the new one
            let existing = amplify::get_env_variables(&client, &app_id, &branch).await?;
            let mut env_map: std::collections::HashMap<String, String> = existing
                .into_iter()
                .map(|e| (e.name, e.value))
                .collect();
            env_map.insert(name.clone(), value);

            amplify::update_env_variables(&client, &app_id, &branch, env_map).await?;

            let result = SetEnvResult {
                app_id,
                branch,
                name,
                success: true,
            };
            output(&result, format)?;
        }

        Commands::DeleteEnv {
            app_id,
            branch,
            name,
        } => {
            let app_id = resolve_app_id(app_id, &config)?;
            let branch = resolve_branch(branch, &config)?;

            // Get existing env vars and remove the specified one
            let existing = amplify::get_env_variables(&client, &app_id, &branch).await?;
            let env_map: std::collections::HashMap<String, String> = existing
                .into_iter()
                .filter(|e| e.name != name)
                .map(|e| (e.name, e.value))
                .collect();

            amplify::update_env_variables(&client, &app_id, &branch, env_map).await?;

            let result = DeleteEnvResult {
                app_id,
                branch,
                name,
                success: true,
            };
            output(&result, format)?;
        }

        Commands::StartBuild { app_id, branch } => {
            let app_id = resolve_app_id(app_id, &config)?;
            let branch = resolve_branch(branch, &config)?;
            let result = amplify::start_job(&client, &app_id, &branch).await?;
            output(&result, format)?;
        }

        Commands::StopBuild {
            app_id,
            branch,
            job_id,
        } => {
            let app_id = resolve_app_id(app_id, &config)?;
            let branch = resolve_branch(branch, &config)?;
            let result = amplify::stop_job(&client, &app_id, &branch, &job_id).await?;
            output(&result, format)?;
        }

        Commands::MigrationAnalysis { path } => {
            let project_path = path.unwrap_or_else(|| ".".to_string());
            let analysis = migration::analyze_project(&project_path)?;
            output(&analysis, format)?;
        }

        Commands::Init => unreachable!(), // Handled above
    }

    Ok(())
}

/// Resolve app_id from CLI arg or config
fn resolve_app_id(cli_arg: Option<String>, config: &Config) -> Result<String> {
    cli_arg
        .or_else(|| config.default_app_id.clone())
        .ok_or_else(|| {
            anyhow!(
            "No app ID specified. Use --app-id or set default_app_id in ~/.amplify-monitor.toml"
        )
        })
}

/// Resolve branch from CLI arg or config
fn resolve_branch(cli_arg: Option<String>, config: &Config) -> Result<String> {
    cli_arg
        .or_else(|| config.default_branch.clone())
        .ok_or_else(|| {
            anyhow!(
            "No branch specified. Use --branch or set default_branch in ~/.amplify-monitor.toml"
        )
        })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosisResult {
    app_id: String,
    branch: String,
    job_id: String,
    status: String,
    issues: Vec<parser::Issue>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosisResultWithLogs {
    app_id: String,
    branch: String,
    job_id: String,
    status: String,
    issues: Vec<parser::Issue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    raw_logs: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogsResult {
    app_id: String,
    branch: String,
    job_id: String,
    logs: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SetEnvResult {
    app_id: String,
    branch: String,
    name: String,
    success: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteEnvResult {
    app_id: String,
    branch: String,
    name: String,
    success: bool,
}

/// Output data in the requested format
fn output<T: Serialize + TextOutput>(data: &T, format: OutputFormat) -> Result<()> {
    match format {
        OutputFormat::Json => {
            println!("{}", serde_json::to_string(data)?);
        }
        OutputFormat::JsonPretty => {
            println!("{}", serde_json::to_string_pretty(data)?);
        }
        OutputFormat::Text => {
            println!("{}", data.to_text());
        }
    }
    Ok(())
}

/// Trait for text output formatting
trait TextOutput {
    fn to_text(&self) -> String;
}

impl TextOutput for Vec<amplify::AppSummary> {
    fn to_text(&self) -> String {
        if self.is_empty() {
            return "No apps found.".to_string();
        }
        let mut out = String::from("AMPLIFY APPS\n");
        out.push_str(&"─".repeat(60));
        out.push('\n');
        for app in self {
            out.push_str(&format!("• {} ({})\n", app.name, app.app_id));
            if let Some(ref repo) = app.repository {
                out.push_str(&format!("  Repository: {}\n", repo));
            }
            out.push_str(&format!("  Domain: {}\n", app.default_domain));
        }
        out
    }
}

impl TextOutput for Vec<amplify::BranchSummary> {
    fn to_text(&self) -> String {
        if self.is_empty() {
            return "No branches found.".to_string();
        }
        let mut out = String::from("BRANCHES\n");
        out.push_str(&"─".repeat(40));
        out.push('\n');
        for branch in self {
            out.push_str(&format!("• {} [{}]\n", branch.branch_name, branch.stage));
        }
        out
    }
}

impl TextOutput for Vec<amplify::JobSummary> {
    fn to_text(&self) -> String {
        if self.is_empty() {
            return "No jobs found.".to_string();
        }
        let mut out = String::from("JOBS\n");
        out.push_str(&"─".repeat(60));
        out.push('\n');
        for job in self {
            let status_icon = match job.status.as_str() {
                "SUCCEED" => "✓",
                "FAILED" => "✗",
                "RUNNING" => "⟳",
                _ => "•",
            };
            out.push_str(&format!(
                "{} {} - {}\n",
                status_icon, job.job_id, job.status
            ));
            if let Some(ref start) = job.start_time {
                out.push_str(&format!("  Started: {}\n", start));
            }
        }
        out
    }
}

impl TextOutput for amplify::JobSummary {
    fn to_text(&self) -> String {
        let mut out = String::from("JOB DETAILS\n");
        out.push_str(&"─".repeat(40));
        out.push('\n');
        out.push_str(&format!("Job ID: {}\n", self.job_id));
        out.push_str(&format!("Status: {}\n", self.status));
        if let Some(ref start) = self.start_time {
            out.push_str(&format!("Started: {}\n", start));
        }
        if let Some(ref end) = self.end_time {
            out.push_str(&format!("Ended: {}\n", end));
        }
        out
    }
}

impl TextOutput for DiagnosisResult {
    fn to_text(&self) -> String {
        let mut out = String::from("DIAGNOSIS REPORT\n");
        out.push_str(&"═".repeat(60));
        out.push('\n');
        out.push_str(&format!("App: {}\n", self.app_id));
        out.push_str(&format!("Branch: {}\n", self.branch));
        out.push_str(&format!("Job: {}\n", self.job_id));
        out.push_str(&format!("Status: {}\n", self.status));
        out.push('\n');

        if self.issues.is_empty() {
            out.push_str("No known failure patterns detected.\n");
        } else {
            out.push_str(&format!("ISSUES FOUND: {}\n", self.issues.len()));
            out.push_str(&"─".repeat(60));
            out.push('\n');

            for (i, issue) in self.issues.iter().enumerate() {
                out.push_str(&format!("\n{}. [{}]\n", i + 1, issue.pattern));
                out.push_str(&format!("   Cause: {}\n", issue.root_cause));
                out.push_str("   Fixes:\n");
                for fix in &issue.suggested_fixes {
                    out.push_str(&format!("   → {}\n", fix));
                }
            }
        }
        out
    }
}

impl TextOutput for DiagnosisResultWithLogs {
    fn to_text(&self) -> String {
        let mut out = String::from("DIAGNOSIS REPORT\n");
        out.push_str(&"═".repeat(60));
        out.push('\n');
        out.push_str(&format!("App: {}\n", self.app_id));
        out.push_str(&format!("Branch: {}\n", self.branch));
        out.push_str(&format!("Job: {}\n", self.job_id));
        out.push_str(&format!("Status: {}\n", self.status));
        out.push('\n');

        if self.issues.is_empty() {
            out.push_str("No known failure patterns detected.\n");
        } else {
            out.push_str(&format!("ISSUES FOUND: {}\n", self.issues.len()));
            out.push_str(&"─".repeat(60));
            out.push('\n');

            for (i, issue) in self.issues.iter().enumerate() {
                out.push_str(&format!("\n{}. [{}]\n", i + 1, issue.pattern));
                out.push_str(&format!("   Cause: {}\n", issue.root_cause));
                out.push_str("   Fixes:\n");
                for fix in &issue.suggested_fixes {
                    out.push_str(&format!("   → {}\n", fix));
                }
            }
        }

        if let Some(logs) = &self.raw_logs {
            out.push_str("\n");
            out.push_str(&"─".repeat(60));
            out.push_str("\nRAW LOGS:\n");
            out.push_str(&"─".repeat(60));
            out.push('\n');
            out.push_str(logs);
        }
        out
    }
}

impl TextOutput for LogsResult {
    fn to_text(&self) -> String {
        let mut out = format!("BUILD LOGS - Job {}\n", self.job_id);
        out.push_str(&format!("App: {} | Branch: {}\n", self.app_id, self.branch));
        out.push_str(&"═".repeat(60));
        out.push('\n');
        out.push_str(&self.logs);
        out
    }
}

impl TextOutput for Vec<amplify::EnvVariable> {
    fn to_text(&self) -> String {
        if self.is_empty() {
            return "No environment variables found.".to_string();
        }
        let mut out = String::from("ENVIRONMENT VARIABLES\n");
        out.push_str(&"─".repeat(60));
        out.push('\n');
        for env in self {
            out.push_str(&format!("• {} = {}\n", env.name, mask_value(&env.value)));
        }
        out
    }
}

impl TextOutput for SetEnvResult {
    fn to_text(&self) -> String {
        format!(
            "✓ Set {} on {}/{}\n",
            self.name, self.app_id, self.branch
        )
    }
}

impl TextOutput for DeleteEnvResult {
    fn to_text(&self) -> String {
        format!(
            "✓ Deleted {} from {}/{}\n",
            self.name, self.app_id, self.branch
        )
    }
}

impl TextOutput for amplify::StartJobResult {
    fn to_text(&self) -> String {
        format!(
            "✓ Started build job {}\n  Status: {}\n",
            self.job_id, self.status
        )
    }
}

impl TextOutput for amplify::StopJobResult {
    fn to_text(&self) -> String {
        format!(
            "✓ Stopped build job {}\n  Status: {}\n",
            self.job_id, self.status
        )
    }
}

impl TextOutput for migration::MigrationAnalysis {
    fn to_text(&self) -> String {
        migration::generate_report(self)
    }
}

/// Mask sensitive values for display
fn mask_value(value: &str) -> String {
    if value.len() <= 4 {
        "****".to_string()
    } else {
        format!("{}****", &value[..4])
    }
}
