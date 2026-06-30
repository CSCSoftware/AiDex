#!/usr/bin/env node
/**
 * AiDex - MCP Server Entry Point
 *
 * Provides persistent code indexing for Claude Code.
 *
 * Usage:
 *   node build/index.js                       - Start MCP server (default)
 *   node build/index.js scan <path>           - Scan for .aidex directories
 *   node build/index.js init <path>           - Index a project
 *   node build/index.js global-init <path>    - Scan, index unindexed, register in global DB
 *   node build/index.js viewer <path>         - Open interactive Viewer in the browser
 */

// Node >=20 is required (better-sqlite3 v12 native bindings, fs.cpSync, etc.).
// npm only warns on `engines` mismatches — we enforce it at runtime so users
// on older Node versions get an immediate, actionable error instead of an
// opaque native-module crash later.
{
    const major = parseInt(process.versions.node.split('.')[0], 10);
    if (Number.isNaN(major) || major < 20) {
        process.stderr.write(
            `AiDex requires Node.js 20 or newer. You are running ${process.version}.\n` +
            `  macOS:  brew install node  (or: nvm install 20 && nvm use 20)\n` +
            `  Linux:  use your package manager or nvm (https://github.com/nvm-sh/nvm)\n` +
            `  Windows: https://nodejs.org/\n`
        );
        process.exit(1);
    }
}

import { createServer } from './server/mcp-server.js';
import { scan, init, globalInit } from './commands/index.js';
import { setupMcpClients, unsetupMcpClients } from './commands/setup.js';
import { PRODUCT_NAME, PRODUCT_NAME_LOWER } from './constants.js';
import { startViewer, stopViewer } from './viewer/server.js';
import { freeLogHub } from './loghub/log-server.js';

async function main() {
    const args = process.argv.slice(2);

    // CLI mode: scan
    if (args[0] === 'scan') {
        const searchPath = args[1];
        if (!searchPath) {
            console.error(`Usage: ${PRODUCT_NAME_LOWER} scan <path>`);
            process.exit(1);
        }

        const result = scan({ path: searchPath });

        if (!result.success) {
            console.error(`Error: ${result.error}`);
            process.exit(1);
        }

        console.log(`\n${PRODUCT_NAME} Indexes Found: ${result.projects.length}`);
        console.log(`Scanned: ${result.scannedDirs} directories\n`);

        if (result.projects.length === 0) {
            console.log('No indexed projects found.');
        } else {
            for (const proj of result.projects) {
                console.log(`${proj.name}`);
                console.log(`  Path: ${proj.path}`);
                console.log(`  Files: ${proj.files} | Items: ${proj.items} | Methods: ${proj.methods} | Types: ${proj.types}`);
                console.log(`  Last indexed: ${proj.lastIndexed}`);
                console.log();
            }
        }

        return;
    }

    // CLI mode: init
    if (args[0] === 'init') {
        const projectPath = args[1];
        if (!projectPath) {
            console.error(`Usage: ${PRODUCT_NAME_LOWER} init <path>`);
            process.exit(1);
        }

        console.log(`Indexing: ${projectPath}`);
        const result = await init({ path: projectPath });

        if (!result.success) {
            console.error(`Error: ${result.errors.join(', ')}`);
            process.exit(1);
        }

        console.log(`Done!`);
        console.log(`  Files: ${result.filesIndexed}`);
        console.log(`  Items: ${result.itemsFound}`);
        console.log(`  Methods: ${result.methodsFound}`);
        console.log(`  Types: ${result.typesFound}`);
        console.log(`  Time: ${result.durationMs}ms`);

        return;
    }

    // CLI mode: global-init
    if (args[0] === 'global-init') {
        const searchPath = args[1];
        if (!searchPath) {
            console.error(`Usage: ${PRODUCT_NAME_LOWER} global-init <path> [--index-unindexed]`);
            process.exit(1);
        }

        const indexUnindexed = args.includes('--index-unindexed');
        const showProgress = args.includes('--show-progress');

        console.log(`Scanning: ${searchPath}${indexUnindexed ? ' (will index unindexed projects)' : ''}${showProgress ? ' (with progress UI)' : ''}`);
        const result = await globalInit({
            path: searchPath,
            indexUnindexed,
            showProgress,
        });

        if (!result.success) {
            console.error(`Error: ${result.error}`);
            process.exit(1);
        }

        console.log(`Done!`);
        console.log(`  Registered: ${result.registered}`);
        console.log(`  New: ${result.newProjects}`);
        console.log(`  Updated: ${result.updatedProjects}`);
        console.log(`  Removed: ${result.removedProjects}`);

        if (result.indexedResults && result.indexedResults.length > 0) {
            const ok = result.indexedResults.filter(r => r.success).length;
            const fail = result.indexedResults.filter(r => !r.success).length;
            console.log(`  Indexed: ${ok} succeeded, ${fail} failed`);
        }

        if (result.unindexedProjects.length > 0) {
            console.log(`\n  Unindexed projects found: ${result.unindexedProjects.length}`);
            for (const p of result.unindexedProjects) {
                console.log(`    ${p.name} (${p.path}) ~${p.estimatedFiles} files`);
            }
        }

        if (result.largeProjects && result.largeProjects.length > 0) {
            console.log(`\n  Large projects skipped (>500 files): ${result.largeProjects.length}`);
            for (const p of result.largeProjects) {
                console.log(`    ${p.name} (${p.path}) ~${p.estimatedFiles} files`);
            }
        }

        console.log(`\n  Totals: ${result.totals.projects} projects | ${result.totals.files} files | ${result.totals.methods} methods | ${result.totals.types} types`);
        return;
    }

    // CLI mode: viewer
    if (args[0] === 'viewer') {
        const projectPath = args[1] || process.cwd();
        const tabArg = args.find(a => a.startsWith('--tab='));
        const initialTab = tabArg ? tabArg.slice('--tab='.length) : undefined;

        console.log(`Starting Viewer for: ${projectPath}`);
        let result: string;
        try {
            result = await startViewer(projectPath, initialTab, { exitOnLastClientClose: true });
            console.log(result);
        } catch (err) {
            console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
        }

        // If the port was already in use, another viewer instance is serving.
        // We just opened the browser — no need to keep this CLI process alive.
        // Exit code 2 signals "already running" so the launcher can keep its
        // console window open for the user to read the message.
        // Small delay so the detached browser-spawn definitely completes before
        // this process (and any inherited stdio) goes away.
        if (result.includes('already in use')) {
            await new Promise(r => setTimeout(r, 400));
            process.exit(2);
        }

        console.log('Server runs until you close the browser tab or press Ctrl+C.');

        // Keep the process alive — the viewer runs until SIGINT.
        const shutdownViewer = () => {
            try { console.log(stopViewer()); } catch { /* ignore */ }
            process.exit(0);
        };
        process.on('SIGINT', shutdownViewer);
        process.on('SIGTERM', shutdownViewer);
        return;
    }

    // CLI mode: setup
    if (args[0] === 'setup') {
        setupMcpClients();
        return;
    }

    // CLI mode: unsetup
    if (args[0] === 'unsetup') {
        unsetupMcpClients();
        return;
    }

    // Default: Start MCP server
    const server = createServer();

    // Graceful shutdown handlers
    const shutdown = () => {
        freeLogHub();
        stopViewer();
        process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    await server.start();
}

main().catch((error) => {
    console.error(`Failed to start ${PRODUCT_NAME}:`, error);
    process.exit(1);
});
