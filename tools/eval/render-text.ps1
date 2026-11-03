# Renders text to a PNG the way a terminal screenshot looks, for the OCR cases in tools/eval.ts.
# dark: light grey Consolas on near black. light: black on white.
param(
    [Parameter(Mandatory)] [string]$Text,
    [Parameter(Mandatory)] [string]$Out,
    [ValidateSet('dark', 'light')] [string]$Style = 'dark'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$font = [Drawing.Font]::new('Consolas', 15)
$lines = $Text -split "`n"
$probe = [Drawing.Graphics]::FromImage([Drawing.Bitmap]::new(1, 1))
$width = 0
foreach ($l in $lines) { $width = [Math]::Max($width, [int]$probe.MeasureString($l, $font).Width) }
$lineHeight = [int]($font.GetHeight($probe) + 4)
$probe.Dispose()

$bmp = [Drawing.Bitmap]::new($width + 48, $lineHeight * $lines.Count + 40)
$g = [Drawing.Graphics]::FromImage($bmp)
$g.TextRenderingHint = [Drawing.Text.TextRenderingHint]::ClearTypeGridFit
$bg, $fg = if ($Style -eq 'dark') { [Drawing.Color]::FromArgb(12, 12, 12), [Drawing.Color]::FromArgb(204, 204, 204) } else { [Drawing.Color]::White, [Drawing.Color]::Black }
$g.Clear($bg)
$brush = [Drawing.SolidBrush]::new($fg)
for ($i = 0; $i -lt $lines.Count; $i++) { $g.DrawString($lines[$i], $font, $brush, 24, 20 + $i * $lineHeight) }
$g.Dispose()
$bmp.Save($Out, [Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
