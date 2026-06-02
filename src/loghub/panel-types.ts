/**
 * Debug Dashboard — Panel Widget Types
 *
 * Shared types for the live debug dashboard. Unlike the scrolling log stream,
 * panel widgets have a fixed slot keyed by `id`: sending the same id again
 * overwrites the value in place instead of scrolling away. Designed for
 * high-frequency / repeated values (audio levels, buffer fill, FPS, etc.).
 *
 * Sibling of log-types.ts — same HTTP-ingest → broadcast flow.
 */

export type WidgetType = 'label' | 'progress' | 'gauge' | 'plot';

/**
 * HTTP body for POST /panel (and array of these for POST /panels).
 * Only `id` and `type` are required; everything else has sensible defaults.
 */
export interface PanelHttpEntry {
    id?: string;
    type?: string;
    value?: number | string | number[];
    group?: string;
    label?: string;
    unit?: string;
    min?: number;
    max?: number;
    warn?: number;          // threshold → yellow zone (gauge/progress)
    crit?: number;          // threshold → red zone (gauge/progress)
    color?: string;         // accent name (cyan/green/orange/...) or hex
    order?: number;         // sort order within a group
}

/**
 * Server-side widget state (kept in PanelStore, one per id).
 * For plots, `history` is a ring of the most recent numeric samples.
 */
export interface PanelWidget {
    id: string;
    type: WidgetType;
    value: number | string;     // current scalar value (last sample for plots)
    group: string;
    label: string;
    unit?: string;
    min: number;
    max: number;
    warn?: number;
    crit?: number;
    color?: string;
    order: number;
    history?: number[];         // plot: recent samples (cap PLOT_HISTORY)
    lastUpdate: number;         // ms — for stale detection (viewer-side)
}

export interface PanelClearParams {
    id?: string;                // omit → clear all
}
