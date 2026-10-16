# Adds this repo's bin\ to the current user's PATH so `agentbus` works in any new terminal.
# Run once:  powershell -ExecutionPolicy Bypass -File <repo>\bin\install-path.ps1
$bin = Split-Path -Parent $MyInvocation.MyCommand.Path
$user = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($user -split ';') -contains $bin) {
  Write-Host "already on PATH: $bin"
} else {
  [Environment]::SetEnvironmentVariable('Path', ($user.TrimEnd(';') + ';' + $bin), 'User')
  Write-Host "added to user PATH: $bin"
  Write-Host "open a new terminal, then run: agentbus --version"
}
