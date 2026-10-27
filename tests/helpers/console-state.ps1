param([Parameter(Mandatory = $true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ConsoleState {
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
}
'@
$window = [ConsoleState]::GetConsoleWindow()
$state = @{ window = $window.ToInt64(); visible = [ConsoleState]::IsWindowVisible($window) }
[IO.File]::WriteAllText($OutputPath, ($state | ConvertTo-Json -Compress))
