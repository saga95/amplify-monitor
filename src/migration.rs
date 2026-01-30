use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

/// Represents the generation of an Amplify project
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum AmplifyGeneration {
    Gen1,
    Gen2,
    Unknown,
}

/// Migration compatibility status
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum CompatibilityStatus {
    /// Fully supported in Gen2
    Supported,
    /// Supported with CDK customization
    SupportedWithCdk,
    /// Not supported, alternative available
    NotSupported { alternative: String },
    /// Requires manual migration
    ManualMigration { reason: String },
}

/// A detected Gen1 feature in the project
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedFeature {
    pub category: String,
    pub feature: String,
    pub file_path: Option<String>,
    pub line_number: Option<usize>,
    pub compatibility: CompatibilityStatus,
    pub migration_hint: String,
}

/// Overall migration analysis result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigrationAnalysis {
    pub generation: AmplifyGeneration,
    pub project_path: String,
    pub categories_detected: Vec<String>,
    pub features: Vec<DetectedFeature>,
    pub ready_for_migration: bool,
    pub blocking_issues: Vec<String>,
    pub warnings: Vec<String>,
    pub summary: MigrationSummary,
}

/// Summary statistics for migration readiness
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigrationSummary {
    pub total_features: usize,
    pub fully_supported: usize,
    pub supported_with_cdk: usize,
    pub not_supported: usize,
    pub manual_migration: usize,
}

impl MigrationAnalysis {
    pub fn new(project_path: &str) -> Self {
        Self {
            generation: AmplifyGeneration::Unknown,
            project_path: project_path.to_string(),
            categories_detected: Vec::new(),
            features: Vec::new(),
            ready_for_migration: true,
            blocking_issues: Vec::new(),
            warnings: Vec::new(),
            summary: MigrationSummary {
                total_features: 0,
                fully_supported: 0,
                supported_with_cdk: 0,
                not_supported: 0,
                manual_migration: 0,
            },
        }
    }

    pub fn compute_summary(&mut self) {
        self.summary.total_features = self.features.len();
        self.summary.fully_supported = self.features.iter()
            .filter(|f| matches!(f.compatibility, CompatibilityStatus::Supported))
            .count();
        self.summary.supported_with_cdk = self.features.iter()
            .filter(|f| matches!(f.compatibility, CompatibilityStatus::SupportedWithCdk))
            .count();
        self.summary.not_supported = self.features.iter()
            .filter(|f| matches!(f.compatibility, CompatibilityStatus::NotSupported { .. }))
            .count();
        self.summary.manual_migration = self.features.iter()
            .filter(|f| matches!(f.compatibility, CompatibilityStatus::ManualMigration { .. }))
            .count();
        
        // Determine if ready for migration
        self.ready_for_migration = self.blocking_issues.is_empty() 
            && self.summary.not_supported == 0;
    }
}

/// Analyze a project directory for Amplify Gen1 patterns
pub fn analyze_project(project_path: &str) -> anyhow::Result<MigrationAnalysis> {
    let mut analysis = MigrationAnalysis::new(project_path);
    let path = Path::new(project_path);
    
    // Check for Gen1 amplify folder
    let amplify_path = path.join("amplify");
    let gen2_path = path.join("amplify").join("backend.ts");
    let gen2_alt_path = path.join("amplify").join("backend").join("backend.ts");
    
    if gen2_path.exists() || gen2_alt_path.exists() {
        analysis.generation = AmplifyGeneration::Gen2;
        return Ok(analysis);
    }
    
    if !amplify_path.exists() {
        analysis.generation = AmplifyGeneration::Unknown;
        analysis.warnings.push("No amplify/ folder found. This may not be an Amplify project.".to_string());
        return Ok(analysis);
    }
    
    analysis.generation = AmplifyGeneration::Gen1;
    
    // Analyze backend-config.json for categories
    let backend_config_path = amplify_path.join("backend").join("backend-config.json");
    if backend_config_path.exists() {
        analyze_backend_config(&backend_config_path, &mut analysis)?;
    }
    
    // Analyze GraphQL schema
    let schema_path = amplify_path.join("backend").join("api");
    if schema_path.exists() {
        analyze_graphql_api(&schema_path, &mut analysis)?;
    }
    
    // Analyze Auth configuration
    let auth_path = amplify_path.join("backend").join("auth");
    if auth_path.exists() {
        analyze_auth(&auth_path, &mut analysis)?;
        analysis.categories_detected.push("auth".to_string());
    }
    
    // Analyze Storage configuration
    let storage_path = amplify_path.join("backend").join("storage");
    if storage_path.exists() {
        analyze_storage(&storage_path, &mut analysis)?;
        analysis.categories_detected.push("storage".to_string());
    }
    
    // Analyze Functions
    let function_path = amplify_path.join("backend").join("function");
    if function_path.exists() {
        analyze_functions(&function_path, &mut analysis)?;
        analysis.categories_detected.push("function".to_string());
    }
    
    // Check for other Gen1-specific patterns
    check_deprecated_patterns(&amplify_path, &mut analysis)?;
    
    analysis.compute_summary();
    Ok(analysis)
}

