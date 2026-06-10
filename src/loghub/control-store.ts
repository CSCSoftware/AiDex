/**
 * Debug Dashboard — Control Store
 *
 * Holds the current value of every INTERACTIVE control (slider / number),
 * keyed by widget id, as a flat id→value map. This is the back-channel of the
 * dashboard: a source defines a `slider`/`number` widget (POST /panels), the
 * viewer renders an editable input, and when the user changes it the viewer
 * writes the new value here (POST /control). The source then reads its own
 * values back at its own pace (GET /control).
 *
 * Deliberately dumb and generic: the store knows nothing about what a value
 * MEANS or which source owns it — it is a plain key→value bag. Each source
 * knows its own ids and picks out what it needs. GeminiPod's barge-in tuning
 * is just the first consumer; a C# or Python tool would use the exact same API.
 *
 * Sibling of panel-store.ts (PanelStore) — same singleton-state pattern.
 */

const MAX_CONTROLS = 500;   // safety cap on distinct control ids

export class ControlStore {
    // Flat id → current value. Numbers for slider/number; strings allowed so a
    // future text/select control needs no store change.
    private values = new Map<string, number | string>();

    /**
     * Set a control's value. Returns true if stored, false if rejected
     * (empty id, non-finite number, or capacity exceeded for a new id).
     */
    set(id: string, value: number | string): boolean {
        if (typeof id !== 'string' || !id.trim()) return false;
        const key = id.trim();
        if (typeof value === 'number') {
            if (!Number.isFinite(value)) return false;
        } else if (typeof value !== 'string') {
            return false;
        }
        if (!this.values.has(key) && this.values.size >= MAX_CONTROLS) return false;
        this.values.set(key, value);
        return true;
    }

    /** Current value of one control, or undefined if never set. */
    get(id: string): number | string | undefined {
        return this.values.get(id.trim());
    }

    /** The whole store as a flat { id: value } object — this is what GET /control returns. */
    getAll(): Record<string, number | string> {
        const out: Record<string, number | string> = {};
        for (const [k, v] of this.values) out[k] = v;
        return out;
    }

    /** Remove one control (by id) or all (no id). */
    clear(id?: string): void {
        if (id && id.trim()) this.values.delete(id.trim());
        else this.values.clear();
    }

    get size(): number {
        return this.values.size;
    }
}
