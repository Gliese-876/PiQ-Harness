param(
  [string]$GroupDirectory = $env:PIQ_GROUP_DIRECTORY,
  [string]$NodeExecutable = $env:PIQ_NODE_EXECUTABLE,
  [string]$EntryPoint = $env:PIQ_TERMINAL_ENTRY
)
$ErrorActionPreference = 'Stop'
if (-not $GroupDirectory -or -not $NodeExecutable -or -not $EntryPoint) {
  throw 'The PiQ terminal environment is incomplete. Open this group from the PiQ WebUI.'
}
Set-Location -LiteralPath $GroupDirectory
& $NodeExecutable $EntryPoint $GroupDirectory
if ($LASTEXITCODE -ne 0) {
  Write-Host ('PiQ exited with code ' + $LASTEXITCODE) -ForegroundColor Yellow
}
exit $LASTEXITCODE
