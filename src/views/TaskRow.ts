import { setIcon } from "obsidian";
import { daysFromToday, displayDate } from "../parser/dates";
import { effectiveDate, isOpen } from "../services/query";
import { basename } from "../services/TaskIndex";
import { Task } from "../types";
import { showCheckboxMenu } from "./menus";
import { colorFor, plainText, renderCheckbox, renderProjectMarker } from "./render";
import { DND_TAG, DND_TASKS, TaskManagerView } from "./TaskManagerView";

export function isComment(note: string): boolean {
	return /^[-*+]\s+💬/.test(note);
}

export function renderTaskRow(view: TaskManagerView, parent: HTMLElement, task: Task): void {
	const { index, settings, writer } = view.plugin;
	const row = parent.createDiv({ cls: "mtm-row", attr: { "data-id": task.id, draggable: "true" } });
	row.toggleClass("is-selected", view.selected.has(task.id));
	row.toggleClass("is-closed", !isOpen(task));

	// checkbox
	const box = renderCheckbox(row, task);
	box.addEventListener("click", (e) => {
		e.stopPropagation();
		void writer.toggle(view.targetsFor(task));
	});
	box.addEventListener("contextmenu", (e) => {
		e.preventDefault();
		e.stopPropagation();
		showCheckboxMenu(view, view.targetsFor(task), e);
	});

	// title + first description line
	const main = row.createDiv({ cls: "mtm-row-main" });
	const titleLine = main.createDiv({ cls: "mtm-row-title-line" });
	const children = task.childIds.map((id) => index.get(id)).filter((x): x is Task => !!x);
	if (children.length) {
		const done = children.filter((c) => c.status.type === "done").length;
		const chip = titleLine.createSpan({ cls: "mtm-subtask-count" });
		setIcon(chip.createSpan(), "list-checks");
		chip.createSpan({ text: `${done}/${children.length}` });
	}
	titleLine.createSpan({ cls: "mtm-row-title", text: plainText(task.title) || "—" });
	const firstNote = task.notes.find((n) => !isComment(n));
	if (firstNote) main.createDiv({ cls: "mtm-row-note", text: plainText(firstNote.replace(/^[-*+]\s+/, "")) });

	// metadata on the right
	const meta = row.createDiv({ cls: "mtm-row-meta" });
	const date = effectiveDate(task);
	if (date) {
		const chip = meta.createSpan({ cls: "mtm-chip mtm-date" });
		const diff = daysFromToday(date);
		chip.toggleClass("is-overdue", isOpen(task) && diff < 0);
		chip.toggleClass("is-today", diff === 0);
		setIcon(chip.createSpan(), task.dates.due ? "calendar" : task.dates.scheduled ? "hourglass" : "play");
		chip.createSpan({ text: displayDate(date, settings.dateDisplayFormat) });
	}
	if (task.time) {
		const tm = meta.createSpan({ cls: "mtm-chip mtm-time" });
		tm.toggleClass("is-overdue", isOpen(task) && !!date && daysFromToday(date) < 0);
		setIcon(tm.createSpan(), "clock");
		tm.createSpan({ text: task.time.end ? `${task.time.start}–${task.time.end}` : task.time.start });
	}
	if (task.recurrence) {
		const r = meta.createSpan({ cls: "mtm-chip mtm-muted", attr: { "aria-label": task.recurrence } });
		setIcon(r, "repeat");
	}
	const file = meta.createSpan({ cls: "mtm-chip mtm-file", attr: { "aria-label": task.path } });
	const project = index.projectOf(task.path);
	if (project) renderProjectMarker(file, settings, project);
	else setIcon(file.createSpan(), "file-text");
	file.createSpan({ text: basename(task.path) });
	file.addEventListener("click", (e) => {
		e.stopPropagation();
		void view.openTask(task);
	});
	for (const tag of task.tags) {
		const tagEl = meta.createSpan({ cls: "mtm-tag", text: `#${tag}` });
		tagEl.style.setProperty("--mtm-tag-color", colorFor(tag));
		tagEl.addEventListener("click", (e) => {
			e.stopPropagation();
			view.setNav({ kind: "tag", tag });
		});
	}

	// interaction
	row.addEventListener("click", (e) => {
		view.select(task.id, e);
		parent.focus({ preventScroll: true });
	});
	row.addEventListener("dblclick", () => void view.openTask(task));
	row.addEventListener("contextmenu", (e) => {
		e.preventDefault();
		view.showContextMenu(task, e);
	});

	// drag the task (or the selection) onto a sidebar entry
	row.addEventListener("dragstart", (e) => {
		const ids = view.targetsFor(task).map((x) => x.id);
		e.dataTransfer?.setData(DND_TASKS, JSON.stringify(ids));
		e.dataTransfer?.setData("text/plain", task.title);
		if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
	});

	// drop a tag from the sidebar onto the task
	row.addEventListener("dragover", (e) => {
		if (!e.dataTransfer?.types.includes(DND_TAG)) return;
		e.preventDefault();
		row.addClass("mtm-drop-hover");
	});
	row.addEventListener("dragleave", () => row.removeClass("mtm-drop-hover"));
	row.addEventListener("drop", (e) => {
		row.removeClass("mtm-drop-hover");
		const tag = e.dataTransfer?.getData(DND_TAG);
		if (!tag) return;
		e.preventDefault();
		void writer.addTag(view.targetsFor(task), tag);
	});
}
