#!/bin/bash
rm -rf *.vsix
code --uninstall-extension "mattwise-42.github-pr-reviewer" || true
npm install && npm run package && code --install-extension "github-pr-reviewer-0.0.1.vsix" --force
