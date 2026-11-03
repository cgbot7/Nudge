# nudge prompt hook. Dot-source it from your PowerShell profile (nudge install does this).
#
# Prints one line when you enter a different project under a registered root, read
# from %LOCALAPPDATA%\nudge\hook-cache.json (written by nudge index and nudge scan):
#   nudge [node, docker] 4 sheets (1 stale) | gap: playwright | try: "Docker volumes" | nudge for .
# Moving between folders of the same project prints nothing. It never starts Node
# except to run a hidden `nudge scan` for a project the cache does not know yet.
#
# Speed: no ConvertFrom-Json or ConvertTo-Json (30+ ms cold in Windows PowerShell 5.1).
# The cache puts one project per line starting with {"key":"<path key>", so finding a
# project is an ordinal string search. It must never throw; any failure prints nothing.
# Target PowerShell 7; 5.1 is best effort, so the syntax stays inside what 5.1 parses.

$global:__nudgeHook = @{
    Dir     = Join-Path $env:LOCALAPPDATA 'nudge'
    Cli     = Join-Path (Split-Path $PSScriptRoot -Parent) 'packages\cli\src\main.ts'
    Cwd     = $null
    Project = $null
    Stamp   = $null
    Text    = $null
    Roots   = @()
}

function global:ConvertFrom-NudgeJsonString([string]$s) {
    if ($s.IndexOf('\') -lt 0) { return $s }
    return [regex]::Unescape($s)
}

function global:Get-NudgeField([string]$line, [string]$name) {
    $m = [regex]::Match($line, '"' + $name + '":"((?:[^"\\]|\\.)*)"')
    if (-not $m.Success) { return '' }
    return ConvertFrom-NudgeJsonString $m.Groups[1].Value
}

# Items of a JSON string array, given what is between [ and ]. Splitting on "," is safe:
# JSON escapes every quote inside a string. ([regex]::Matches costs 10+ ms cold in 5.1.)
function global:Split-NudgeJsonArray([string]$inner) {
    if ($inner.Length -lt 2) { return @() }
    $items = $inner.Substring(1, $inner.Length - 2).Split([string[]]@('","'), [StringSplitOptions]::None)
    for ($i = 0; $i -lt $items.Length; $i++) { $items[$i] = ConvertFrom-NudgeJsonString $items[$i] }
    return , $items
}

# last-project.json: the project you are in (for the popup) and the "try:" rotation
# position per project. Its keys are path keys, which never contain a quote.
function global:Write-NudgeLastProject([string]$key, [string]$line, [string]$cwd, [string]$rotation, [int]$next) {
    $file = Join-Path $global:__nudgeHook.Dir 'last-project.json'
    $pairs = '"' + $key + '":' + $next
    if ($rotation) {
        foreach ($pair in $rotation.Split([string[]]@(',"'), [StringSplitOptions]::None)) {
            if (-not $pair.StartsWith('"')) { $pair = '"' + $pair }
            if (-not $pair.StartsWith('"' + $key + '":', [StringComparison]::Ordinal)) { $pairs += ',' + $pair }
        }
    }
    $path = [regex]::Match($line, '"path":"(?:[^"\\]|\\.)*"').Value
    $tags = [regex]::Match($line, '"tags":\[[^\]]*\]').Value
    $json = '{"key":"' + $key + '",' + $path + ',"cwd":"' + $cwd.Replace('\', '/') + '",' + $tags +
        ',"at":"' + [DateTime]::UtcNow.ToString('s') + 'Z","rotation":{' + $pairs + '}}'
    $tmp = "$file.$PID.tmp"
    [IO.File]::WriteAllText($tmp, $json)
    if ([IO.File]::Exists($file)) { [IO.File]::Replace($tmp, $file, [NullString]::Value) } else { [IO.File]::Move($tmp, $file) }
}

function global:Invoke-NudgeHook {
    try {
        $h = $global:__nudgeHook
        $loc = $ExecutionContext.SessionState.Path.CurrentLocation
        if ($loc.Provider.Name -ne 'FileSystem') { $h.Cwd = $null; $h.Project = $null; return }
        $cwd = $loc.ProviderPath
        if ($cwd -ceq $h.Cwd) { return }
        $h.Cwd = $cwd

        $file = Join-Path $h.Dir 'hook-cache.json'
        $stamp = [IO.File]::GetLastWriteTimeUtc($file)
        if ($stamp -ne $h.Stamp) {
            $h.Stamp = $stamp
            $h.Text = $null
            $h.Roots = @()
            if ([IO.File]::Exists($file)) {
                # Share Delete too, so nudge index can rename a new cache over this one meanwhile.
                $fs = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
                try { $text = (New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Dispose() }
                $rm = [regex]::Match($text, '^\{"version":1,[^\n]*"roots":\[([^\]]*)\]')
                if ($rm.Success) {
                    $h.Text = $text
                    $h.Roots = Split-NudgeJsonArray $rm.Groups[1].Value
                }
            }
        }
        if ($null -eq $h.Text) { $h.Project = $null; return }

        $key = $cwd.Replace('\', '/').TrimEnd('/').ToLowerInvariant()
        $root = $null
        foreach ($r in $h.Roots) {
            $rk = $r.TrimEnd('/')
            if ($key.StartsWith($rk + '/', [StringComparison]::Ordinal) -and ($null -eq $root -or $rk.Length -gt $root.Length)) { $root = $rk }
        }
        if ($null -eq $root) { $h.Project = $null; return }

        # Nearest cached project: try the folder, then each parent up to the root.
        $probe = $key
        $line = $null
        while ($probe.Length -gt $root.Length) {
            $i = $h.Text.IndexOf("`n{`"key`":`"$probe`",", [StringComparison]::Ordinal)
            if ($i -ge 0) {
                $end = $h.Text.IndexOf("`n", $i + 1)
                if ($end -lt 0) { $end = $h.Text.Length }
                $line = $h.Text.Substring($i + 1, $end - $i - 1)
                break
            }
            $probe = $probe.Substring(0, $probe.LastIndexOf('/'))
        }

        if ($null -eq $line) {
            # Unknown folder under a root: report once per first-level folder and scan it in the background.
            $first = $root + '/' + $key.Substring($root.Length + 1).Split('/')[0]
            if ($first -eq $h.Project) { return }
            $h.Project = $first
            Write-Host 'nudge: new project, scanning' -ForegroundColor DarkCyan
            $psi = New-Object Diagnostics.ProcessStartInfo
            $psi.FileName = 'node.exe'
            $psi.Arguments = '"' + $h.Cli + '" scan "' + $cwd.TrimEnd('\') + '"'
            $psi.UseShellExecute = $false
            $psi.CreateNoWindow = $true
            [void][Diagnostics.Process]::Start($psi)
            return
        }
        if ($probe -eq $h.Project) { return }
        $h.Project = $probe

        $tries = @()
        $tm = [regex]::Match($line, '"try":\[((?:"(?:[^"\\]|\\.)*",?)*)\]')
        if ($tm.Success) { $tries = Split-NudgeJsonArray $tm.Groups[1].Value }
        $n = 0
        $rotation = ''
        $lp = Join-Path $h.Dir 'last-project.json'
        if ([IO.File]::Exists($lp)) {
            $rotation = [regex]::Match([IO.File]::ReadAllText($lp), '"rotation":\{([^}]*)\}').Groups[1].Value
            $at = $rotation.IndexOf('"' + $probe + '":', [StringComparison]::Ordinal)
            if ($at -ge 0) {
                $digits = [regex]::Match($rotation.Substring($at + $probe.Length + 3), '^\d+').Value
                if ($digits) { $n = [int]$digits }
            }
        }
        $text = Get-NudgeField $line 'head'
        if ($tries.Count) { $text += ' | try: "' + $tries[$n % $tries.Count] + '"' }
        $text += Get-NudgeField $line 'tail'
        Write-Host $text -ForegroundColor DarkCyan
        Write-NudgeLastProject $probe $line $cwd $rotation ($n + 1)
    } catch {
        # Never break the prompt.
    }
}

# Wrap the current prompt once. The original runs first so it still sees $? and
# $LASTEXITCODE from your last command; the nudge line prints just above the prompt.
if (-not $global:__nudgeInnerPrompt) {
    $global:__nudgeInnerPrompt = $function:prompt
    function global:prompt {
        $p = & $global:__nudgeInnerPrompt
        Invoke-NudgeHook
        $p
    }
}
