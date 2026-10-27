import { moment } from "obsidian";
import { t } from "../i18n";

export const ISO = "YYYY-MM-DD";

export function today(): string {
	return moment().format(ISO);
}

export function addDays(iso: string, days: number): string {
	return moment(iso, ISO).add(days, "days").format(ISO);
}

export function isValidIso(s: string): boolean {
	return /^\d{4}-\d{2}-\d{2}$/.test(s) && moment(s, ISO, true).isValid();
}

/** Whole days from today to `iso` (negative = past). */
export function daysFromToday(iso: string): number {
	return moment(iso, ISO).startOf("day").diff(moment().startOf("day"), "days");
}

/** Short label for the list: Today / Tomorrow / Yesterday, otherwise the user's format. */
export function displayDate(iso: string, format: string): string {
	const d = daysFromToday(iso);
	if (d === 0) return t("today");
	if (d === 1) return t("tomorrow");
	if (d === -1) return t("yesterday");
	const m = moment(iso, ISO);
	// Drop the year for dates in the current year unless the format asks for it explicitly.
	const fmt = m.year() === moment().year() || /Y/.test(format) ? format : `${format} YYYY`;
	return m.format(fmt);
}

const WEEKDAYS: Record<string, number> = {
	sun: 0, sunday: 0, вс: 0, воскресенье: 0,
	mon: 1, monday: 1, пн: 1, понедельник: 1,
	tue: 2, tuesday: 2, вт: 2, вторник: 2,
	wed: 3, wednesday: 3, ср: 3, среда: 3, среду: 3,
	thu: 4, thursday: 4, чт: 4, четверг: 4,
	fri: 5, friday: 5, пт: 5, пятница: 5, пятницу: 5,
	sat: 6, saturday: 6, сб: 6, суббота: 6, субботу: 6,
};

/**
 * Parses a natural-language date word used in quick add.
 * Returns an ISO date or null when the word is not a date.
 */
export function parseDateWord(word: string): string | null {
	const w = word.toLowerCase();
	if (isValidIso(w)) return w;
	if (w === "today" || w === "tod" || w === "сегодня") return today();
	if (w === "tomorrow" || w === "tom" || w === "завтра") return addDays(today(), 1);
	if (w === "послезавтра") return addDays(today(), 2);
	if (w in WEEKDAYS) {
		const target = WEEKDAYS[w];
		const cur = moment().day();
		let diff = (target - cur + 7) % 7;
		if (diff === 0) diff = 7;
		return addDays(today(), diff);
	}
	return null;
}

const UNITS: Record<string, moment.unitOfTime.DurationConstructor> = {
	day: "days", days: "days",
	week: "weeks", weeks: "weeks",
	month: "months", months: "months",
	year: "years", years: "years",
};

/**
 * Shifts a date by a simple Tasks-style recurrence rule:
 * "every day", "every 3 weeks", "every month when done", "every weekday".
 * Returns null for rules this plugin does not understand.
 */
export function nextOccurrence(rule: string, from: string): string | null {
	const r = rule.trim().toLowerCase().replace(/\s+when done$/, "");
	if (r === "every weekday") {
		let m = moment(from, ISO).add(1, "day");
		while (m.day() === 0 || m.day() === 6) m = m.add(1, "day");
		return m.format(ISO);
	}
	const match = /^every\s+(?:(\d+)\s+)?(day|days|week|weeks|month|months|year|years)$/.exec(r);
	if (!match) return null;
	const n = match[1] ? parseInt(match[1], 10) : 1;
	return moment(from, ISO).add(n, UNITS[match[2]]).format(ISO);
}
