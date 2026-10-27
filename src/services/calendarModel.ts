import { fromMinutes, toMinutes } from "../parser/time";
import { DateField, Task, TaskPatch } from "../types";

/**
 * Pure calendar logic: where a task sits, how multi-day bars and overlapping time blocks are laid out,
 * and which date/time changes a move or resize produces. No DOM and no Obsidian API, so it is unit-testable.
 */

const DAY_MS = 86400000;
export const DAY_MINUTES = 24 * 60;
export const SNAP_MINUTES = 15;

function parseIso(iso: string): number {
	const [y, m, d] = iso.split("-").map(Number);
	return Date.UTC(y, m - 1, d);
}

function formatIso(ms: number): string {
	const d = new Date(ms);
	const p = (n: number) => (n < 10 ? `0${n}` : String(n));
	return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

export function shiftIso(iso: string, days: number): string {
	return formatIso(parseIso(iso) + days * DAY_MS);
}

/** Whole days from `a` to `b`. */
export function diffDays(a: string, b: string): number {
	return Math.round((parseIso(b) - parseIso(a)) / DAY_MS);
}

export function snap(min: number): number {
	return Math.round(min / SNAP_MINUTES) * SNAP_MINUTES;
}

export interface CalItem {
	task: Task;
	/** First and last day (inclusive). Equal for single-day tasks. */
	start: string;
	end: string;
	/** Multi-day bar: 🛫 start before 📅 due. */
	span: boolean;
	/** Has a time and is a single-day task, so it goes into the hour grid. */
	timed: boolean;
	startMin: number;
	endMin: number;
}

/** Where a task appears on the calendar, or null if it has no date. */
export function toItem(task: Task, defaultDuration: number): CalItem | null {
	const { due, start } = task.dates;
	let s = 0;
	let e = 0;
	if (task.time) {
		s = toMinutes(task.time.start);
		e = task.time.end ? toMinutes(task.time.end) : s + defaultDuration;
		if (e <= s) e = s + defaultDuration;
		e = Math.min(e, DAY_MINUTES);
	}
	if (start && due && start < due) {
		return { task, start, end: due, span: true, timed: false, startMin: s, endMin: e };
	}
	const date = due ?? task.dates.scheduled ?? start;
	if (!date) return null;
	return { task, start: date, end: date, span: false, timed: !!task.time, startMin: s, endMin: e };
}

export function itemsInRange(
	tasks: Task[],
	from: string,
	to: string,
	defaultDuration: number,
	showCompleted: boolean,
): CalItem[] {
	const out: CalItem[] = [];
	for (const task of tasks) {
		const open = task.status.type === "todo" || task.status.type === "in_progress";
		if (!open && !showCompleted) continue;
		const item = toItem(task, defaultDuration);
		if (item && item.start <= to && item.end >= from) out.push(item);
	}
	return out;
}

export interface PlacedBar {
	item: CalItem;
	lane: number;
	/** Column indexes (inclusive) within the row of days. */
	from: number;
	to: number;
	/** The bar starts / ends inside this row (otherwise it continues from / into the neighbouring row). */
	startsHere: boolean;
	endsHere: boolean;
}

/** Packs multi-day bars of one week row into as few lanes as possible, longest first. */
export function layoutBars(items: CalItem[], days: string[]): { bars: PlacedBar[]; lanes: number } {
	const first = days[0];
	const last = days[days.length - 1];
	const spans = items
		.filter((x) => x.span && x.start <= last && x.end >= first)
		.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : diffDays(b.start, b.end) - diffDays(a.start, a.end)));
	const laneEnds: number[] = [];
	const bars: PlacedBar[] = [];
	for (const item of spans) {
		const from = Math.max(0, diffDays(first, item.start));
		const to = Math.min(days.length - 1, diffDays(first, item.end));
		let lane = laneEnds.findIndex((end) => end < from);
		if (lane < 0) {
			lane = laneEnds.length;
			laneEnds.push(to);
		} else {
			laneEnds[lane] = to;
		}
		bars.push({ item, lane, from, to, startsHere: item.start >= first, endsHere: item.end <= last });
	}
	return { bars, lanes: laneEnds.length };
}

export interface PlacedBlock {
	item: CalItem;
	col: number;
	cols: number;
}

