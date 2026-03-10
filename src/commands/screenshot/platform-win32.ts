/**
 * Windows platform screenshot implementation
 *
 * Uses PowerShell with .NET System.Drawing and Win32 API.
 * Scripts are written to temp .ps1 files to avoid quoting issues.
 *
 * v1.9.0
 */

import type { PlatformScreenshot, WindowInfo } from './types.js';
import { runPowerShell } from './shared.js';

// runPowerShell is imported from shared.ts (avoids duplication with post-process.ts)

// ============================================================
// PowerShell Scripts
// ============================================================

function fullscreenScript(filePath: string, monitor?: number): string {
    const escapedPath = filePath.replace(/\\/g, '\\\\').replace(/'/g, "''");
    const screenSelector = monitor !== undefined
        ? `[System.Windows.Forms.Screen]::AllScreens[${monitor}]`
        : `[System.Windows.Forms.Screen]::PrimaryScreen`;

    return `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$screen = ${screenSelector}
if (-not $screen) {
    Write-Error "Monitor ${monitor ?? 0} not found"
    exit 1
}
$bounds = $screen.Bounds
$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bitmap.Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
`;
}

function activeWindowScript(filePath: string): string {
    const escapedPath = filePath.replace(/\\/g, '\\\\').replace(/'/g, "''");

    return `
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Active {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [StructLayout(LayoutKind.Sequential)] public struct RECT {
        public int Left, Top, Right, Bottom;
    }
}
"@

$hwnd = [Win32Active]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) {
    Write-Error "No active window found"
    exit 1
}
$rect = New-Object Win32Active+RECT
[Win32Active]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
if ($w -le 0 -or $h -le 0) {
    Write-Error "Invalid window dimensions"
    exit 1
}
$bitmap = New-Object System.Drawing.Bitmap($w, $h)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
$bitmap.Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
`;
}

function windowByTitleScript(filePath: string, windowTitle: string): string {
    const escapedPath = filePath.replace(/\\/g, '\\\\').replace(/'/g, "''");
    const escapedTitle = windowTitle.replace(/'/g, "''");

    return `
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win32Find {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [StructLayout(LayoutKind.Sequential)] public struct RECT {
        public int Left, Top, Right, Bottom;
    }
    public static IntPtr FindByTitle(string search) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            var sb = new StringBuilder(512);
            GetWindowText(hWnd, sb, 512);
            var title = sb.ToString();
            if (title.Length > 0 && title.IndexOf(search, StringComparison.OrdinalIgnoreCase) >= 0) {
                found = hWnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
"@

$hwnd = [Win32Find]::FindByTitle('${escapedTitle}')
if ($hwnd -eq [IntPtr]::Zero) {
    Write-Error "Window not found: ${escapedTitle}"
    exit 1
}
$rect = New-Object Win32Find+RECT
[Win32Find]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
if ($w -le 0 -or $h -le 0) {
    Write-Error "Invalid window dimensions"
    exit 1
}
$bitmap = New-Object System.Drawing.Bitmap($w, $h)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
$bitmap.Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
`;
}

function regionScript(filePath: string): string {
    const escapedPath = filePath.replace(/\\/g, '\\\\').replace(/'/g, "''");

    return `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Capture full screen first (overlay will cover it)
$screen = [System.Windows.Forms.Screen]::PrimaryScreen
$bounds = $screen.Bounds
$fullBitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$fullGraphics = [System.Drawing.Graphics]::FromImage($fullBitmap)
$fullGraphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$fullGraphics.Dispose()

# Darken the background image before creating the form
$darkBitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$darkGraphics = [System.Drawing.Graphics]::FromImage($darkBitmap)
$darkGraphics.DrawImage($fullBitmap, 0, 0)
$brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(100, 0, 0, 0))
$darkGraphics.FillRectangle($brush, 0, 0, $bounds.Width, $bounds.Height)
$darkGraphics.Dispose()
$brush.Dispose()

# Create overlay form - start offscreen to avoid initial flash
$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(-99999, -99999)
$form.Size = $bounds.Size
$form.TopMost = $true
$form.Cursor = [System.Windows.Forms.Cursors]::Cross
$form.ShowInTaskbar = $false
$form.BackColor = [System.Drawing.Color]::Black
$form.BackgroundImage = $darkBitmap

# Enable double-buffering to prevent flicker during repaints
$form.GetType().GetProperty('DoubleBuffered', [System.Reflection.BindingFlags]'Instance,NonPublic').SetValue($form, $true)

# Move form to correct position after first paint is complete
$form.Add_Shown({
    $form.Location = $bounds.Location
    $form.Activate()
})

$script:startPoint = $null
$script:currentPoint = $null
$script:selecting = $false
$script:cancelled = $true

$form.Add_MouseDown({
    $script:startPoint = $_.Location
    $script:selecting = $true
    $script:cancelled = $false
})

$form.Add_MouseMove({
    if ($script:selecting) {
        $script:currentPoint = $_.Location
        $form.Invalidate()
    }
})

$form.Add_MouseUp({
    $script:currentPoint = $_.Location
    $script:selecting = $false
    $form.Close()
})

$form.Add_Paint({
    if ($script:startPoint -and $script:currentPoint) {
        $x = [Math]::Min($script:startPoint.X, $script:currentPoint.X)
        $y = [Math]::Min($script:startPoint.Y, $script:currentPoint.Y)
        $w = [Math]::Abs($script:currentPoint.X - $script:startPoint.X)
        $h = [Math]::Abs($script:currentPoint.Y - $script:startPoint.Y)
        if ($w -gt 0 -and $h -gt 0) {
            # Draw the selected region from the original (bright) screenshot
            $srcRect = New-Object System.Drawing.Rectangle($x, $y, $w, $h)
            $destRect = New-Object System.Drawing.Rectangle($x, $y, $w, $h)
            $_.Graphics.DrawImage($fullBitmap, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
            # Draw border
            $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::Red, 2)
            $_.Graphics.DrawRectangle($pen, $x, $y, $w, $h)
            $pen.Dispose()
        }
    }
})

$form.Add_KeyDown({
    if ($_.KeyCode -eq 'Escape') {
        $script:cancelled = $true
        $form.Close()
    }
})

[System.Windows.Forms.Application]::Run($form)

if (-not $script:cancelled -and $script:startPoint -and $script:currentPoint) {
    $x = [Math]::Min($script:startPoint.X, $script:currentPoint.X)
    $y = [Math]::Min($script:startPoint.Y, $script:currentPoint.Y)
    $w = [Math]::Abs($script:currentPoint.X - $script:startPoint.X)
    $h = [Math]::Abs($script:currentPoint.Y - $script:startPoint.Y)
    if ($w -gt 0 -and $h -gt 0) {
        $crop = $fullBitmap.Clone((New-Object System.Drawing.Rectangle($x, $y, $w, $h)), $fullBitmap.PixelFormat)
        $crop.Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::Png)
        $crop.Dispose()
    } else {
        Write-Error "Selection too small"
        exit 1
    }
} else {
    Write-Error "Selection cancelled"
    exit 1
}

$fullBitmap.Dispose()
$darkBitmap.Dispose()
`;
}

function rectScript(filePath: string, x: number, y: number, width: number, height: number): string {
    const escapedPath = filePath.replace(/\\/g, '\\\\').replace(/'/g, "''");

    return `
Add-Type -AssemblyName System.Drawing

$bitmap = New-Object System.Drawing.Bitmap(${width}, ${height})
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen(${x}, ${y}, 0, 0, (New-Object System.Drawing.Size(${width}, ${height})))
$bitmap.Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
`;
}

function listWindowsScript(): string {
    return `
Get-Process | Where-Object { $_.MainWindowTitle -ne '' } |
    Select-Object Id, ProcessName, MainWindowTitle |
    ForEach-Object { "$($_.Id)|$($_.ProcessName)|$($_.MainWindowTitle)" }
`;
}

// ============================================================
// Platform Implementation
// ============================================================

export const win32Platform: PlatformScreenshot = {
    captureFullscreen(filePath: string, monitor?: number): void {
        runPowerShell(fullscreenScript(filePath, monitor));
    },

    captureActiveWindow(filePath: string): void {
        runPowerShell(activeWindowScript(filePath));
    },

    captureWindow(filePath: string, windowTitle: string): void {
        runPowerShell(windowByTitleScript(filePath, windowTitle));
    },

    captureRegion(filePath: string): void {
        runPowerShell(regionScript(filePath), 120000);
    },

    captureRect(filePath: string, x: number, y: number, width: number, height: number): void {
        runPowerShell(rectScript(filePath, x, y, width, height));
    },

    listWindows(): WindowInfo[] {
        const output = runPowerShell(listWindowsScript());
        if (!output) return [];

        return output.split('\n').filter(Boolean).map(line => {
            const clean = line.replace(/\r/g, '');
            const parts = clean.split('|');
            return {
                pid: parseInt(parts[0], 10),
                process_name: parts[1] || '',
                title: parts.slice(2).join('|'),
            };
        });
    },
};
