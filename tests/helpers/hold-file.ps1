$ErrorActionPreference = 'Stop'
$handle = [IO.File]::Open($env:PIQ_TEST_LOCK_PATH, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
try {
  [Console]::Out.WriteLine('locked')
  [Console]::Out.Flush()
  [Console]::In.ReadLine() | Out-Null
} finally { $handle.Dispose() }
