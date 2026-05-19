/**
 * Embedding worker — runs as a standalone child process via spawn().
 *
 * Reads a JSON request from stdin, runs the full embedding pipeline,
 * writes a JSON result to stdout, then exits.
 *
 * Communication is via stdin/stdout JSON (not IPC) so the worker has its
 * own heap and an ONNX OOM crash kills only this process, not the MCP server.
 */

import { createRealModule } from './pipeline.js';

async function main() {
    let input = '';
    process.stdin.setEncoding('utf-8');
    for await (const chunk of process.stdin) {
        input += chunk;
    }

    let msg: { projectPath: string; force?: boolean };
    try {
        msg = JSON.parse(input);
    } catch {
        process.stdout.write(JSON.stringify({ ok: false, error: 'Invalid JSON input' }));
        process.exit(1);
    }

    try {
        const embeddings = createRealModule();
        await embeddings.enable(msg.projectPath);
        const result = await embeddings.indexProject(msg.projectPath, { force: msg.force });
        process.stdout.write(JSON.stringify({ ok: true, ...result }));
        process.exit(0);
    } catch (err: any) {
        process.stdout.write(JSON.stringify({ ok: false, error: err?.message ?? String(err) }));
        process.exit(1);
    }
}

main();
