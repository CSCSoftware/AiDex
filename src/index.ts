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
 */

import { createServer } from './server/mcp-server.js';
import { scan, init, globalInit } from './commands/index.js';
import { setupMcpClients, unsetupMcpClients } from './commands/setup.js';
import { PRODUCT_NAME, PRODUCT_NAME_LOWER } from './constants.js';
import { stopViewer } from './viewer/server.js';
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
