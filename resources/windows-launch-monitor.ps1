param(
    [Parameter(Mandatory = $true)]
    [string]$MonitorPath,
    [Parameter(Mandatory = $true)]
    [int]$TargetProcessId,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedIdentity,
    [Parameter(Mandatory = $true)]
    [string]$EventPath,
    [Parameter(Mandatory = $true)]
    [string]$CancelPath
)

$ErrorActionPreference = 'Stop'
$powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = @(
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    ('"' + $MonitorPath + '"'),
    '-TargetProcessId',
    [string]$TargetProcessId,
    '-ExpectedIdentity',
    $ExpectedIdentity,
    '-EventPath',
    ('"' + $EventPath + '"'),
    '-CancelPath',
    ('"' + $CancelPath + '"')
)

$monitor = Start-Process -FilePath $powerShell -ArgumentList $arguments -WindowStyle Hidden -PassThru
Write-Output $monitor.Id