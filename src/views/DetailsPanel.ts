import { setIcon } from "obsidian";
import { t } from "../i18n";
import { priorityLabel } from "../services/query";
import { basename } from "../services/TaskIndex";
import { DateField, Priority, PRIORITIES_DESC, Task } from "../types";
import { confirmDelete, dateMenu, pickProject, pickTag, priorityMenu, statusMenu } from "./menus";
import { colorFor, plainText, renderCheckbox } from "./render";
import { isComment } from "./TaskRow";
import type { TaskManagerView } from "./TaskManagerView";
import { Menu } from "obsidian";

export function renderDetails(view: TaskManagerView, el: HTMLElement): void {
	el.empty();
	const tasks = view.selectedTasks();
	if (tasks.length > 1) return renderBulk(view, el, tasks);
	const task = view.focusId ? view.plugin.index.get(view.focusId) : undefined;
	if (!task) {
		const empty = el.createDiv({ cls: "mtm-details-empty" });
		setIcon(empty.createDiv({ cls: "mtm-empty-icon" }), "mouse-pointer-click");
		empty.createDiv({ cls: "mtm-details-empty-title", text: t("noTaskSelected") });
		empty.createDiv({ cls: "mtm-details-empty-hint", text: t("noTaskSelectedHint") });
		return;
	}
	renderSingle(view, el, task);
}

/** Auto-growing textarea that commits on blur (and on Enter unless `multiline`). */
function editable(
	view: TaskManagerView,
	parent: HTMLElement,
	value: string,
	opts: { cls: string; placeholder?: string; multiline?: boolean },
	commit: (v: string) => void,
): HTMLTextAreaElement {
	const ta = parent.createEl("textarea", { cls: opts.cls, attr: { rows: "1", placeholder: opts.placeholder ?? "" } });
	ta.value = value;
	const grow = () => {
		ta.style.height = "auto";
		ta.style.height = `${ta.scrollHeight}px`;
	};
	window.requestAnimationFrame(grow);
	ta.addEventListener("input", grow);
	ta.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !opts.multiline && !e.shiftKey) {
			e.preventDefault();
			ta.blur();
		}
		if (e.key === "Escape") {
			ta.value = value;
			ta.blur();
		}
	});
	ta.addEventListener("blur", () => {
		if (ta.value !== value) commit(ta.value);
		view.detailsBlurred();
	});
	return ta;
}

function prop(parent: HTMLElement, icon: string, label: string): HTMLElement {
	const row = parent.createDiv({ cls: "mtm-prop" });
	const name = row.createDiv({ cls: "mtm-prop-name" });
	setIcon(name.createSpan(), icon);
	name.createSpan({ text: label });
	return row.createDiv({ cls: "mtm-prop-value" });
}

function dateInput(view: TaskManagerView, parent: HTMLElement, task: Task, field: DateField): void {
	const wrap = parent.createDiv({ cls: "mtm-date-field" });
	const input = wrap.createEl("input", { type: "date" });
	input.value = task.dates[field] ?? "";
	input.addEventListener("change", () => void view.plugin.writer.setDate([task], field, input.value || null));
	input.addEventListener("blur", () => view.detailsBlurred());
	if (task.dates[field]) {
		const clear = wrap.createDiv({ cls: "clickable-icon", attr: { "aria-label": t("clearDate") } });
		setIcon(clear, "x");
		clear.addEventListener("click", () => void view.plugin.writer.setDate([task], field, null));
	}
}

/** Start / end time; stored as the "10:00 - 11:30" prefix of the task text. */
function timeInputs(view: TaskManagerView, parent: HTMLElement, task: Task): void {
	const wrap = parent.createDiv({ cls: "mtm-date-field mtm-time-field" });
	const start = wrap.createEl("input", { type: "time" });
	wrap.createSpan({ cls: "mtm-muted", text: "–" });
	const end = wrap.createEl("input", { type: "time" });
	start.value = task.time?.start ?? "";
	end.value = task.time?.end ?? "";
	end.disabled = !start.value;
	const save = () => {
		const time = start.value ? { start: start.value, end: end.value && end.value > start.value ? end.value : undefined } : null;
		void view.plugin.writer.setTime([task], time);
	};
	start.addEventListener("change", save);
	end.addEventListener("change", save);
	start.addEventListener("blur", () => view.detailsBlurred());
	end.addEventListener("blur", () => view.detailsBlurred());
	if (task.time) {
		const clear = wrap.createDiv({ cls: "clickable-icon", attr: { "aria-label": t("clearDate") } });
		setIcon(clear, "x");
		clear.addEventListener("click", () => void view.plugin.writer.setTime([task], null));
	}
}

