$ErrorActionPreference = 'Stop'
try {
  $PiQNode = $env:PIQ_HIDDEN_NODE
  $PiQEntry = $env:PIQ_HIDDEN_ENTRY
  $PiQDirectory = $env:PIQ_HIDDEN_DIRECTORY
  $PiQStdout = $env:PIQ_HIDDEN_STDOUT
  $PiQStderr = $env:PIQ_HIDDEN_STDERR
  if (-not $PiQNode -or -not $PiQEntry -or -not $PiQDirectory -or -not $PiQStdout -or -not $PiQStderr) {
    throw 'The hidden launcher environment is incomplete.'
  }
  if (-not (Test-Path -LiteralPath $PiQNode -PathType Leaf) -or
      -not (Test-Path -LiteralPath $PiQEntry -PathType Leaf) -or
      -not (Test-Path -LiteralPath $PiQDirectory -PathType Container) -or
      $PiQEntry.Contains('"')) {
    throw 'The hidden launcher paths are invalid.'
  }
  # Start-Process gives the original runtime a hidden console. Descendants can
  # inherit it even after this short-lived helper exits. Windows redirects the
  # standard streams to file handles, so logging does not depend on this helper.
  $PiQChild = Start-Process -FilePath $PiQNode -ArgumentList ('"' + $PiQEntry + '"') `
    -WorkingDirectory $PiQDirectory -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $PiQStdout -RedirectStandardError $PiQStderr
  if (-not $PiQChild -or $PiQChild.Id -le 0) { throw 'The runtime did not return a process id.' }
  [Console]::Out.WriteLine((@{ pid = $PiQChild.Id } | ConvertTo-Json -Compress))
  exit 0
} catch {
  [Console]::Error.WriteLine('PiQ hidden runtime startup failed.')
  exit 1
}
