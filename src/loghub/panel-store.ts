/**
 * Debug Dashboard — Panel Store
 *
 * Holds the current state of every dashboard widget, keyed by id. An upsert
 * with an existing id overwrites that widget's value in place (the whole point
 * of the dashboard vs. the scrolling log). Plots keep a short ring of recent
 * samples so a freshly-connected viewer can draw the curve immediately.
 *
 * Sibling of log-buffer.ts (LogBuffer) — same singleton-state pattern.
 */

import type { PanelHttpEntry, PanelWidget, WidgetType } from './panel-types.js';

const VALID_TYPES = new Set<WidgetType>(['label', 'progress', 'gauge', 'plot']);
const PLOT_HISTORY = 200;          // samples kept per plot widget
const MAX_FRAME_SAMPLES = 4096;    // cap when a full array frame is sent
const MAX_WIDGETS = 500;           // safety cap on distinct widget ids

export class PanelStore {
    private widgets = new Map<string, PanelWidget>();

    /**
     * Create or update a widget from an HTTP body. Returns the resulting
     * widget, or null if the body is invalid (missing/empty id or bad type).
     */
    upsert(body: PanelHttpEntry): PanelWidget | null {
        if (!body || typeof body.id !== 'string' || !body.id.trim()) return null;
        const id = body.id.trim();

        const type = (typeof body.type === 'string' && VALID_TYPES.has(body.type as WidgetType))
            ? (body.type as WidgetType)
            : undefined;

        const existing = this.widgets.get(id);
        // type is required to CREATE a widget, but a follow-up update may omit it.
        if (!existing && !type) return null;
        if (!existing && this.widgets.size >= MAX_WIDGETS) return null;

        const w: PanelWidget = existing ?? {
            id,
            type: type!,
            value: 0,
            group: 'Default',
            label: id,
            min: 0,
            max: 100,
            order: 0,
            lastUpdate: 0,
        };

        if (type) w.type = type;
        if (typeof body.group === 'string') w.group = body.group;
        if (typeof body.label === 'string') w.label = body.label;
        if (typeof body.unit === 'string') w.unit = body.unit;
        if (typeof body.min === 'number') w.min = body.min;
        if (typeof body.max === 'number') w.max = body.max;
        if (typeof body.warn === 'number') w.warn = body.warn;
        if (typeof body.crit === 'number') w.crit = body.crit;
        if (typeof body.color === 'string') w.color = body.color;
        if (typeof body.order === 'number') w.order = body.order;
        if (typeof body.state === 'string') w.state = body.state;
        if (typeof body.scale === 'string') w.scale = body.scale;
        if (typeof body.decimals === 'number') w.decimals = body.decimals;
        if (typeof body.autoMin === 'boolean') w.autoMin = body.autoMin;

        // Value handling depends on type.
        if (w.type === 'plot') {
            const hist = w.history ?? (w.history = []);
            if (Array.isArray(body.value)) {
                // Full frame: replace the history with this array (capped).
                const arr = body.value
                    .filter((n) => typeof n === 'number' && Number.isFinite(n))
                    .slice(-MAX_FRAME_SAMPLES);
                w.history = arr.slice(-PLOT_HISTORY);
                w.value = arr.length ? arr[arr.length - 1] : 0;
            } else if (typeof body.value === 'number' && Number.isFinite(body.value)) {
                // Single sample: append to the ring.
                hist.push(body.value);
                if (hist.length > PLOT_HISTORY) hist.splice(0, hist.length - PLOT_HISTORY);
                w.value = body.value;
            }
        } else {
            // label/progress/gauge: scalar (number or status string).
            if (typeof body.value === 'number' && Number.isFinite(body.value)) {
                w.value = body.value;
            } else if (typeof body.value === 'string') {
                w.value = body.value;
            }
        }

        w.lastUpdate = Date.now();
        this.widgets.set(id, w);
        return w;
    }

    /** All widgets — for a freshly-connected viewer (snapshot on connect). */
    snapshot(): PanelWidget[] {
        return [...this.widgets.values()];
    }

    /** Remove one widget (by id) or all (no id). Returns the cleared id, or null for "all". */
    clear(id?: string): string | null {
        if (id && id.trim()) {
            this.widgets.delete(id.trim());
            return id.trim();
        }
        this.widgets.clear();
        return null;
    }

    get size(): number {
        return this.widgets.size;
    }
}
