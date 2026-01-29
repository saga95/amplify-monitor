# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it by emailing the maintainers directly rather than opening a public issue.

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will respond within 48 hours and work with you to address the issue.

## Security Considerations

This tool:
- Uses AWS credentials from environment variables only (never stored)
- Does not cache sensitive log data locally
- Only performs read operations on AWS Amplify (no mutations)
- Downloads logs over HTTPS