fn analyze_backend_config(path: &Path, analysis: &mut MigrationAnalysis) -> anyhow::Result<()> {
    let content = std::fs::read_to_string(path)?;
    let config: serde_json::Value = serde_json::from_str(&content)?;
    
    if let Some(obj) = config.as_object() {
        for (category, _) in obj {
            if !analysis.categories_detected.contains(category) {
                analysis.categories_detected.push(category.clone());
            }
        }
    }
    
    Ok(())
}

fn analyze_graphql_api(api_path: &Path, analysis: &mut MigrationAnalysis) -> anyhow::Result<()> {
    analysis.categories_detected.push("api".to_string());
    
    // Find schema.graphql files
    for entry in std::fs::read_dir(api_path)? {
        let entry = entry?;
        let path = entry.path();
        
        if path.is_dir() {
            let schema_path = path.join("schema.graphql");
            if schema_path.exists() {
                analyze_graphql_schema(&schema_path, analysis)?;
            }
        }
    }
    
    Ok(())
}

fn analyze_graphql_schema(schema_path: &Path, analysis: &mut MigrationAnalysis) -> anyhow::Result<()> {
    let content = std::fs::read_to_string(schema_path)?;
    let file_path = schema_path.to_string_lossy().to_string();
    
    // Check for @searchable directive (not supported in Gen2)
    if content.contains("@searchable") {
        analysis.features.push(DetectedFeature {
            category: "api".to_string(),
            feature: "@searchable directive".to_string(),
            file_path: Some(file_path.clone()),
            line_number: find_line_number(&content, "@searchable"),
            compatibility: CompatibilityStatus::NotSupported {
                alternative: "Use Zero-ETL DynamoDB-to-OpenSearch integration".to_string(),
            },
            migration_hint: "Replace @searchable with Zero-ETL DynamoDB-to-OpenSearch. See: https://docs.amplify.aws/react/build-a-backend/data/connect-to-existing-data-sources/".to_string(),
        });
        analysis.blocking_issues.push("@searchable directive is not supported in Gen2".to_string());
    }
    
    // Check for @predictions directive
    if content.contains("@predictions") {
        analysis.features.push(DetectedFeature {
            category: "api".to_string(),
            feature: "@predictions directive".to_string(),
            file_path: Some(file_path.clone()),
            line_number: find_line_number(&content, "@predictions"),
            compatibility: CompatibilityStatus::NotSupported {
                alternative: "Use AI service integrations directly".to_string(),
            },
            migration_hint: "Gen2 offers AI service integrations instead of @predictions. See Bedrock and other AI integrations.".to_string(),
        });
        analysis.blocking_issues.push("@predictions directive is not supported in Gen2".to_string());
    }
    
    // Check for @model directive (supported)
    if content.contains("@model") {
        analysis.features.push(DetectedFeature {
            category: "api".to_string(),
            feature: "@model directive".to_string(),
            file_path: Some(file_path.clone()),
            line_number: find_line_number(&content, "@model"),
            compatibility: CompatibilityStatus::Supported,
            migration_hint: "Models are fully supported in Gen2. Use defineData() with a.model() in your schema.".to_string(),
        });
    }
    
    // Check for @manyToMany (not supported)
    if content.contains("@manyToMany") {
        analysis.features.push(DetectedFeature {
            category: "api".to_string(),
            feature: "@manyToMany directive".to_string(),
            file_path: Some(file_path.clone()),
            line_number: find_line_number(&content, "@manyToMany"),
            compatibility: CompatibilityStatus::ManualMigration {
                reason: "Implement with intermediate join table".to_string(),
            },
            migration_hint: "Gen2 doesn't have @manyToMany. Create an intermediate model to represent the relationship.".to_string(),
        });
        analysis.warnings.push("@manyToMany requires manual migration with join table".to_string());
    }
    
    // Check for DataStore patterns
    if content.contains("@versioned") || content.contains("_version") {
        analysis.features.push(DetectedFeature {
            category: "api".to_string(),
            feature: "DataStore / Conflict Resolution".to_string(),
            file_path: Some(file_path.clone()),
            line_number: None,
            compatibility: CompatibilityStatus::NotSupported {
                alternative: "DataStore migration guide coming soon".to_string(),
            },
            migration_hint: "DataStore is not yet supported in Gen2. Continue using Gen1 if DataStore is critical.".to_string(),
        });
        analysis.blocking_issues.push("DataStore is not supported in Gen2".to_string());
    }
    
    // Check for custom resolvers
    if content.contains("@function") {
        analysis.features.push(DetectedFeature {
            category: "api".to_string(),
            feature: "@function resolver".to_string(),
            file_path: Some(file_path.clone()),
            line_number: find_line_number(&content, "@function"),
            compatibility: CompatibilityStatus::Supported,
            migration_hint: "Function resolvers are supported in Gen2. Use a.handler.function() in your schema.".to_string(),
        });
    }
    
    // Check for @auth directives
    if content.contains("@auth") {
        analysis.features.push(DetectedFeature {
            category: "api".to_string(),
            feature: "@auth directive".to_string(),
            file_path: Some(file_path.clone()),
            line_number: find_line_number(&content, "@auth"),
            compatibility: CompatibilityStatus::Supported,
            migration_hint: "Auth rules are supported in Gen2. Use .authorization() on your models.".to_string(),
        });
    }
    
    // Check for @http directive
    if content.contains("@http") {
        analysis.features.push(DetectedFeature {
            category: "api".to_string(),
            feature: "@http directive".to_string(),
            file_path: Some(file_path.clone()),
            line_number: find_line_number(&content, "@http"),
            compatibility: CompatibilityStatus::Supported,
            migration_hint: "HTTP data sources are supported via custom data sources in Gen2.".to_string(),
        });
    }
    
    Ok(())
}

