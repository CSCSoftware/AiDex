/**
 * Screenshot post-processing - Scale and color reduction
 *
 * Reduces screenshot file size for LLM context by:
 * 1. Scaling down (e.g., 0.5 = 50%)
 * 2. Reducing colors (2/4/16/256 instead of full 24-bit)
 *
 * Platform-specific implementations:
 * - Windows: PowerShell + System.Drawing
 * - macOS: sips + ImageMagick (if available)
 * - Linux: ImageMagick convert
 *
 * v1.13.0
 */

import { execFileSync } from 'child_process';
import { statSync } from 'fs';
import type { ScreenshotColors } from './types.js';
import { hasTool, runPowerShell } from './shared.js';

// ============================================================
// Public Interface
// ============================================================

export interface PostProcessOptions {
    scale?: number;       // 0.25 - 1.0
    colors?: ScreenshotColors;  // 2, 4, 16, 256
}

export interface PostProcessResult {
    original_size: number;
    optimized_size: number;
}

/**
 * Post-process a screenshot file in-place.
 * Returns original and optimized file sizes.
 */
export function postProcess(filePath: string, options: PostProcessOptions): PostProcessResult {
    const original_size = statSync(filePath).size;

    if (!options.scale && !options.colors) {
        return { original_size, optimized_size: original_size };
    }

    switch (process.platform) {
        case 'win32':
            postProcessWindows(filePath, options);
            break;
        case 'darwin':
            postProcessDarwin(filePath, options);
            break;
        case 'linux':
            postProcessLinux(filePath, options);
            break;
        default:
            throw new Error(`Post-processing not supported on ${process.platform}`);
    }

    const optimized_size = statSync(filePath).size;
    return { original_size, optimized_size };
}

// ============================================================
// Windows - PowerShell + System.Drawing
// ============================================================

function postProcessWindows(filePath: string, options: PostProcessOptions): void {
    const escapedPath = filePath.replace(/\\/g, '\\\\').replace(/'/g, "''");
    const scale = options.scale ?? 1.0;
    const colors = options.colors;

    // Map color count to bits-per-pixel for indexed formats
    const colorToBpp: Record<number, number> = { 2: 1, 4: 4, 16: 4, 256: 8 };
    const bpp = colors ? colorToBpp[colors] : undefined;

    // Build PowerShell script that:
    // 1. Loads the image
    // 2. Optionally scales it
    // 3. Optionally reduces colors via indexed pixel format
    // 4. Saves as PNG
    const script = `
Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Image]::FromFile('${escapedPath}')

# Calculate new dimensions
$newW = [int]([Math]::Round($src.Width * ${scale}))
$newH = [int]([Math]::Round($src.Height * ${scale}))

# Create scaled bitmap
$scaled = New-Object System.Drawing.Bitmap($newW, $newH)
$g = [System.Drawing.Graphics]::FromImage($scaled)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($src, 0, 0, $newW, $newH)
$g.Dispose()
$src.Dispose()

${bpp !== undefined ? `
# Color reduction: Convert to ${colors}-color indexed format
# Clone with indexed pixel format
$pixelFormat = [System.Drawing.Imaging.PixelFormat]::Format${bpp === 1 ? '1bppIndexed' : bpp === 4 ? '4bppIndexed' : '8bppIndexed'}

# For indexed formats, we need to quantize manually
# System.Drawing's Clone with indexed format does basic nearest-color mapping
$indexed = $scaled.Clone([System.Drawing.Rectangle]::new(0, 0, $scaled.Width, $scaled.Height), $pixelFormat)
$scaled.Dispose()

# For 2-color (1bpp): the default palette is B&W which is exactly what we want
# For 4-color: we limit to first 4 entries (already handled by 4bpp format's palette)
# For 16/256: the indexed format handles it
${colors === 2 ? `
# 1bpp gives us pure black & white - perfect for text screenshots
` : colors === 4 ? `
# 4bpp with limited palette - good text readability with some gray shading
` : ''}
$indexed.Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::Png)
$indexed.Dispose()
` : `
$scaled.Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::Png)
$scaled.Dispose()
`}
`;

    runPowerShell(script);
}

// ============================================================
// macOS - sips + convert
// ============================================================

function postProcessDarwin(filePath: string, options: PostProcessOptions): void {
    const scale = options.scale ?? 1.0;
    const colors = options.colors;

    // Scale with sips (built-in)
    if (scale < 1.0) {
        // Get current dimensions
        const widthStr = execFileSync('sips', ['-g', 'pixelWidth', filePath], {
            encoding: 'utf8', timeout: 10000,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const match = widthStr.match(/pixelWidth:\s*(\d+)/);
        const newWidth = match ? Math.round(parseInt(match[1], 10) * scale) : 0;
        if (newWidth > 0) {
            execFileSync('sips', ['--resampleWidth', String(newWidth), filePath], {
                timeout: 10000,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        }
    }

    // Color reduction with ImageMagick (if available)
    const convertCmd = hasTool('magick') ? 'magick' : hasTool('convert') ? 'convert' : null;
    if (colors && convertCmd) {
        execFileSync(convertCmd, [filePath, '-colors', String(colors), '-type', 'Palette', `PNG8:${filePath}`], {
            timeout: 30000,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    }
}

// ============================================================
// Linux - ImageMagick convert
// ============================================================

function postProcessLinux(filePath: string, options: PostProcessOptions): void {
    const scale = options.scale ?? 1.0;
    const colors = options.colors;

    // Determine the convert command (ImageMagick 6 vs 7)
    let convertCmd: string;
    if (hasTool('magick')) {
        convertCmd = 'magick';
    } else if (hasTool('convert')) {
        convertCmd = 'convert';
    } else {
        throw new Error('ImageMagick not found. Install it: sudo apt install imagemagick');
    }

    const args: string[] = [filePath];

    if (scale < 1.0) {
        const pct = Math.round(scale * 100);
        args.push('-resize', `${pct}%`);
    }

    if (colors) {
        args.push('-colors', String(colors), '-type', 'Palette', `PNG8:${filePath}`);
    } else {
        args.push(filePath);
    }

    execFileSync(convertCmd, args, {
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
}
