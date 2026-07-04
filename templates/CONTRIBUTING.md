# Contributing to {{project-name}}

## Development Setup

1. Fork and clone the repo
2. Install dependencies: `pnpm install`
3. Create a branch: `git checkout -b feature/my-feature`
4. Make your changes
5. Run tests: `pnpm test`
6. Push and open a PR

## Commit Messages

Use clear, descriptive commit messages:

```
feat: add NFC tap-to-pay support
fix: resolve auth redirect loop on mobile
docs: update API reference for /payments endpoint
refactor: extract validation into shared util
```

Prefixes: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `style`

## Pull Requests

- Keep PRs focused - one feature or fix per PR
- Include a summary of what changed and why
- Link related issues
- Add screenshots for UI changes

## Code Style

- Follow existing patterns in the codebase
- Use TypeScript strict mode
- Format with Prettier, lint with ESLint

## Reporting Issues

Open an issue with:
- Steps to reproduce
- Expected vs actual behavior
- Environment details (OS, browser, Node version)
