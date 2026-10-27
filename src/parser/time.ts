import { TaskTime } from "../types";

/**
 * Time is stored as a prefix of the task text, Day Planner style:
 *   - [ ] 10:00 Stand-up
 *   - [ ] 10:00 - 11:30 Deep work 📅 2026-08-03
 * Tasks and Dataview treat it as ordinary text, so both keep working.
 */
const TIME_PREFIX = /^(\d{1,2}):(\d{2})(?:[ \t]*[-–—][ \t]*(\d{1,2}):(\d{2}))?(?=[ \t]|$)/;

export function pad(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

export function toMinutes(hhmm: string): number {
	const [h, m] = hhmm.split(":").map(Number);
	return h * 60 + m;
}

export function fromMinutes(min: number): string {
	const m = Math.max(0, Math.min(24 * 60, Math.round(min)));
	return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** Splits a leading time (range) off a task body. */
export function splitTime(body: string): { time?: TaskTime; rest: string } {
	const m = TIME_PREFIX.exec(body);
	if (!m) return { rest: body };
	const sh = Number(m[1]);
	const sm = Number(m[2]);
	if (sh > 23 || sm > 59) return { rest: body };
	const time: TaskTime = { start: `${pad(sh)}:${pad(sm)}` };
	if (m[3] !== undefined) {
		const eh = Number(m[3]);
		const em = Number(m[4]);
		const valid = (eh < 24 && em < 60) || (eh === 24 && em === 0);
		if (!valid) return { rest: body };
		time.end = `${pad(eh)}:${pad(em)}`;
	}
	return { time, rest: body.slice(m[0].length).trimStart() };
}

export function formatTime(time: TaskTime): string {
	return time.end ? `${time.start} - ${time.end}` : time.start;
}

/** Parses "10:00" or "10:00-11:30" typed in quick add. */
export function parseTimeWord(word: string): TaskTime | null {
	const { time, rest } = splitTime(word);
	return time && rest === "" ? time : null;
}