fn analyze_auth(auth_path: &Path, analysis: &mut MigrationAnalysis) -> anyhow::Result<()> {
    // Check for cli-inputs.json
    for entry in std::fs::read_dir(auth_path)? {
        let entry = entry?;
        let path = entry.path();
        
        if path.is_dir() {
            let cli_inputs = path.join("cli-inputs.json");
            if cli_inputs.exists() {
                let content = std::fs::read_to_string(&cli_inputs)?;
                let file_path = cli_inputs.to_string_lossy().to_string();
                
                // Check for features that need CDK in Gen2
                if content.contains("\"adminQueries\"") || content.contains("adminQueries") {
                    analysis.features.push(DetectedFeature {
                        category: "auth".to_string(),
                        feature: "Admin Queries".to_string(),
                        file_path: Some(file_path.clone()),
                        line_number: None,
                        compatibility: CompatibilityStatus::SupportedWithCdk,
                        migration_hint: "Admin queries require CDK customization in Gen2.".to_string(),
                    });
                }
                
                // MFA configuration
                if content.contains("\"mfaConfiguration\"") {
                    analysis.features.push(DetectedFeature {
                        category: "auth".to_string(),
                        feature: "MFA Configuration".to_string(),
                        file_path: Some(file_path.clone()),
                        line_number: None,
                        compatibility: CompatibilityStatus::Supported,
                        migration_hint: "MFA is fully supported in Gen2 with defineAuth().".to_string(),
                    });
                }
                
                // OAuth/Social providers
                if content.contains("\"hostedUI\"") || content.contains("\"oAuth\"") {
                    analysis.features.push(DetectedFeature {
                        category: "auth".to_string(),
                        feature: "OAuth/Social Login".to_string(),
                        file_path: Some(file_path.clone()),
                        line_number: None,
                        compatibility: CompatibilityStatus::Supported,
                        migration_hint: "OAuth and social logins are supported. Gen2 has first-class OIDC and SAML support.".to_string(),
                    });
                }
                
                // Custom auth triggers
                if content.contains("\"triggers\"") {
                    analysis.features.push(DetectedFeature {
                        category: "auth".to_string(),
                        feature: "Auth Triggers".to_string(),
                        file_path: Some(file_path.clone()),
                        line_number: None,
                        compatibility: CompatibilityStatus::Supported,
                        migration_hint: "Auth triggers are supported in Gen2. Define them with triggers property in defineAuth().".to_string(),
                    });
                }
            }
        }
    }
    
    Ok(())
}

