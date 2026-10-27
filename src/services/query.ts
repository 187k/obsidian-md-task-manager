import { moment } from "obsidian";
import { t } from "../i18n";
import { daysFromToday, ISO, today } from "../parser/dates";
import { GroupBy, NavTarget, Priority, PRIORITIES_DESC, SortBy, Task, TaskManagerSettings } from "../types";
import { basename, TaskIndex } from "./TaskIndex";

export interface TaskGroup {
	key: string;
	label: string;
	tasks: Task[];
	/** Rendered in the danger color (used for "Overdue"). */
	danger?: boolean;
}

export function isOpen(task: Task): boolean {
	return task.status.type === "todo" || task.status.type === "in_progress";
}

/** The date a task is "for": due date first, then scheduled, then start. */
export function effectiveDate(task: Task): string | undefined {
	return task.dates.due ?? task.dates.scheduled ?? task.dates.start;
}

function tagMatches(task: Task, tag: string): boolean {
	const want = tag.toLowerCase();
	return task.tags.some((x) => {
		const have = x.toLowerCase();
		return have === want || have.startsWith(want + "/");
	});
}

export function isInbox(task: Task, settings: TaskManagerSettings, index: TaskIndex): boolean {
	if (task.tags.length) return false;
	if (task.path === settings.inboxPath) return true;
	return settings.untaggedIsInbox && !effectiveDate(task) && !index.isProject(task.path);
}

/** Tasks belonging to a sidebar entry, before text filtering. */
export function tasksForNav(nav: NavTarget, index: TaskIndex, settings: TaskManagerSettings, showCompleted: boolean): Task[] {
	const now = today();
	const visible = (task: Task) => isOpen(task) || showCompleted;
	return index.all().filter((task) => {
		switch (nav.kind) {
			case "inbox":
				return visible(task) && isInbox(task, settings, index);
			case "today": {
				const d = effectiveDate(task);
				if (isOpen(task)) return !!d && d <= now;
				return showCompleted && (task.dates.done === now || task.dates.cancelled === now);
			}
			case "upcoming": {
				const d = effectiveDate(task);
				return isOpen(task) && !!d && d > now;
			}
			case "all":
				return visible(task);
			case "tag":
				return visible(task) && tagMatches(task, nav.tag);
			case "project":
				return visible(task) && task.path === nav.path;
		}
	});
}

/** Counts shown next to sidebar entries (open tasks only). */
export function countOpen(nav: NavTarget, index: TaskIndex, settings: TaskManagerSettings): number {
	return tasksForNav(nav, index, settings, false).length;
}

/**
 * Free-text filter. Words starting with # must match a tag; other words must appear
 * in the title, the file path or a heading above the task.
 */
export function applyFilter(tasks: Task[], query: string): Task[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return tasks;
	return tasks.filter((task) => {
		const hay = `${task.title} ${task.path} ${task.headers.join(" ")} ${task.notes.join(" ")}`.toLowerCase();
		return words.every((w) => (w.startsWith("#") && w.length > 1 ? tagMatches(task, w.slice(1)) : hay.includes(w)));
	});
}

/** When a parent and its subtask are both in the list, show only the parent (the subtask is visible in its details). */
export function hideNestedSubtasks(tasks: Task[]): Task[] {
	const ids = new Set(tasks.map((x) => x.id));
	return tasks.filter((x) => !x.parentId || !ids.has(x.parentId));
}

function cmpDate(a?: string, b?: string): number {
	if (a === b) return 0;
	if (!a) return 1;
	if (!b) return -1;
	return a < b ? -1 : 1;
}

/** Same day: timed tasks first, in time order. */
function cmpTime(a: Task, b: Task): number {
	return cmpDate(a.time?.start, b.time?.start);
}

function cmpPosition(a: Task, b: Task): number {
	return a.path === b.path ? a.line - b.line : a.path.localeCompare(b.path);
}

