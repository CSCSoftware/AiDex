/**
 * Update triggers — incremental re-embedding hooks.
 *
 * v1.19b: interface only. Implementation in v1.23.
 */

export type TriggerSource = 'aidex_update' | 'viewer_watcher' | 'session_diff' | 'manual';

export async function onFileChanged(
    _projectPath: string,
    _filePath: string,
    _source: TriggerSource
): Promise<void> {
    // Skeleton: no-op.
}
