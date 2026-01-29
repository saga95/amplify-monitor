# Contributing to amplify-monitor

Thank you for your interest in contributing!

## Development Setup

1. Install Rust via [rustup](https://rustup.rs)
2. Clone the repository
3. Run tests: `cargo test`

## Code Standards

- Run `cargo fmt` before committing
- Run `cargo clippy` and fix all warnings
- Add tests for new functionality
- Update CHANGELOG.md for user-facing changes

## Pull Request Process

1. Create a feature branch from `main`
2. Make your changes with clear commit messages
3. Ensure all tests pass
4. Update documentation if needed
5. Submit a PR with a clear description

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new failure pattern for webpack errors
fix: handle empty log files gracefully
docs: update README with new examples
test: add tests for config loading
```

## Adding New Failure Patterns

1. Add detection function in `src/parser.rs`
2. Add to the checkers list in `analyze_logs()`
3. Add integration test in `tests/integration_tests.rs`
4. Update README.md pattern table

## Release Process

1. Update version in `Cargo.toml`
2. Update CHANGELOG.md
3. Create and push a tag: `git tag v0.x.0 && git push origin v0.x.0`
4. GitHub Actions will build and publish the release
