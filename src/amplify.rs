//! AWS Amplify API interactions
//!
//! Provides functions to list apps, branches, jobs, and retrieve job details.

use anyhow::{anyhow, Context, Result};
use aws_config::BehaviorVersion;
use aws_sdk_amplify::Client;
use serde::Serialize;

/// Summary of an Amplify app
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSummary {
    pub app_id: String,
    pub name: String,
    pub repository: Option<String>,
    pub default_domain: String,
}

/// Summary of a branch
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchSummary {
    pub branch_name: String,
    pub display_name: String,
    pub stage: String,
}

/// Summary of a job
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSummary {
    pub job_id: String,
    pub status: String,
    pub start_time: Option<String>,
    pub end_time: Option<String>,
}

/// Create an AWS Amplify client using environment credentials
pub async fn create_client() -> Client {
    let config = aws_config::load_defaults(BehaviorVersion::latest()).await;
    Client::new(&config)
}

/// List all Amplify apps in the account
pub async fn list_apps(client: &Client) -> Result<Vec<AppSummary>> {
    let response = client
        .list_apps()
        .send()
        .await
        .context("Failed to list Amplify apps")?;

    let apps = response
        .apps
        .into_iter()
        .map(|app| AppSummary {
            app_id: app.app_id,
            name: app.name,
            repository: Some(app.repository),
            default_domain: app.default_domain,
        })
        .collect();

    Ok(apps)
}

/// List all branches for an Amplify app
pub async fn list_branches(client: &Client, app_id: &str) -> Result<Vec<BranchSummary>> {
    let response = client
        .list_branches()
        .app_id(app_id)
        .send()
        .await
        .with_context(|| format!("Failed to list branches for app {}", app_id))?;

    let branches = response
        .branches
        .into_iter()
        .map(|branch| BranchSummary {
            branch_name: branch.branch_name,
            display_name: branch.display_name,
            stage: branch.stage.as_str().to_string(),
        })
        .collect();

    Ok(branches)
}

/// List jobs for a branch
pub async fn list_jobs(
    client: &Client,
    app_id: &str,
    branch_name: &str,
) -> Result<Vec<JobSummary>> {
    let response = client
        .list_jobs()
        .app_id(app_id)
        .branch_name(branch_name)
        .send()
        .await
        .with_context(|| format!("Failed to list jobs for {}/{}", app_id, branch_name))?;

    let jobs = response
        .job_summaries
        .into_iter()
        .map(|job| JobSummary {
            job_id: job.job_id,
            status: job.status.as_str().to_string(),
            start_time: Some(job.start_time.to_string()),
            end_time: job.end_time.map(|t| t.to_string()),
        })
        .collect();

    Ok(jobs)
}

/// Find the most recent job with status FAILED for a branch
pub async fn latest_failed_job(
    client: &Client,
    app_id: &str,
    branch_name: &str,
) -> Result<JobSummary> {
    let jobs = list_jobs(client, app_id, branch_name).await?;

    jobs.into_iter()
        .find(|job| job.status == "FAILED")
        .ok_or_else(|| anyhow!("No failed jobs found for {}/{}", app_id, branch_name))
}

/// Get a specific job by ID
pub async fn get_job(
    client: &Client,
    app_id: &str,
    branch_name: &str,
    job_id: &str,
) -> Result<JobSummary> {
    let response = client
        .get_job()
        .app_id(app_id)
        .branch_name(branch_name)
        .job_id(job_id)
        .send()
        .await
        .with_context(|| {
            format!(
                "Failed to get job {} for {}/{}",
                job_id, app_id, branch_name
            )
        })?;

    let job = response.job.ok_or_else(|| anyhow!("Job not found"))?;

    let summary = job
        .summary
        .ok_or_else(|| anyhow!("Job summary not found"))?;

    Ok(JobSummary {
        job_id: summary.job_id,
        status: summary.status.as_str().to_string(),
        start_time: Some(summary.start_time.to_string()),
        end_time: summary.end_time.map(|t| t.to_string()),
    })
}

/// Get all log URLs from all job steps
pub async fn get_all_log_urls(
    client: &Client,
    app_id: &str,
    branch_name: &str,
    job_id: &str,
) -> Result<Vec<(String, String)>> {
    let response = client
        .get_job()
        .app_id(app_id)
        .branch_name(branch_name)
        .job_id(job_id)
        .send()
        .await
        .with_context(|| format!("Failed to get job details for {}", job_id))?;

    let job = response.job.ok_or_else(|| anyhow!("Job not found"))?;

    let mut urls = Vec::new();
    for step in job.steps {
        if let Some(url) = step.log_url {
            let step_name = step.step_name.as_str().to_string();
            urls.push((step_name, url));
        }
    }

    Ok(urls)
}