export function sortTasks(tasks: Task[], sortBy: SortBy): Task[] {
	const openRank = (x: Task) => (isOpen(x) ? 0 : 1);
	const cmp: Record<SortBy, (a: Task, b: Task) => number> = {
		smart: (a, b) =>
			openRank(a) - openRank(b) ||
			cmpDate(effectiveDate(a), effectiveDate(b)) ||
			cmpTime(a, b) ||
			b.priority - a.priority ||
			cmpPosition(a, b),
		due: (a, b) => cmpDate(effectiveDate(a), effectiveDate(b)) || cmpTime(a, b) || b.priority - a.priority || cmpPosition(a, b),
		priority: (a, b) => b.priority - a.priority || cmpDate(effectiveDate(a), effectiveDate(b)) || cmpPosition(a, b),
		title: (a, b) => a.title.localeCompare(b.title) || cmpPosition(a, b),
		file: cmpPosition,
	};
	return [...tasks].sort(cmp[sortBy]);
}

export function priorityLabel(p: Priority): string {
	return t(`prio_${p}` as "prio_0");
}

export function groupTasks(
	tasks: Task[],
	groupBy: GroupBy,
	settings: TaskManagerSettings,
	index: TaskIndex,
	nav: NavTarget,
): TaskGroup[] {
	if (groupBy === "none") return [{ key: "all", label: "", tasks }];

	const groups = new Map<string, TaskGroup>();
	const order: string[] = [];
	const add = (key: string, label: string, task: Task, danger = false) => {
		let g = groups.get(key);
		if (!g) {
			g = { key, label, tasks: [], danger };
			groups.set(key, g);
			order.push(key);
		}
		g.tasks.push(task);
	};

	switch (groupBy) {
		case "date": {
			const buckets = ["overdue", "today", "tomorrow", "next7", "later", "noDate", "completed"] as const;
			const perDay = nav.kind === "upcoming";
			for (const task of tasks) {
				if (!isOpen(task)) {
					add("completed", t("completed"), task);
					continue;
				}
				const d = effectiveDate(task);
				if (!d) {
					add("noDate", t("noDate"), task);
					continue;
				}
				const diff = daysFromToday(d);
				if (diff < 0) add("overdue", t("overdue"), task, true);
				else if (diff === 0) add("today", t("today"), task);
				else if (perDay) add(`day:${d}`, dayLabel(d), task);
				else if (diff === 1) add("tomorrow", t("tomorrow"), task);
				else if (diff <= 7) add("next7", t("next7"), task);
				else add("later", t("later"), task);
			}
			order.sort((a, b) => {
				const ra = a.startsWith("day:") ? 2.5 : buckets.indexOf(a as (typeof buckets)[number]);
				const rb = b.startsWith("day:") ? 2.5 : buckets.indexOf(b as (typeof buckets)[number]);
				return ra - rb || a.localeCompare(b);
			});
			break;
		}
		case "priority":
			for (const task of tasks) add(String(task.priority), priorityLabel(task.priority), task);
			order.sort((a, b) => PRIORITIES_DESC.indexOf(Number(a)) - PRIORITIES_DESC.indexOf(Number(b)));
			break;
		case "status": {
			const symbols = settings.statuses.map((s) => s.symbol);
			for (const task of tasks) add(task.statusSymbol, task.status.name, task);
			order.sort((a, b) => rank(symbols, a) - rank(symbols, b));
			break;
		}
		case "file":
			for (const task of tasks) add(task.path, basename(task.path), task);
			order.sort((a, b) => basename(a).localeCompare(basename(b)));
			break;
		case "project":
			for (const task of tasks) {
				if (index.isProject(task.path)) add(task.path, basename(task.path), task);
				else add("~none", t("noProject"), task);
			}
			order.sort((a, b) => (a === "~none" ? 1 : b === "~none" ? -1 : basename(a).localeCompare(basename(b))));
			break;
		case "tag":
			for (const task of tasks) {
				const tag = task.tags[0];
				if (tag) add(tag.toLowerCase(), `#${tag}`, task);
				else add("~none", t("noTag"), task);
			}
			order.sort((a, b) => (a === "~none" ? 1 : b === "~none" ? -1 : a.localeCompare(b)));
			break;
	}
	return order.map((k) => groups.get(k)!);
}

function rank(list: string[], v: string): number {
	const i = list.indexOf(v);
	return i < 0 ? list.length : i;
}

function dayLabel(iso: string): string {
	const d = daysFromToday(iso);
	if (d === 1) return `${t("tomorrow")} · ${moment(iso, ISO).format("ddd D MMM")}`;
	return moment(iso, ISO).format("dddd, D MMMM");
}