fn analyze_storage(storage_path: &Path, analysis: &mut MigrationAnalysis) -> anyhow::Result<()> {
    analysis.features.push(DetectedFeature {
        category: "storage".to_string(),
        feature: "S3 Storage".to_string(),
        file_path: Some(storage_path.to_string_lossy().to_string()),
        line_number: None,
        compatibility: CompatibilityStatus::Supported,
        migration_hint: "S3 storage is fully supported in Gen2. Use defineStorage() to configure.".to_string(),
    });
    
    // Check for Lambda triggers
    for entry in std::fs::read_dir(storage_path)? {
        let entry = entry?;
        let path = entry.path();
        
        if path.is_dir() {
            let cli_inputs = path.join("cli-inputs.json");
            if cli_inputs.exists() {
                let content = std::fs::read_to_string(&cli_inputs)?;
                if content.contains("\"triggerFunction\"") {
                    analysis.features.push(DetectedFeature {
                        category: "storage".to_string(),
                        feature: "S3 Lambda Trigger".to_string(),
                        file_path: Some(cli_inputs.to_string_lossy().to_string()),
                        line_number: None,
                        compatibility: CompatibilityStatus::Supported,
                        migration_hint: "S3 triggers are supported in Gen2. Use onUpload/onDelete in defineStorage().".to_string(),
                    });
                }
            }
        }
    }
    
    Ok(())
}

fn analyze_functions(function_path: &Path, analysis: &mut MigrationAnalysis) -> anyhow::Result<()> {
    for entry in std::fs::read_dir(function_path)? {
        let entry = entry?;
        let path = entry.path();
        
        if path.is_dir() {
            let function_name = path.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            
            // Check for Lambda layers
            let function_params = path.join("function-parameters.json");
            
            if function_params.exists() {
                let content = std::fs::read_to_string(&function_params)?;
                
                // Lambda layers not supported
                if content.contains("\"lambdaLayers\"") || content.contains("\"layers\"") {
                    analysis.features.push(DetectedFeature {
                        category: "function".to_string(),
                        feature: format!("Lambda Layers ({})", function_name),
                        file_path: Some(function_params.to_string_lossy().to_string()),
                        line_number: None,
                        compatibility: CompatibilityStatus::NotSupported {
                            alternative: "Bundle dependencies directly or use CDK".to_string(),
                        },
                        migration_hint: "Lambda layers are not supported in Gen2. Bundle dependencies in your function or use CDK.".to_string(),
                    });
                    analysis.warnings.push(format!("Lambda layers in function '{}' need alternative approach", function_name));
                }
                
                // Check runtime
                if content.contains("\"python\"") {
                    analysis.features.push(DetectedFeature {
                        category: "function".to_string(),
                        feature: format!("Python Runtime ({})", function_name),
                        file_path: Some(function_params.to_string_lossy().to_string()),
                        line_number: None,
                        compatibility: CompatibilityStatus::SupportedWithCdk,
                        migration_hint: "Python functions require CDK customization in Gen2. TypeScript is the first-class runtime.".to_string(),
                    });
                } else if content.contains("\"go\"") || content.contains("\"java\"") || content.contains("\"dotnet\"") {
                    analysis.features.push(DetectedFeature {
                        category: "function".to_string(),
                        feature: format!("Non-Node Runtime ({})", function_name),
                        file_path: Some(function_params.to_string_lossy().to_string()),
                        line_number: None,
                        compatibility: CompatibilityStatus::SupportedWithCdk,
                        migration_hint: "Go/Java/.NET functions require CDK customization in Gen2.".to_string(),
                    });
                } else {
                    analysis.features.push(DetectedFeature {
                        category: "function".to_string(),
                        feature: format!("Node.js Function ({})", function_name),
                        file_path: Some(path.to_string_lossy().to_string()),
                        line_number: None,
                        compatibility: CompatibilityStatus::Supported,
                        migration_hint: "Node.js/TypeScript functions are fully supported in Gen2. Use defineFunction().".to_string(),
                    });
                }
            }
        }
    }
    
    Ok(())
}

