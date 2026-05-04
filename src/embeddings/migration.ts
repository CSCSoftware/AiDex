/**
 * Model migration — re-embed projects when the active model changes.
 *
 * v1.19b: interface only. Implementation in v1.23.
 */

import type { MigrateOptions, MigrationResult } from './index.js';

export async function runMigration(_opts: MigrateOptions): Promise<MigrationResult> {
    throw new Error('runMigration() not implemented in v1.19b skeleton.');
}
