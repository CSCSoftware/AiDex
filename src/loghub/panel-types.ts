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
    state?: string;         // gauge LED colour ("ok"|"warn"|"error"|...) — when
                            // set, drives the LED colour while `value` stays the
                            // free display text (so colour != shown text).
    scale?: string;         // plot Y-axis: "linear" (default) | "log". The SENDER
                            // decides — AiDex only renders. "log" suits audio
                            // levels (quiet speech + loud peak both visible).
    decimals?: number;      // plot footer (cur/min/max/avg) decimal places. The
                            // sender controls precision (0 = integers).
    autoMin?: boolean;      // plot: lower bound follows the data minimum instead
                            // of the fixed `min`. Upper bound stays `max`. Lets a
                            // log plot sit the noise floor at the bottom edge so
                            // the full height is used for the signal above it.
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
    state?: string;             // optional gauge LED colour, independent of value
    scale?: string;             // plot Y-axis: "linear" (default) | "log"
    decimals?: number;          // plot footer decimal places (sender-controlled)
    autoMin?: boolean;          // plot: lower bound follows the data minimum
    history?: number[];         // plot: recent samples (cap PLOT_HISTORY)
    lastUpdate: number;         // ms — for stale detection (viewer-side)
}

export interface PanelClearParams {
    id?: string;                // omit → clear all
}
