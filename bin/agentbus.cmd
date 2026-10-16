@echo off
rem agentbus launcher: runs the CLI from this checkout (build first: pnpm tsc -b)
node "%~dp0..\packages\cli\dist\bin.js" %*
