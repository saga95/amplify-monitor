//! Configuration file support
//!
//! Loads user settings from ~/.amplify-monitor.toml

use anyhow::Result;
use serde::Deserialize;
use std::path::PathBuf;

/// User configuration loaded from config file
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct Config {
    /// Default app ID to use when --app-id is not specified
    pub default_app_id: Option<String>,

    /// Default branch to use when --branch is not specified
    pub default_branch: Option<String>,

    /// Default output format (json, json-pretty, text)
    pub default_format: Option<String>,

    /// AWS region override
    pub aws_region: Option<String>,
}

impl Config {
    /// Load configuration from the default config file location
    pub fn load() -> Result<Self> {
        let config_path = Self::config_path();

        if !config_path.exists() {
            return Ok(Config::default());
        }

        let content = std::fs::read_to_string(&config_path)?;
        let config: Config = toml::from_str(&content)?;
        Ok(config)
    }

    /// Get the default config file path (~/.amplify-monitor.toml)
    pub fn config_path() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".amplify-monitor.toml")
    }

    /// Create a sample config file
    pub fn create_sample() -> Result<PathBuf> {
        let path = Self::config_path();
        let sample = r#"# amplify-monitor configuration
# Place this file at ~/.amplify-monitor.toml

# Default app ID (find with `amplify-monitor apps`)
# default_app_id = "d1234567890"

# Default branch name
# default_branch = "main"

# Default output format: json, json-pretty, or text
# default_format = "json-pretty"

# AWS region (overrides AWS_REGION env var)
# aws_region = "us-east-1"
"#;
        std::fs::write(&path, sample)?;
        Ok(path)
    }
}
