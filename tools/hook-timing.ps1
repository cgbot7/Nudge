# Times the refs prompt hook inside one PowerShell session. Run by tools\bench.ts with
# LOCALAPPDATA pointing at a sandbox whose hook-cache.json knows the two projects.
#
# first:     the first hook call in this session (cold: .NET and regex warm-up)
# enter:     entering a different project (reads the cache, prints a line, writes last-project.json)
# subfolder: moving into a subfolder of the same project (prints nothing)
# Write-Host output is discarded (stream 6), so console speed is not measured.
param(
    [Parameter(Mandatory)] [string]$Hook,
    [Parameter(Mandatory)] [string]$ProjectA,
    [Parameter(Mandatory)] [string]$ProjectB,
    [int]$Runs = 50
)
$ErrorActionPreference = 'Stop'
. $Hook

$sw = [Diagnostics.Stopwatch]::new()
function Measure-Hook {
    $sw.Restart()
    Invoke-RefsHook 6>$null
    $sw.Stop()
    return $sw.Elapsed.TotalMilliseconds
}

Set-Location -LiteralPath $ProjectA
$first = Measure-Hook

$enter = [Collections.Generic.List[double]]::new()
$subfolder = [Collections.Generic.List[double]]::new()
for ($i = 0; $i -lt $Runs; $i++) {
    $project = if ($i % 2 -eq 0) { $ProjectB } else { $ProjectA }
    Set-Location -LiteralPath $project
    $enter.Add((Measure-Hook))
    Set-Location -LiteralPath (Join-Path $project 'src')
    $subfolder.Add((Measure-Hook))
}

# The line the hook printed for the last project entered, to prove it did real work.
Set-Location -LiteralPath $ProjectB
Invoke-RefsHook 6>$null
Set-Location -LiteralPath $ProjectA
$line = (Invoke-RefsHook 6>&1 | Out-String).Trim()

[ordered]@{
    first     = $first
    enter     = $enter.ToArray()
    subfolder = $subfolder.ToArray()
    line      = $line
    ps        = $PSVersionTable.PSVersion.ToString()
} | ConvertTo-Json -Compress
