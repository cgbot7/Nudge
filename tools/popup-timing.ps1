# Times the popup from hotkey to visible. Run by tools\bench.ts with APPDATA and LOCALAPPDATA
# pointing at a sandbox whose config.json sets the hotkey to Ctrl+Alt+Shift+F12.
#
# It starts the built popup, presses the hotkey with keybd_event (real keyboard input, so
# it goes through RegisterHotKey like a key press does), and records two numbers per press:
#   visible: from the key press to IsWindowVisible on the popup window, measured from outside
#   painted: the popup's own "hotkey to painted" log line (hotkey handler to second frame)
# Escape hides the popup again between presses. The popup is stopped at the end.
param(
    [Parameter(Mandatory)] [string]$Exe,
    [Parameter(Mandatory)] [string]$Node,
    [Parameter(Mandatory)] [string]$Sidecar,
    [int]$Runs = 20
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class RefsBenchNative {
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int max);
    delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    public static IntPtr FindWindow(uint pid, string title) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, l) => {
            uint p; GetWindowThreadProcessId(h, out p);
            if (p != pid) return true;
            var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
            if (sb.ToString() == title) { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }
    const uint KEYUP = 2;
    public static void Chord(byte[] mods, byte key) {
        foreach (var m in mods) keybd_event(m, 0, 0, UIntPtr.Zero);
        keybd_event(key, 0, 0, UIntPtr.Zero);
        keybd_event(key, 0, KEYUP, UIntPtr.Zero);
        for (int i = mods.Length - 1; i >= 0; i--) keybd_event(mods[i], 0, KEYUP, UIntPtr.Zero);
    }
}
'@

$VK_CTRL = 0x11; $VK_ALT = 0x12; $VK_SHIFT = 0x10; $VK_F12 = 0x7B; $VK_ESC = 0x1B
$log = Join-Path $env:LOCALAPPDATA 'refs\logs\popup.log'

function Read-Log { if (Test-Path -LiteralPath $log) { [IO.File]::ReadAllLines($log) } else { @() } }
function Wait-Until([scriptblock]$cond, [int]$timeoutMs) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt $timeoutMs) { if (& $cond) { return $true }; Start-Sleep -Milliseconds 20 }
    return $false
}

$proc = Start-Process -FilePath $Exe -ArgumentList @('--node', "`"$Node`"", '--sidecar', "`"$Sidecar`"") -PassThru
try {
    if (-not (Wait-Until { (Read-Log) -match 'hotkey Ctrl\+Alt\+Shift\+F12' } 60000)) {
        throw "the popup did not register Ctrl+Alt+Shift+F12 within 60 s; see $log"
    }
    $hwnd = [IntPtr]::Zero
    [void](Wait-Until { $script:hwnd = [RefsBenchNative]::FindWindow([uint32]$proc.Id, 'refs'); $script:hwnd -ne [IntPtr]::Zero } 10000)
    if ($hwnd -eq [IntPtr]::Zero) { throw 'the popup window was not found' }
    # The frontend registers the hotkey once the sidecar answers; give the page a moment to settle.
    Start-Sleep -Milliseconds 1500

    $visible = [Collections.Generic.List[double]]::new()
    $painted = [Collections.Generic.List[double]]::new()
    $missed = 0
    $sw = [Diagnostics.Stopwatch]::new()
    for ($i = 0; $i -lt $Runs; $i++) {
        $before = (Read-Log | Where-Object { $_ -match 'hotkey to painted' }).Count
        $sw.Restart()
        [RefsBenchNative]::Chord([byte[]]@($VK_CTRL, $VK_ALT, $VK_SHIFT), [byte]$VK_F12)
        while (-not [RefsBenchNative]::IsWindowVisible($hwnd) -and $sw.ElapsedMilliseconds -lt 3000) { }
        $sw.Stop()
        if (-not [RefsBenchNative]::IsWindowVisible($hwnd)) { $missed++; continue }
        $visible.Add($sw.Elapsed.TotalMilliseconds)
        if (Wait-Until { (Read-Log | Where-Object { $_ -match 'hotkey to painted' }).Count -gt $before } 3000) {
            $last = (Read-Log | Where-Object { $_ -match 'hotkey to painted' })[-1]
            $painted.Add([double]([regex]::Match($last, 'painted: ([\d.]+) ms').Groups[1].Value))
        }
        [RefsBenchNative]::Chord([byte[]]@(), [byte]$VK_ESC)
        if (-not (Wait-Until { -not [RefsBenchNative]::IsWindowVisible($hwnd) } 1000)) { [void][RefsBenchNative]::ShowWindow($hwnd, 0) }
        Start-Sleep -Milliseconds 300
    }
    [ordered]@{ visible = $visible.ToArray(); painted = $painted.ToArray(); missed = $missed } | ConvertTo-Json -Compress
} finally {
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
}
