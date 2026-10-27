import { Menu } from "obsidian";
import { t } from "../i18n";
import { addDays, today } from "../parser/dates";
import { priorityLabel } from "../services/query";
import { PRIORITIES_DESC, Task } from "../types";
import { ConfirmModal, DatePickerModal, FileSuggestModal, TagSuggestModal } from "./modals";
import type { TaskManagerView } from "./TaskManagerView";

interface Point {
	x: number;
	y: number;
}

/**
 * Obsidian's public API has no nested menus, so "Priority ›" etc. open a second menu
 * at the same spot — it reads as a submenu and keeps keyboard navigation working.
 */
function sub(at: Point, build: (m: Menu) => void): void {
	const m = new Menu();
	build(m);
	m.showAtPosition(at);
}

export function statusMenu(view: TaskManagerView, tasks: Task[], m: Menu): void {
	const current = tasks.length === 1 ? tasks[0].statusSymbol : null;
	for (const s of view.plugin.settings.statuses) {
		m.addItem((i) =>
			i
				.setTitle(`${s.name}  [${s.symbol}]`)
				.setIcon(s.icon || statusIconFallback(s.type))
				.setChecked(current === s.symbol)
				.onClick(() => view.plugin.writer.setStatus(tasks, s.symbol)),
		);
	}
}

export function priorityMenu(view: TaskManagerView, tasks: Task[], m: Menu): void {
	const current = tasks.length === 1 ? tasks[0].priority : null;
	for (const p of PRIORITIES_DESC) {
		m.addItem((i) =>
			i
				.setTitle(priorityLabel(p))
				.setIcon("flag")
				.setChecked(current === p)
				.onClick(() => view.plugin.writer.setPriority(tasks, p)),
		);
	}
}

export function dateMenu(view: TaskManagerView, tasks: Task[], m: Menu): void {
	const w = view.plugin.writer;
	const now = today();
	m.addItem((i) => i.setTitle(t("setDateToday")).setIcon("calendar-check").onClick(() => w.setDate(tasks, "due", now)));
	m.addItem((i) => i.setTitle(t("setDateTomorrow")).setIcon("sunrise").onClick(() => w.setDate(tasks, "due", addDays(now, 1))));
	m.addItem((i) => i.setTitle(t("setDateNextWeek")).setIcon("calendar-plus").onClick(() => w.setDate(tasks, "due", addDays(now, 7))));
	m.addItem((i) =>
		i
			.setTitle(t("setDatePick"))
			.setIcon("calendar-days")
			.onClick(() => new DatePickerModal(view.app, tasks[0]?.dates.due, (d) => w.setDate(tasks, "due", d)).open()),
	);
	if (tasks.some((x) => x.dates.due)) {
		m.addItem((i) => i.setTitle(t("clearDate")).setIcon("calendar-x").onClick(() => w.setDate(tasks, "due", null)));
	}
}

export function pickTag(view: TaskManagerView, tasks: Task[]): void {
	new TagSuggestModal(view.app, view.allTags(), (tag) => view.plugin.writer.addTag(tasks, tag)).open();
}

export function pickProject(view: TaskManagerView, tasks: Task[]): void {
	new FileSuggestModal(
		view.app,
		view.plugin.index.allProjects(),
		(path) => view.plugin.writer.move(tasks, path),
		t("moveToProject"),
	).open();
}

export function confirmDelete(view: TaskManagerView, tasks: Task[]): void {
	new ConfirmModal(view.app, t("deleteConfirm", { n: tasks.length }), async () => {
		await view.plugin.writer.delete(tasks);
		view.clearSelection();
	}).open();
}

/** Full context menu for a task row (applies to the whole selection when the row is part of it). */
export function showTaskMenu(view: TaskManagerView, tasks: Task[], evt: MouseEvent): void {
	const at = { x: evt.clientX, y: evt.clientY };
	const m = new Menu();
	const single = tasks.length === 1 ? tasks[0] : null;

	m.addItem((i) => i.setTitle(`${t("status")} ›`).setIcon("circle-dot").onClick(() => sub(at, (s) => statusMenu(view, tasks, s))));
	m.addItem((i) => i.setTitle(`${t("priority")} ›`).setIcon("flag").onClick(() => sub(at, (s) => priorityMenu(view, tasks, s))));
	m.addItem((i) => i.setTitle(`${t("date")} ›`).setIcon("calendar").onClick(() => sub(at, (s) => dateMenu(view, tasks, s))));
	m.addSeparator();
	m.addItem((i) => i.setTitle(t("addTag")).setIcon("tag").onClick(() => pickTag(view, tasks)));
	m.addItem((i) => i.setTitle(t("moveToProject")).setIcon("folder-input").onClick(() => pickProject(view, tasks)));
	m.addItem((i) =>
		i
			.setTitle(t("moveToInbox"))
			.setIcon("inbox")
			.onClick(() => view.plugin.writer.move(tasks, view.plugin.settings.inboxPath)),
	);
	if (single) {
		m.addSeparator();
		m.addItem((i) => i.setTitle(t("openInNote")).setIcon("file-text").onClick(() => view.openTask(single)));
	}
	m.addSeparator();
	m.addItem((i) => {
		i.setTitle(t("deleteTask")).setIcon("trash-2").onClick(() => confirmDelete(view, tasks));
		(i as unknown as { setWarning?: (w: boolean) => void }).setWarning?.(true);
	});
	m.showAtMouseEvent(evt);
}

/** Right-click on a checkbox: the quick status + priority menu from the video. */
export function showCheckboxMenu(view: TaskManagerView, tasks: Task[], evt: MouseEvent): void {
	const m = new Menu();
	statusMenu(view, tasks, m);
	m.addSeparator();
	priorityMenu(view, tasks, m);
	m.showAtMouseEvent(evt);
}

export function statusIconFallback(type: string): string {
	switch (type) {
		case "done":
			return "check-square";
		case "cancelled":
			return "x-square";
		case "in_progress":
			return "circle-dashed";
		default:
			return "square";
	}
}
