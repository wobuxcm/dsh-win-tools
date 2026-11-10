# AI activity indicator for dsh-win-tools.
#
# A small always-on-top, click-through pill that tells the operator the agent is
# driving this desktop. It never takes focus and never blocks a click.
#
# State comes from two files, so the plugin only has to touch a timestamp:
#   %DSH_HOME%\cua.active  - LastWriteTime within $ActiveSeconds => "operating"
#   %DSH_HOME%\cua.stop    - operator pause switch
#
# Spawned detached by index.js; exits immediately if another copy already runs.

param(
  [string]$DshHome = $(if ($env:DSH_HOME -and $env:DSH_HOME.Trim() -ne '') { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }),
  [int]$ActiveSeconds = 5,
  [int]$PollMs = 250,
  [int]$Width = 560,
  [int]$TaskTtlSeconds = 1800,
  [int]$Height = 44
)

$ErrorActionPreference = 'SilentlyContinue'
$stateFile = Join-Path $DshHome 'cua.active'
$taskFile = Join-Path $DshHome 'cua.task'
$pauseFile = Join-Path $DshHome 'cua.stop'
$pidFile = Join-Path $DshHome 'indicator.pid'

# --- single instance -------------------------------------------------------
if (Test-Path $pidFile) {
  $old = 0
  [void][int]::TryParse((Get-Content $pidFile -Raw).Trim(), [ref]$old)
  if ($old -gt 0 -and (Get-Process -Id $old -ErrorAction SilentlyContinue)) { exit 0 }
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class IndWin {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
}
'@
[void][IndWin]::SetProcessDPIAware()

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(26, 30, 42)
$form.Opacity = 0.94
$form.ClientSize = New-Object System.Drawing.Size($Width, $Height)

$dot = New-Object System.Windows.Forms.Label
$dot.AutoSize = $false
$dot.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
$dot.SetBounds(14, 0, 22, $Height)
$dot.Text = [char]0x25CF
$dot.Font = New-Object System.Drawing.Font('Segoe UI', 11)
$dot.ForeColor = [System.Drawing.Color]::FromArgb(255, 158, 11)

$label = New-Object System.Windows.Forms.Label
$label.AutoSize = $false
$label.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
$label.SetBounds(40, 0, ($Width - 54), $Height)
$label.Text = 'AI is operating this PC'
$label.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)
$label.ForeColor = [System.Drawing.Color]::Gainsboro

$form.Controls.Add($dot)
$form.Controls.Add($label)

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$form.Left = [int](($bounds.Width - $Width) / 2)
$form.Top = 10

$form.Add_Shown({
  $h = $form.Handle
  $ex = [IndWin]::GetWindowLong($h, -20)
  # WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW
  [void][IndWin]::SetWindowLong($h, -20, ($ex -bor 0x20 -bor 0x80000 -bor 0x08000000 -bor 0x80))
})

$form.Show()
Set-Content -Path $pidFile -Value $PID -Encoding ascii

$tick = {
  $paused = Test-Path $pauseFile
  $active = $false
  if (Test-Path $stateFile) {
    $age = ((Get-Date) - (Get-Item $stateFile).LastWriteTime).TotalSeconds
    $active = $age -lt $ActiveSeconds
  }
  # A long task (image generation, downloads) writes its own label so the pill
  # keeps explaining what is happening even while no input is being injected.
  $task = ''
  if (Test-Path $taskFile) {
    $tAge = ((Get-Date) - (Get-Item $taskFile).LastWriteTime).TotalSeconds
    if ($tAge -lt $TaskTtlSeconds) { $task = (Get-Content $taskFile -Raw).Trim() }
  }
  if ($paused) {
    $dot.ForeColor = [System.Drawing.Color]::FromArgb(150, 150, 160)
    $label.Text = 'Paused - AI will not act'
    $label.ForeColor = [System.Drawing.Color]::FromArgb(200, 200, 205)
    if (-not $form.Visible) { $form.Show() }
  } elseif ($task -ne '') {
    $dot.ForeColor = [System.Drawing.Color]::FromArgb(64, 196, 255)
    $label.Text = $task
    $label.ForeColor = [System.Drawing.Color]::Gainsboro
    if (-not $form.Visible) { $form.Show() }
  } elseif ($active) {
    $dot.ForeColor = [System.Drawing.Color]::FromArgb(255, 158, 11)
    $label.Text = 'AI is operating this PC'
    $label.ForeColor = [System.Drawing.Color]::Gainsboro
    if (-not $form.Visible) { $form.Show() }
  } else {
    if ($form.Visible) { $form.Hide() }
  }
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $PollMs
$timer.Add_Tick($tick)
$timer.Start()

$form.Add_FormClosed({ Remove-Item $pidFile -Force -ErrorAction SilentlyContinue; $timer.Stop() })
& $tick

[System.Windows.Forms.Application]::Run($form)