function renderSingle(view: TaskManagerView, el: HTMLElement, task: Task): void {
	const { writer, index, settings } = view.plugin;

	// parent breadcrumb
	const parentTask = index.parentOf(task);
	if (parentTask) {
		const crumb = el.createDiv({ cls: "mtm-details-parent" });
		setIcon(crumb.createSpan(), "corner-left-up");
		crumb.createSpan({ text: plainText(parentTask.title) });
		crumb.addEventListener("click", () => view.focusTask(parentTask.id));
	}

	// title row
	const top = el.createDiv({ cls: "mtm-details-top" });
	const box = renderCheckbox(top, task);
	box.addEventListener("click", () => void writer.toggle([task]));
	box.addEventListener("contextmenu", (e) => {
		e.preventDefault();
		const m = new Menu();
		statusMenu(view, [task], m);
		m.showAtMouseEvent(e);
	});
	editable(view, top, task.title, { cls: "mtm-details-title", placeholder: t("title") }, (v) => {
		if (v.trim()) void writer.setTitle(task, v.trim());
	});

	// properties
	const props = el.createDiv({ cls: "mtm-props" });

	const status = prop(props, "circle-dot", t("status"));
	const statusSel = status.createEl("select", { cls: "dropdown" });
	const symbols = settings.statuses.map((s) => s.symbol);
	if (!symbols.includes(task.statusSymbol)) statusSel.createEl("option", { value: task.statusSymbol, text: task.status.name });
	for (const s of settings.statuses) statusSel.createEl("option", { value: s.symbol, text: `${s.name} [${s.symbol}]` });
	statusSel.value = task.statusSymbol;
	statusSel.addEventListener("change", () => void writer.setStatus([task], statusSel.value));

	const prio = prop(props, "flag", t("priority"));
	const prioSel = prio.createEl("select", { cls: `dropdown mtm-prio-select mtm-prio-${Priority[task.priority].toLowerCase()}` });
	for (const p of PRIORITIES_DESC) prioSel.createEl("option", { value: String(p), text: priorityLabel(p) });
	prioSel.value = String(task.priority);
	prioSel.addEventListener("change", () => void writer.setPriority([task], Number(prioSel.value) as Priority));

	dateInput(view, prop(props, "calendar", t("due")), task, "due");
	timeInputs(view, prop(props, "clock", t("time")), task);
	dateInput(view, prop(props, "hourglass", t("scheduled")), task, "scheduled");
	dateInput(view, prop(props, "play", t("start")), task, "start");

	const repeat = prop(props, "repeat", t("repeat"));
	const repeatInput = repeat.createEl("input", { type: "text", attr: { placeholder: "every week" } });
	repeatInput.value = task.recurrence ?? "";
	repeatInput.addEventListener("change", () => void writer.setRecurrence([task], repeatInput.value.trim() || null));
	repeatInput.addEventListener("blur", () => view.detailsBlurred());

	const tags = prop(props, "tag", t("tags"));
	tags.addClass("mtm-tags-value");
	for (const tag of task.tags) {
		const chip = tags.createSpan({ cls: "mtm-tag-chip" });
		chip.style.setProperty("--mtm-tag-color", colorFor(tag));
		chip.createSpan({ text: `#${tag}` });
		const x = chip.createSpan({ cls: "mtm-tag-remove" });
		setIcon(x, "x");
		x.addEventListener("click", () => void writer.removeTag([task], tag));
	}
	const addTag = tags.createSpan({ cls: "mtm-tag-add clickable-icon", attr: { "aria-label": t("addTag") } });
	setIcon(addTag, "plus");
	addTag.addEventListener("click", () => pickTag(view, [task]));

	for (const field of ["created", "done", "cancelled"] as DateField[]) {
		const d = task.dates[field];
		if (d) prop(props, field === "created" ? "plus-circle" : field === "done" ? "check-circle" : "x-circle", t(field)).setText(d);
	}

	const loc = prop(props, index.isProject(task.path) ? "folder" : "file-text", t("file"));
	const link = loc.createSpan({ cls: "mtm-link", text: basename(task.path) });
	link.setAttr("aria-label", task.path);
	link.addEventListener("click", () => void view.openTask(task));
	if (task.headers.length) loc.createSpan({ cls: "mtm-muted", text: ` › ${task.headers.join(" › ")}` });

	// description (comments are kept separately but live in the same indented block)
	const description = task.notes.filter((n) => !isComment(n));
	const comments = task.notes.filter(isComment);
	el.createDiv({ cls: "mtm-section-title", text: t("description") });
	editable(
		view,
		el,
		description.join("\n"),
		{ cls: "mtm-details-desc", placeholder: t("descriptionPlaceholder"), multiline: true },
		(v) => void writer.setDescription(task, [v.trimEnd(), ...comments].filter(Boolean).join("\n")),
	);

	// subtasks
	const children = task.childIds.map((id) => index.get(id)).filter((x): x is Task => !!x);
	const subHead = el.createDiv({ cls: "mtm-section-title" });
	subHead.setText(t("subtasks"));
	if (children.length) {
		const done = children.filter((c) => c.status.type === "done").length;
		subHead.createSpan({ cls: "mtm-muted", text: `  ${done}/${children.length}` });
	}
	const subList = el.createDiv({ cls: "mtm-subtasks" });
	for (const child of children) {
		const row = subList.createDiv({ cls: "mtm-subtask" });
		const cb = renderCheckbox(row, child);
		cb.addEventListener("click", (e) => {
			e.stopPropagation();
			void writer.toggle([child]);
		});
		row.createSpan({ cls: "mtm-subtask-title", text: plainText(child.title) });
		if (child.childIds.length) row.createSpan({ cls: "mtm-muted", text: ` ${child.childIds.length}` });
		row.addEventListener("click", () => view.focusTask(child.id));
	}
	const addSub = subList.createEl("input", { type: "text", cls: "mtm-inline-input", attr: { placeholder: t("addSubtask") } });
	addSub.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.isComposing && addSub.value.trim()) {
			e.preventDefault();
			const v = addSub.value.trim();
			addSub.value = "";
			void writer.addSubtask(task, v);
		}
	});
	addSub.addEventListener("blur", () => view.detailsBlurred());

	// comments
	el.createDiv({ cls: "mtm-section-title", text: t("comment") });
	const list = el.createDiv({ cls: "mtm-comments" });
	for (const c of comments) {
		const m = /^[-*+]\s+💬\s*(\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?)?\s*(?:—|-)?\s*(.*)$/.exec(c);
		const row = list.createDiv({ cls: "mtm-comment" });
		if (m?.[1]) row.createDiv({ cls: "mtm-comment-time", text: m[1] });
		row.createDiv({ cls: "mtm-comment-text", text: plainText(m?.[2] ?? c) });
	}
	const addComment = list.createEl("input", { type: "text", cls: "mtm-inline-input", attr: { placeholder: t("addComment") } });
	addComment.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.isComposing && addComment.value.trim()) {
			e.preventDefault();
			const v = addComment.value.trim();
			addComment.value = "";
			void writer.addComment(task, v);
		}
	});
	addComment.addEventListener("blur", () => view.detailsBlurred());

	// footer
	const footer = el.createDiv({ cls: "mtm-details-footer" });
	const open = footer.createEl("button", { text: t("openInNote") });
	open.addEventListener("click", () => void view.openTask(task));
	const move = footer.createEl("button", { text: t("moveToProject") });
	move.addEventListener("click", () => pickProject(view, [task]));
	const del = footer.createEl("button", { cls: "mod-warning", text: t("deleteTask") });
	del.addEventListener("click", () => confirmDelete(view, [task]));
}