fn check_deprecated_patterns(amplify_path: &Path, analysis: &mut MigrationAnalysis) -> anyhow::Result<()> {
    // Check for custom GraphQL transformers
    let transform_conf = amplify_path.join("backend").join("api").join("transform.conf.json");
    if transform_conf.exists() {
        let content = std::fs::read_to_string(&transform_conf)?;
        if content.contains("\"transformers\"") {
            analysis.features.push(DetectedFeature {
                category: "api".to_string(),
                feature: "Custom GraphQL Transformers".to_string(),
                file_path: Some(transform_conf.to_string_lossy().to_string()),
                line_number: None,
                compatibility: CompatibilityStatus::NotSupported {
                    alternative: "Use custom business logic in handlers".to_string(),
                },
                migration_hint: "Custom GraphQL transformers are not supported in Gen2. Implement custom logic in function handlers.".to_string(),
            });
            analysis.blocking_issues.push("Custom GraphQL transformers not supported".to_string());
        }
    }
    
    // Check for Geo category
    let geo_path = amplify_path.join("backend").join("geo");
    if geo_path.exists() {
        analysis.categories_detected.push("geo".to_string());
        analysis.features.push(DetectedFeature {
            category: "geo".to_string(),
            feature: "Location Services (Geo)".to_string(),
            file_path: Some(geo_path.to_string_lossy().to_string()),
            line_number: None,
            compatibility: CompatibilityStatus::SupportedWithCdk,
            migration_hint: "Geo requires CDK customization in Gen2. Use AWS Location Service CDK constructs.".to_string(),
        });
    }
    
    // Check for Analytics category
    let analytics_path = amplify_path.join("backend").join("analytics");
    if analytics_path.exists() {
        analysis.categories_detected.push("analytics".to_string());
        analysis.features.push(DetectedFeature {
            category: "analytics".to_string(),
            feature: "Analytics (Pinpoint)".to_string(),
            file_path: Some(analytics_path.to_string_lossy().to_string()),
            line_number: None,
            compatibility: CompatibilityStatus::SupportedWithCdk,
            migration_hint: "Analytics requires CDK customization in Gen2. Use Pinpoint CDK constructs.".to_string(),
        });
    }
    
    // Check for Interactions category
    let interactions_path = amplify_path.join("backend").join("interactions");
    if interactions_path.exists() {
        analysis.categories_detected.push("interactions".to_string());
        analysis.features.push(DetectedFeature {
            category: "interactions".to_string(),
            feature: "Interactions (Lex Bots)".to_string(),
            file_path: Some(interactions_path.to_string_lossy().to_string()),
            line_number: None,
            compatibility: CompatibilityStatus::SupportedWithCdk,
            migration_hint: "Interactions requires CDK customization in Gen2. Use Lex CDK constructs.".to_string(),
        });
    }
    
    // Check for REST API
    let api_path = amplify_path.join("backend").join("api");
    if api_path.exists() {
        for entry in std::fs::read_dir(&api_path)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                // Check if it's a REST API (has cli-inputs.json with apiType: REST)
                let cli_inputs = path.join("cli-inputs.json");
                if cli_inputs.exists() {
                    let content = std::fs::read_to_string(&cli_inputs)?;
                    if content.contains("\"REST\"") {
                        analysis.features.push(DetectedFeature {
                            category: "api".to_string(),
                            feature: "REST API".to_string(),
                            file_path: Some(cli_inputs.to_string_lossy().to_string()),
                            line_number: None,
                            compatibility: CompatibilityStatus::SupportedWithCdk,
                            migration_hint: "REST APIs require CDK customization in Gen2. Use API Gateway CDK constructs.".to_string(),
                        });
                    }
                }
            }
        }
    }
    
    Ok(())
}

fn find_line_number(content: &str, pattern: &str) -> Option<usize> {
    content.lines()
        .enumerate()
        .find(|(_, line)| line.contains(pattern))
        .map(|(idx, _)| idx + 1)
}

