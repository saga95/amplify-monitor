mod amplify;
mod config;
mod logs;
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
    /// List all Amplify apps
    Apps,

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

    // Initialize AWS client
    let client = amplify::create_client().await;

    match cli.command {
        Commands::Apps => {
            let apps = amplify::list_apps(&client).await?;
            output(&apps, format)?;
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
            let diagnosis = DiagnosisResult {
                app_id,
                branch,
                job_id: job.job_id,
                status: job.status,
                issues,
            };

            output(&diagnosis, format)?;
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