/** Multi-selection: bulk actions, mirroring the context menu. */
function renderBulk(view: TaskManagerView, el: HTMLElement, tasks: Task[]): void {
	const { writer } = view.plugin;
	el.createDiv({ cls: "mtm-details-bulk-title", text: t("nSelected", { n: tasks.length }) });
	const actions = el.createDiv({ cls: "mtm-bulk-actions" });
	const btn = (icon: string, label: string, onClick: (e: MouseEvent) => void) => {
		const b = actions.createEl("button", { cls: "mtm-bulk-btn" });
		setIcon(b.createSpan(), icon);
		b.createSpan({ text: label });
		b.addEventListener("click", onClick);
	};
	const menuAt = (e: MouseEvent, build: (m: Menu) => void) => {
		const m = new Menu();
		build(m);
		m.showAtMouseEvent(e);
	};
	btn("check", t("done"), () => void writer.toggle(tasks));
	btn("circle-dot", t("status"), (e) => menuAt(e, (m) => statusMenu(view, tasks, m)));
	btn("flag", t("priority"), (e) => menuAt(e, (m) => priorityMenu(view, tasks, m)));
	btn("calendar", t("date"), (e) => menuAt(e, (m) => dateMenu(view, tasks, m)));
	btn("tag", t("addTag"), () => pickTag(view, tasks));
	btn("folder-input", t("moveToProject"), () => pickProject(view, tasks));
	btn("inbox", t("moveToInbox"), () => void writer.move(tasks, view.plugin.settings.inboxPath));
	btn("trash-2", t("deleteTask"), () => confirmDelete(view, tasks));

	const list = el.createDiv({ cls: "mtm-bulk-list" });
	for (const task of tasks) list.createDiv({ cls: "mtm-bulk-item", text: plainText(task.title) });
}