/// Generate a markdown report from the analysis
pub fn generate_report(analysis: &MigrationAnalysis) -> String {
    let mut report = String::new();
    
    report.push_str("# Amplify Gen1 → Gen2 Migration Analysis\n\n");
    report.push_str(&format!("**Project:** {}\n", analysis.project_path));
    report.push_str(&format!("**Detected Generation:** {:?}\n\n", analysis.generation));
    
    if analysis.generation != AmplifyGeneration::Gen1 {
        if analysis.generation == AmplifyGeneration::Gen2 {
            report.push_str("✅ This project is already using Amplify Gen2!\n");
        } else {
            report.push_str("⚠️ Could not detect an Amplify project in this directory.\n");
        }
        return report;
    }
    
    // Summary
    report.push_str("## Summary\n\n");
    report.push_str(&format!("| Metric | Count |\n"));
    report.push_str(&format!("|--------|-------|\n"));
    report.push_str(&format!("| Total Features | {} |\n", analysis.summary.total_features));
    report.push_str(&format!("| ✅ Fully Supported | {} |\n", analysis.summary.fully_supported));
    report.push_str(&format!("| 🔧 Supported with CDK | {} |\n", analysis.summary.supported_with_cdk));
    report.push_str(&format!("| ❌ Not Supported | {} |\n", analysis.summary.not_supported));
    report.push_str(&format!("| ⚠️ Manual Migration | {} |\n", analysis.summary.manual_migration));
    report.push_str("\n");
    
    // Migration readiness
    if analysis.ready_for_migration {
        report.push_str("### ✅ Ready for Migration\n\n");
        report.push_str("Your project can be migrated to Gen2. Some features may require CDK customization.\n\n");
    } else {
        report.push_str("### ❌ Blocking Issues\n\n");
        report.push_str("The following issues must be resolved before migration:\n\n");
        for issue in &analysis.blocking_issues {
            report.push_str(&format!("- {}\n", issue));
        }
        report.push_str("\n");
    }
    
    // Warnings
    if !analysis.warnings.is_empty() {
        report.push_str("### ⚠️ Warnings\n\n");
        for warning in &analysis.warnings {
            report.push_str(&format!("- {}\n", warning));
        }
        report.push_str("\n");
    }
    
    // Categories
    report.push_str("## Detected Categories\n\n");
    for category in &analysis.categories_detected {
        report.push_str(&format!("- {}\n", category));
    }
    report.push_str("\n");
    
    // Features by category
    report.push_str("## Feature Analysis\n\n");
    
    let mut features_by_category: HashMap<String, Vec<&DetectedFeature>> = HashMap::new();
    for feature in &analysis.features {
        features_by_category
            .entry(feature.category.clone())
            .or_default()
            .push(feature);
    }
    
    for (category, features) in features_by_category {
        report.push_str(&format!("### {}\n\n", category.to_uppercase()));
        
        for feature in features {
            let status_icon = match &feature.compatibility {
                CompatibilityStatus::Supported => "✅",
                CompatibilityStatus::SupportedWithCdk => "🔧",
                CompatibilityStatus::NotSupported { .. } => "❌",
                CompatibilityStatus::ManualMigration { .. } => "⚠️",
            };
            
            report.push_str(&format!("#### {} {}\n\n", status_icon, feature.feature));
            
            if let Some(file) = &feature.file_path {
                if let Some(line) = feature.line_number {
                    report.push_str(&format!("**Location:** {}:{}\n\n", file, line));
                } else {
                    report.push_str(&format!("**Location:** {}\n\n", file));
                }
            }
            
            match &feature.compatibility {
                CompatibilityStatus::Supported => {
                    report.push_str("**Status:** Fully supported in Gen2\n\n");
                }
                CompatibilityStatus::SupportedWithCdk => {
                    report.push_str("**Status:** Supported with CDK customization\n\n");
                }
                CompatibilityStatus::NotSupported { alternative } => {
                    report.push_str(&format!("**Status:** Not supported\n\n**Alternative:** {}\n\n", alternative));
                }
                CompatibilityStatus::ManualMigration { reason } => {
                    report.push_str(&format!("**Status:** Requires manual migration\n\n**Reason:** {}\n\n", reason));
                }
            }
            
            report.push_str(&format!("**Migration Hint:** {}\n\n", feature.migration_hint));
            report.push_str("---\n\n");
        }
    }
    
    // Next steps
    report.push_str("## Next Steps\n\n");
    report.push_str("1. Review the blocking issues above (if any)\n");
    report.push_str("2. For features requiring CDK, prepare your CDK customization strategy\n");
    report.push_str("3. Create a new Gen2 project: `npm create amplify@latest`\n");
    report.push_str("4. Migrate features one category at a time\n");
    report.push_str("5. Test thoroughly in sandbox environment before deploying\n\n");
    report.push_str("**Documentation:** https://docs.amplify.aws/react/start/migrate-to-gen2/\n");
    
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_migration_summary() {
        let mut analysis = MigrationAnalysis::new("/test/path");
        analysis.features.push(DetectedFeature {
            category: "auth".to_string(),
            feature: "Test".to_string(),
            file_path: None,
            line_number: None,
            compatibility: CompatibilityStatus::Supported,
            migration_hint: "Test hint".to_string(),
        });
        analysis.compute_summary();
        assert_eq!(analysis.summary.total_features, 1);
        assert_eq!(analysis.summary.fully_supported, 1);
    }
}
