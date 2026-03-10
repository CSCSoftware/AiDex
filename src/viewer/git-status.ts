/**
 * Git status utilities for AiDex Viewer
 *
 * Provides git status per file to show colored cat icons:
 * - untracked (gray): Git doesn't know about file
 * - modified (yellow): Changed, not committed
 * - committed (blue): Committed locally, not pushed
 * - pushed (green): In sync with remote
 */

import { simpleGit, SimpleGit, StatusResult } from 'simple-git';
import path from 'path';
import { normalizePath } from '../commands/shared.js';

// ============================================================
// Types
// ============================================================

export type GitFileStatus = 'untracked' | 'modified' | 'committed' | 'pushed';

export interface GitStatusInfo {
    isGitRepo: boolean;
    hasRemote: boolean;
    fileStatuses: Map<string, GitFileStatus>;
}

// ============================================================
// Implementation
// ============================================================

/**
 * Check if a directory is inside a git repository (traverses parent dirs)
 */
export async function isGitRepo(projectPath: string): Promise<boolean> {
    try {
        return await simpleGit(projectPath).checkIsRepo();
    } catch {
        return false;
    }
}

/**
 * Get git status for all files in a project
 * Returns a map of relative file paths to their git status
 */
export async function getGitStatus(projectPath: string): Promise<GitStatusInfo> {
    if (!await isGitRepo(projectPath)) {
        return {
            isGitRepo: false,
            hasRemote: false,
            fileStatuses: new Map()
        };
    }

    const git: SimpleGit = simpleGit(projectPath);
    const fileStatuses = new Map<string, GitFileStatus>();

    try {
        // Determine git repo root and compute prefix for subfolder projects
        const gitRoot = normalizePath((await git.revparse(['--show-toplevel'])).trim());
        const absProject = normalizePath(path.resolve(projectPath));
        const prefix = absProject === gitRoot ? '' : absProject.slice(gitRoot.length + 1) + '/';

        // Helper: convert git-root-relative path to project-relative path
        // Returns null if the file is outside this project subfolder
        const toProjectRelative = (gitRelPath: string): string | null => {
            const normalized = normalizePath(gitRelPath);
            if (!prefix) return normalized;
            if (normalized.startsWith(prefix)) return normalized.slice(prefix.length);
            return null; // file outside this project
        };

        // Get current status (uncommitted changes)
        const status: StatusResult = await git.status();

        // Mark untracked files
        for (const file of status.not_added) {
            const rel = toProjectRelative(file);
            if (rel !== null) fileStatuses.set(rel, 'untracked');
        }

        // Mark modified/staged files (not yet committed)
        for (const file of status.modified) {
            const rel = toProjectRelative(file);
            if (rel !== null) fileStatuses.set(rel, 'modified');
        }
        for (const file of status.staged) {
            const rel = toProjectRelative(file);
            if (rel !== null) fileStatuses.set(rel, 'modified');
        }
        for (const file of status.created) {
            const rel = toProjectRelative(file);
            if (rel !== null) fileStatuses.set(rel, 'modified');
        }
        for (const file of status.deleted) {
            const rel = toProjectRelative(file);
            if (rel !== null) fileStatuses.set(rel, 'modified');
        }
        for (const file of status.renamed.map(r => r.to)) {
            const rel = toProjectRelative(file);
            if (rel !== null) fileStatuses.set(rel, 'modified');
        }

        // Check if remote exists
        let hasRemote = false;
        try {
            const remotes = await git.getRemotes();
            hasRemote = remotes.length > 0;
        } catch {
            // No remotes
        }

        if (hasRemote) {
            // Get files that are committed locally but not pushed
            try {
                // Get current branch
                const branch = await git.revparse(['--abbrev-ref', 'HEAD']);
                const currentBranch = branch.trim();

                // Check if remote tracking branch exists
                const trackingBranch = `origin/${currentBranch}`;

                try {
                    // Get commits ahead of remote
                    const log = await git.log([`${trackingBranch}..HEAD`, '--name-only']);

                    // Extract files from commits that haven't been pushed
                    for (const commit of log.all) {
                        // The diff field contains changed files
                        const diff = (commit as unknown as { diff?: { files: Array<{ file: string }> } }).diff;
                        if (diff?.files) {
                            for (const file of diff.files) {
                                const rel = toProjectRelative(file.file);
                                // Only mark as committed if not already modified/untracked
                                if (rel !== null && !fileStatuses.has(rel)) {
                                    fileStatuses.set(rel, 'committed');
                                }
                            }
                        }
                    }

                    // Alternative: use diff to get files
                    const diffOutput = await git.diff(['--name-only', trackingBranch, 'HEAD']);
                    if (diffOutput) {
                        for (const file of diffOutput.split('\n').filter(f => f.trim())) {
                            const rel = toProjectRelative(file);
                            if (rel !== null && !fileStatuses.has(rel)) {
                                fileStatuses.set(rel, 'committed');
                            }
                        }
                    }
                } catch {
                    // No tracking branch or other error - ignore
                }
            } catch {
                // Could not determine branch - ignore
            }
        }

        return {
            isGitRepo: true,
            hasRemote,
            fileStatuses
        };

    } catch (error) {
        console.error('Error getting git status:', error);
        return {
            isGitRepo: true,
            hasRemote: false,
            fileStatuses: new Map()
        };
    }
}

