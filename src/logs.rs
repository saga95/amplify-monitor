//! Log downloading and extraction
//!
//! Downloads Amplify build/deploy logs and extracts content.
//! Handles multiple formats: plain text, gzip, and ZIP archives.

use anyhow::{anyhow, Context, Result};
use aws_sdk_amplify::Client;
use flate2::read::GzDecoder;
use std::io::{Cursor, Read};
use zip::ZipArchive;

use crate::amplify;

/// Combined log content from BUILD and DEPLOY phases
#[derive(Debug, Default)]
pub struct LogContent {
    pub build_log: String,
    pub deploy_log: String,
    pub raw_content: String,
}

/// Download and extract job logs for a specific job
///
/// Amplify provides logs in various formats depending on the step.
/// This function downloads all available logs and returns the combined content.
pub async fn download_job_logs(
    client: &Client,
    app_id: &str,
    branch_name: &str,
    job_id: &str,
) -> Result<LogContent> {
    // Get all log URLs from the job steps
    let log_urls = amplify::get_all_log_urls(client, app_id, branch_name, job_id).await?;

    if log_urls.is_empty() {
        return Err(anyhow!("No log URLs found for job {}", job_id));
    }

    let mut log_content = LogContent::default();

    for (step_name, url) in log_urls {
        let content = download_and_extract_log(&url).await?;

        let step_lower = step_name.to_lowercase();
        if step_lower.contains("build") {
            log_content.build_log.push_str(&content);
            log_content.build_log.push('\n');
        } else if step_lower.contains("deploy") {
            log_content.deploy_log.push_str(&content);
            log_content.deploy_log.push('\n');
        }

        log_content
            .raw_content
            .push_str(&format!("=== {} ===\n", step_name));
        log_content.raw_content.push_str(&content);
        log_content.raw_content.push_str("\n\n");
    }

    Ok(log_content)
}

/// Download log from URL and extract based on content type
async fn download_and_extract_log(url: &str) -> Result<String> {
    let response = reqwest::get(url)
        .await
        .with_context(|| format!("Failed to download logs from {}", url))?;

    if !response.status().is_success() {
        return Err(anyhow!(
            "Failed to download logs: HTTP {}",
            response.status()
        ));
    }

    let bytes = response
        .bytes()
        .await
        .context("Failed to read log response body")?
        .to_vec();

    // Try to detect format and extract
    extract_log_content(&bytes)
}

/// Extract log content, trying multiple formats
fn extract_log_content(bytes: &[u8]) -> Result<String> {
    // Check for ZIP magic bytes (PK)
    if bytes.len() >= 4 && bytes[0] == 0x50 && bytes[1] == 0x4B {
        return extract_from_zip(bytes);
    }

    // Check for GZIP magic bytes
    if bytes.len() >= 2 && bytes[0] == 0x1F && bytes[1] == 0x8B {
        return extract_from_gzip(bytes);
    }

    // Assume plain text
    String::from_utf8(bytes.to_vec()).context("Failed to decode log as UTF-8 text")
}

/// Extract content from ZIP archive
fn extract_from_zip(zip_bytes: &[u8]) -> Result<String> {
    let cursor = Cursor::new(zip_bytes);
    let mut archive = ZipArchive::new(cursor).context("Failed to read ZIP archive")?;

    let mut content = String::new();

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .with_context(|| format!("Failed to read file at index {}", i))?;

        let mut file_content = String::new();
        file.read_to_string(&mut file_content)
            .with_context(|| format!("Failed to read content of {}", file.name()))?;

        content.push_str(&file_content);
        content.push('\n');
    }

    Ok(content)
}

/// Extract content from GZIP
fn extract_from_gzip(gzip_bytes: &[u8]) -> Result<String> {
    let mut decoder = GzDecoder::new(gzip_bytes);
    let mut content = String::new();
    decoder
        .read_to_string(&mut content)
        .context("Failed to decompress gzip log")?;
    Ok(content)
}