/** Side-by-side columns for overlapping time blocks of one day. */
export function layoutTimed(items: CalItem[]): PlacedBlock[] {
	const sorted = [...items].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
	const out: PlacedBlock[] = [];
	let cluster: PlacedBlock[] = [];
	let clusterEnd = -1;
	let colEnds: number[] = [];
	const flush = () => {
		const cols = colEnds.length;
		for (const b of cluster) b.cols = cols;
		out.push(...cluster);
		cluster = [];
		colEnds = [];
	};
	for (const item of sorted) {
		if (cluster.length && item.startMin >= clusterEnd) flush();
		let col = colEnds.findIndex((end) => end <= item.startMin);
		if (col < 0) {
			col = colEnds.length;
			colEnds.push(item.endMin);
		} else {
			colEnds[col] = item.endMin;
		}
		cluster.push({ item, col, cols: 1 });
		clusterEnd = Math.max(clusterEnd, item.endMin);
	}
	flush();
	return out;
}

/** Order of tasks within one day: timed first by time, then the rest by priority. Used for Tab navigation. */
export function dayOrder(items: CalItem[]): CalItem[] {
	return [...items].sort(
		(a, b) =>
			Number(!a.task.time) - Number(!b.task.time) ||
			a.startMin - b.startMin ||
			b.task.priority - a.task.priority ||
			a.task.title.localeCompare(b.task.title),
	);
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

const MOVABLE: DateField[] = ["due", "start", "scheduled"];

/** Shifts every planning date the task has by `delta` days (keeps span length and scheduled offsets). */
export function moveByDays(task: Task, delta: number): TaskPatch {
	const dates: TaskPatch["dates"] = {};
	if (delta === 0) return { dates };
	for (const f of MOVABLE) {
		const d = task.dates[f];
		if (d) dates[f] = shiftIso(d, delta);
	}
	return { dates };
}

/** Drop into the hour grid at `date` / `startMin`. A multi-day bar collapses into a single-day time block. */
export function moveToTime(item: CalItem, date: string, startMin: number, defaultDuration: number): TaskPatch {
	const duration = item.timed ? item.endMin - item.startMin : defaultDuration;
	const s = Math.max(0, Math.min(DAY_MINUTES - SNAP_MINUTES, snap(startMin)));
	const e = Math.min(DAY_MINUTES, s + duration);
	const dates = item.span ? { start: null, due: date } : moveByDays(item.task, diffDays(item.start, date)).dates;
	return { dates, time: { start: fromMinutes(s), end: fromMinutes(e) } };
}

/** Changes the last day. Stretching a single-day task turns it into a span (🛫 start + 📅 due). */
export function resizeEnd(item: CalItem, date: string): TaskPatch | null {
	if (date === item.end) return null;
	if (date <= item.start) {
		return item.span ? { dates: { start: null, due: item.start } } : null;
	}
	return { dates: { start: item.start, due: date } };
}

/** Changes the first day of a span (or makes a single-day task start earlier). */
export function resizeStart(item: CalItem, date: string): TaskPatch | null {
	if (date === item.start) return null;
	if (date >= item.end) return item.span ? { dates: { start: null, due: item.end } } : null;
	return { dates: { start: date, due: item.end } };
}

/** Changes the end time of a time block; at least one snap step long. */
export function resizeDuration(item: CalItem, endMin: number): TaskPatch | null {
	if (!item.task.time) return null;
	const e = Math.max(item.startMin + SNAP_MINUTES, Math.min(DAY_MINUTES, snap(endMin)));
	if (e === item.endMin && item.task.time.end) return null;
	return { time: { start: item.task.time.start, end: fromMinutes(e) } };
}

/** Changes the start time and keeps the end time; at least one snap step long. */
export function resizeTimeStart(item: CalItem, startMin: number): TaskPatch | null {
	if (!item.task.time) return null;
	const s = Math.max(0, Math.min(item.endMin - SNAP_MINUTES, snap(startMin)));
	if (s === item.startMin) return null;
	return { time: { start: fromMinutes(s), end: fromMinutes(item.endMin) } };
}

/** Moves a time block by `deltaMin` minutes within its day. */
export function shiftTime(item: CalItem, deltaMin: number): TaskPatch | null {
	if (!item.task.time) return null;
	const duration = item.endMin - item.startMin;
	const s = Math.max(0, Math.min(DAY_MINUTES - duration, item.startMin + deltaMin));
	if (s === item.startMin) return null;
	return { time: { start: fromMinutes(s), end: fromMinutes(s + duration) } };
}
