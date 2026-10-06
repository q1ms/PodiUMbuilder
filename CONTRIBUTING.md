# Contributing to Podi@UM

First off, thanks for considering contributing! 🎉

## How Can I Contribute?

### 🐛 Reporting Bugs

Before creating a bug report, please check the [issue tracker](https://github.com/q1ms/PodiUMbuilder/issues) to see if it's already been reported.

When reporting a bug, include:
- Your OS and browser version
- Steps to reproduce
- Expected vs actual behavior
- Screenshots if applicable

### 💡 Suggesting Features

Feature suggestions are welcome! Open an issue with the `enhancement` label and describe:
- The problem you're trying to solve
- Your proposed solution
- Any alternatives you've considered

### 🔧 Pull Requests

1. Fork the repo and create your branch from `main`
2. Install dependencies: `npm install`
3. Make your changes
4. Test thoroughly
5. Commit with a descriptive message
6. Push to your fork and open a PR

## Development Setup

```bash
git clone https://github.com/YOUR_USERNAME/PodiUMbuilder.git
cd PodiUMbuilder
npm install
cp .env.example .env
# Fill in .env with your credentials
npm start
```

## Code Style

- Use 4-space indentation
- Follow existing patterns (see `server.js` for backend conventions)
- Write descriptive variable names
- Comment complex logic

## Commit Messages

Use conventional commits:

```text
feat: add countdown timer block
fix: resolve playlist resume bug
docs: update README with API reference
chore: upgrade dependencies
```

## Questions?

Feel free to open an issue with the `question` label.
