import { debounce, ItemView, MarkdownView, Menu, setIcon, TFile, ViewStateResult, WorkspaceLeaf } from "obsidian";
import { t } from "../i18n";
import { today } from "../parser/dates";
import { parseQuickAdd } from "../parser/quickAdd";
import { buildParserConfig } from "../parser/TaskParser";
import {
	applyFilter,
	groupTasks,
	hideNestedSubtasks,
	sortTasks,
	tasksForNav,
} from "../services/query";
import { basename } from "../services/TaskIndex";
import type TaskManagerPlugin from "../main";
import { GroupBy, NavPrefs, NavTarget, navKey, SortBy, Task, ViewMode } from "../types";
import { CalendarPane } from "./CalendarPane";
import { renderDetails } from "./DetailsPanel";
import { confirmDelete, showTaskMenu } from "./menus";
import { renderSidebar } from "./Sidebar";
import { renderTaskRow } from "./TaskRow";

export const VIEW_TYPE_TASK_MANAGER = "md-task-manager-view";
export const DND_TASKS = "application/x-mtm-tasks";
export const DND_TAG = "application/x-mtm-tag";

const GROUP_OPTIONS: GroupBy[] = ["none", "date", "priority", "status", "project", "tag", "file"];
const SORT_OPTIONS: SortBy[] = ["smart", "due", "priority", "title", "file"];
/** Below this width the side panes no longer fit next to the list and become overlays. */
const COMPACT_WIDTH = 700;

/**
 * Three-pane task manager:
 *   left   – navigation (Inbox / Today / Upcoming / pinned tags / projects / tag tree)
 *   center – the task list for the current navigation entry, with grouping, sorting, filter and quick add
 *   right  – details of the selected task (or bulk actions for a multi-selection)
 */
export class TaskManagerView extends ItemView {
	nav: NavTarget = { kind: "today" };
	filter = "";
	selected = new Set<string>();
	focusId: string | null = null;
	private anchorId: string | null = null;
	/** Visible task ids in render order, for keyboard navigation and shift-click ranges. */
	private order: string[] = [];
	collapsed = new Set<string>();
	private compact = false;
	private overlay: "sidebar" | "details" | null = null;

	private rootEl!: HTMLElement;
	private sidebarEl!: HTMLElement;
	private titleEl!: HTMLElement;
	private countEl!: HTMLElement;
	private listEl!: HTMLElement;
	private detailsEl!: HTMLElement;
	calendar!: CalendarPane;
	private filterInput!: HTMLInputElement;

	constructor(
		leaf: WorkspaceLeaf,
		readonly plugin: TaskManagerPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_TASK_MANAGER;
	}

	getDisplayText(): string {
		return t("pluginName");
	}

	getIcon(): string {
		return "list-checks";
	}

	// ---- persistence of the current navigation entry ------------------------

	getState(): Record<string, unknown> {
		return { ...super.getState(), nav: this.nav };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const nav = (state as { nav?: NavTarget } | null)?.nav;
		if (nav && typeof nav === "object" && "kind" in nav) this.nav = nav;
		await super.setState(state, result);
		if (this.rootEl) this.renderAll();
	}

	// ---- lifecycle ----------------------------------------------------------

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("mtm-view");
		this.rootEl = container.createDiv({ cls: "mtm-root" });
		this.buildLayout();
		this.registerEvent(this.plugin.index.on("changed", () => this.refresh()));
		this.renderAll();
		window.requestAnimationFrame(() => this.updateCompact());
	}

	async onClose(): Promise<void> {
		this.refresh.cancel();
	}

	refresh = debounce(() => this.renderAll(), 30, false);

	// ---- layout -------------------------------------------------------------

	private buildLayout(): void {
		this.buildRibbon();
		this.sidebarEl = this.rootEl.createDiv({ cls: "mtm-sidebar" });
		const main = this.rootEl.createDiv({ cls: "mtm-main" });
		const calendarEl = this.rootEl.createDiv({ cls: "mtm-calendar" });
		this.calendar = new CalendarPane(this, calendarEl);
		this.detailsEl = this.rootEl.createDiv({ cls: "mtm-details" });
		this.applyLayoutClasses();
		// In compact mode, clicking the list/calendar closes an open overlay (the toggle buttons handle themselves).
		for (const el of [main, calendarEl]) {
			el.addEventListener("mousedown", (e) => {
				if (!this.overlay || (e.target as HTMLElement).closest(".mtm-icon-btn")) return;
				this.overlay = null;
				this.applyLayoutClasses();
			});
		}

		// header
		const header = main.createDiv({ cls: "mtm-header" });
		this.iconButton(header, "panel-left", t("toggleSidebar"), () => this.togglePane("sidebar"));
		this.titleEl = header.createDiv({ cls: "mtm-header-title" });
		this.countEl = header.createDiv({ cls: "mtm-header-count" });
		header.createDiv({ cls: "mtm-spacer" });
		this.iconButton(header, "arrow-up-down", `${t("groupBy")} / ${t("sortBy")}`, (evt) => this.showViewMenu(evt));
		this.filterInput = header.createEl("input", {
			type: "search",
			cls: "mtm-filter",
			attr: { placeholder: t("filterPlaceholder") },
		});
		this.filterInput.addEventListener("input", () => {
			this.filter = this.filterInput.value;
			this.renderList();
		});
		this.iconButton(header, "panel-right", t("toggleDetails"), () => this.togglePane("details"));

		// list
		this.listEl = main.createDiv({ cls: "mtm-list", attr: { tabindex: "0" } });
		this.listEl.addEventListener("keydown", (e) => this.onListKey(e));

		// quick add
		const add = main.createDiv({ cls: "mtm-quickadd" });
		const plus = add.createSpan({ cls: "mtm-quickadd-icon" });
		setIcon(plus, "plus");
		const input = add.createEl("input", {
			type: "text",
			cls: "mtm-quickadd-input",
			attr: { placeholder: t("addTask") },
		});
		input.addEventListener("focus", () => input.setAttr("placeholder", t("addTaskPlaceholder")));
		input.addEventListener("blur", () => input.setAttr("placeholder", t("addTask")));
		input.addEventListener("keydown", async (e) => {
			if (e.key === "Enter" && !e.isComposing && input.value.trim()) {
				e.preventDefault();
				const text = input.value;
				input.value = "";
				await this.quickAdd(text);
			} else if (e.key === "Escape") {
				input.value = "";
				input.blur();
			}
		});
	}

	/** Narrow strip on the far left that switches between the task list and the calendar. */
	private buildRibbon(): void {
		const ribbon = this.rootEl.createDiv({ cls: "mtm-ribbon" });
		const modes: [ViewMode, string, string][] = [
			["list", "list-checks", t("tasksMode")],
			["calendar", "calendar-days", t("calendar")],
		];
		for (const [mode, icon, label] of modes) {
			const b = ribbon.createDiv({ cls: "clickable-icon mtm-ribbon-btn", attr: { "aria-label": label, "data-mode": mode } });
			setIcon(b, icon);
			b.addEventListener("click", () => void this.setMode(mode));
		}
		ribbon.createDiv({ cls: "mtm-spacer" });
		const gear = ribbon.createDiv({ cls: "clickable-icon mtm-ribbon-btn", attr: { "aria-label": t("settings") } });
		setIcon(gear, "settings");
		gear.addEventListener("click", () => this.plugin.openSettings());
	}

	async setMode(mode: ViewMode): Promise<void> {
		if (this.plugin.settings.viewMode === mode) return;
		this.plugin.settings.viewMode = mode;
		this.overlay = null;
		this.applyLayoutClasses();
		await this.plugin.saveSettings();
	}

	private iconButton(parent: HTMLElement, icon: string, label: string, onClick: (evt: MouseEvent) => void): HTMLElement {
		const b = parent.createDiv({ cls: "clickable-icon mtm-icon-btn", attr: { "aria-label": label } });
		setIcon(b, icon);
		b.addEventListener("click", onClick);
		return b;
	}

	/**
	 * Wide view: the buttons show/hide the side panes (remembered in settings).
	 * Compact view: the panes are overlays, and the buttons open/close them without touching settings.
	 */
	async togglePane(which: "sidebar" | "details"): Promise<void> {
		if (this.compact) {
			this.overlay = this.overlay === which ? null : which;
			this.applyLayoutClasses();
			return;
		}
		const s = this.plugin.settings;
		if (which === "sidebar") s.showSidebar = !s.showSidebar;
		else s.showDetails = !s.showDetails;
		this.applyLayoutClasses();
		await this.plugin.saveSettings();
	}

	private applyLayoutClasses(): void {
		const s = this.plugin.settings;
		this.rootEl.toggleClass("mtm-hide-sidebar", !s.showSidebar);
		this.rootEl.toggleClass("mtm-hide-details", !s.showDetails);
		this.rootEl.toggleClass("mtm-compact", this.compact);
		this.rootEl.toggleClass("mtm-overlay-sidebar", this.compact && this.overlay === "sidebar");
		this.rootEl.toggleClass("mtm-overlay-details", this.compact && this.overlay === "details");
		this.rootEl.toggleClass("mtm-mode-calendar", s.viewMode === "calendar");
		this.rootEl.querySelectorAll<HTMLElement>(".mtm-ribbon-btn[data-mode]").forEach((b) => {
			b.toggleClass("is-active", b.dataset.mode === s.viewMode);
		});
	}

	/** Called by Obsidian whenever the leaf changes size (including when its own sidebars open or close). */
	onResize(): void {
		this.updateCompact();
	}

	private updateCompact(): void {
		const width = this.rootEl?.clientWidth ?? 0;
		// A background tab reports 0; keep the previous mode until it is visible again.
		if (width === 0) return;
		const compact = width < COMPACT_WIDTH;
		if (compact === this.compact) return;
		this.compact = compact;
		this.overlay = null;
		this.applyLayoutClasses();
	}

	// ---- navigation & preferences ------------------------------------------

	prefs(): NavPrefs {
		const saved = this.plugin.settings.navPrefs[navKey(this.nav)];
		if (saved) return saved;
		switch (this.nav.kind) {
			case "inbox":
				return { groupBy: "none", sortBy: "file", showCompleted: false };
			case "project":
				return { groupBy: "none", sortBy: "file", showCompleted: false };
			case "upcoming":
				return { groupBy: "date", sortBy: "due", showCompleted: false };
			default:
				return { groupBy: "date", sortBy: "smart", showCompleted: false };
		}
	}

	private async setPrefs(p: Partial<NavPrefs>): Promise<void> {
		this.plugin.settings.navPrefs[navKey(this.nav)] = { ...this.prefs(), ...p };
		await this.plugin.saveSettings();
		this.renderList();
	}

	setNav(nav: NavTarget): void {
		this.nav = nav;
		if (this.overlay === "sidebar") {
			this.overlay = null;
			this.applyLayoutClasses();
		}
		this.clearSelection(false);
		this.filter = "";
		this.filterInput.value = "";
		this.renderAll();
		this.app.workspace.requestSaveLayout();
	}

	navLabel(nav: NavTarget = this.nav): string {
		switch (nav.kind) {
			case "tag":
				return `#${nav.tag}`;
			case "project":
				return basename(nav.path);
			default:
				return t(nav.kind);
		}
	}

	private showViewMenu(evt: MouseEvent): void {
		const p = this.prefs();
		const m = new Menu();
		m.addItem((i) => i.setTitle(t("groupBy")).setIsLabel(true));
		for (const g of GROUP_OPTIONS) {
			m.addItem((i) =>
				i
					.setTitle(t(`group_${g}`))
					.setChecked(p.groupBy === g)
					.onClick(() => this.setPrefs({ groupBy: g })),
			);
		}
		m.addSeparator();
		m.addItem((i) => i.setTitle(t("sortBy")).setIsLabel(true));
		for (const s of SORT_OPTIONS) {
			m.addItem((i) =>
				i
					.setTitle(t(`sort_${s}`))
					.setChecked(p.sortBy === s)
					.onClick(() => this.setPrefs({ sortBy: s })),
			);
		}
		m.addSeparator();
		m.addItem((i) =>
			i
				.setTitle(t("showCompleted"))
				.setIcon("check-check")
				.setChecked(p.showCompleted)
				.onClick(() => this.setPrefs({ showCompleted: !p.showCompleted })),
		);
		m.showAtMouseEvent(evt);
	}

	// ---- rendering ----------------------------------------------------------

	renderAll(): void {
		if (this.plugin.settings.viewMode === "calendar") {
			this.calendar.render();
			this.renderDetails();
			return;
		}
		renderSidebar(this, this.sidebarEl);
		this.renderList();
	}

	renderList(): void {
		const { index, settings } = this.plugin;
		const prefs = this.prefs();
		this.titleEl.setText(this.navLabel());

		const scroll = this.listEl.scrollTop;
		this.listEl.empty();
		this.order = [];

		if (!index.ready) {
			this.countEl.setText("");
			this.listEl.createDiv({ cls: "mtm-empty", text: t("indexing") });
			this.renderDetails();
			return;
		}

		let tasks = tasksForNav(this.nav, index, settings, prefs.showCompleted);
		tasks = applyFilter(tasks, this.filter);
		tasks = hideNestedSubtasks(tasks);
		tasks = sortTasks(tasks, prefs.sortBy);
		this.countEl.setText(String(tasks.length));

		// Drop selections that are no longer visible.
		const visible = new Set(tasks.map((x) => x.id));
		for (const id of [...this.selected]) if (!visible.has(id) && !index.get(id)) this.selected.delete(id);
		if (this.focusId && !index.get(this.focusId)) this.focusId = null;

		if (!tasks.length) {
			const empty = this.listEl.createDiv({ cls: "mtm-empty" });
			setIcon(empty.createDiv({ cls: "mtm-empty-icon" }), "party-popper");
			empty.createDiv({ text: t("noTasks") });
		}

		for (const group of groupTasks(tasks, prefs.groupBy, settings, index, this.nav)) {
			const key = `group:${navKey(this.nav)}:${group.key}`;
			const collapsed = this.collapsed.has(key);
			if (group.label) {
				const h = this.listEl.createDiv({ cls: "mtm-group-header" });
				h.toggleClass("mtm-danger", !!group.danger);
				h.toggleClass("is-collapsed", collapsed);
				const chev = h.createSpan({ cls: "mtm-chevron" });
				setIcon(chev, "chevron-down");
				h.createSpan({ text: group.label });
				h.createSpan({ cls: "mtm-group-count", text: String(group.tasks.length) });
				h.addEventListener("click", () => {
					if (collapsed) this.collapsed.delete(key);
					else this.collapsed.add(key);
					this.renderList();
				});
			}
			if (collapsed) continue;
			for (const task of group.tasks) {
				this.order.push(task.id);
				renderTaskRow(this, this.listEl, task);
			}
		}
		this.listEl.scrollTop = scroll;
		this.renderDetails();
	}

	renderDetails(): void {
		// Don't rebuild the panel while the user is typing in it; it re-renders on blur.
		if (this.detailsEl.contains(document.activeElement) && document.activeElement !== this.detailsEl) return;
		renderDetails(this, this.detailsEl);
	}

	/** Called by the details panel when an input loses focus, so pending index changes show up. */
	detailsBlurred(): void {
		window.setTimeout(() => this.renderDetails(), 0);
	}

	// ---- selection ----------------------------------------------------------

	selectedTasks(): Task[] {
		return [...this.selected].map((id) => this.plugin.index.get(id)).filter((x): x is Task => !!x);
	}

	/** Tasks an action applies to: the whole selection if `task` is part of it, otherwise just `task`. */
	targetsFor(task: Task): Task[] {
		return this.selected.has(task.id) && this.selected.size > 1 ? this.selectedTasks() : [task];
	}

	select(id: string, evt?: MouseEvent | KeyboardEvent): void {
		if (evt && (evt.ctrlKey || evt.metaKey)) {
			if (this.selected.has(id)) this.selected.delete(id);
			else this.selected.add(id);
			this.anchorId = id;
		} else if (evt?.shiftKey && this.anchorId && this.order.includes(this.anchorId)) {
			const a = this.order.indexOf(this.anchorId);
			const b = this.order.indexOf(id);
			this.selected = new Set(this.order.slice(Math.min(a, b), Math.max(a, b) + 1));
		} else {
			this.selected = new Set([id]);
			this.anchorId = id;
		}
		this.focusId = this.selected.size === 1 ? [...this.selected][0] : this.selected.size ? id : null;
		this.updateSelectionClasses();
		this.renderDetails();
	}

	/** Focus a task that may not be in the list (e.g. a subtask clicked in the details panel). */
	focusTask(id: string): void {
		this.selected = new Set([id]);
		this.anchorId = id;
		this.focusId = id;
		this.updateSelectionClasses();
		this.renderDetails();
	}

	clearSelection(render = true): void {
		this.selected.clear();
		this.focusId = null;
		this.anchorId = null;
		if (render) {
			this.updateSelectionClasses();
			this.renderDetails();
		}
	}

	private updateSelectionClasses(): void {
		this.rootEl.querySelectorAll<HTMLElement>(".mtm-row, .mtm-cal-chip").forEach((row) => {
			row.toggleClass("is-selected", this.selected.has(row.dataset.id ?? ""));
		});
	}

	private onListKey(e: KeyboardEvent): void {
		if (e.target !== this.listEl) return;
		const cur = this.focusId ? this.order.indexOf(this.focusId) : -1;
		const move = (delta: number) => {
			const next = this.order[Math.max(0, Math.min(this.order.length - 1, cur + delta))];
			if (!next) return;
			this.select(next, e.shiftKey ? e : undefined);
			this.listEl.querySelector(`.mtm-row[data-id="${CSS.escape(next)}"]`)?.scrollIntoView({ block: "nearest" });
		};
		const tasks = this.selectedTasks();
		switch (e.key) {
			case "ArrowDown":
			case "j":
				move(1);
				break;
			case "ArrowUp":
			case "k":
				move(-1);
				break;
			case " ":
			case "x":
				if (tasks.length) void this.plugin.writer.toggle(tasks);
				break;
			case "Delete":
				if (tasks.length) confirmDelete(this, tasks);
				break;
			case "Enter":
				if (tasks.length === 1) void this.openTask(tasks[0]);
				break;
			case "Escape":
				this.clearSelection();
				break;
			case "a":
				if (e.ctrlKey || e.metaKey) {
					this.selected = new Set(this.order);
					this.focusId = this.order[0] ?? null;
					this.updateSelectionClasses();
					this.renderDetails();
					break;
				}
				return;
			default:
				return;
		}
		e.preventDefault();
	}

	showContextMenu(task: Task, evt: MouseEvent): void {
		if (!this.selected.has(task.id)) this.select(task.id);
		showTaskMenu(this, this.targetsFor(task), evt);
	}

	// ---- actions ------------------------------------------------------------

	async quickAdd(text: string): Promise<void> {
		const { settings, writer } = this.plugin;
		const spec = parseQuickAdd(text, buildParserConfig(settings));
		if (!spec.title) return;
		let path = settings.inboxPath;
		switch (this.nav.kind) {
			case "project":
				path = this.nav.path;
				break;
			case "tag":
				if (!spec.tags?.some((x) => x.toLowerCase() === (this.nav as { tag: string }).tag.toLowerCase())) {
					spec.tags = [...(spec.tags ?? []), this.nav.tag];
				}
				break;
			case "today":
				spec.due ??= today();
				break;
		}
		await writer.createTask(path, spec);
	}

	allTags(): string[] {
		const seen = new Map<string, string>();
		for (const task of this.plugin.index.all()) for (const tag of task.tags) if (!seen.has(tag.toLowerCase())) seen.set(tag.toLowerCase(), tag);
		return [...seen.values()].sort((a, b) => a.localeCompare(b));
	}

	async openTask(task: Task): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(task.path);
		if (!(file instanceof TFile)) return;
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.openFile(file, { eState: { line: task.line } });
		const view = leaf.view;
		if (view instanceof MarkdownView) {
			const pos = { line: task.line, ch: task.originalLine.length };
			view.editor.setCursor(pos);
			view.editor.scrollIntoView({ from: pos, to: pos }, true);
		}
	}

	/** Drag-and-drop target behaviour shared by sidebar entries. */
	makeDropTarget(el: HTMLElement, onDrop: (tasks: Task[]) => void): void {
		el.addEventListener("dragover", (e) => {
			if (!e.dataTransfer?.types.includes(DND_TASKS)) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = "move";
			el.addClass("mtm-drop-hover");
		});
		el.addEventListener("dragleave", () => el.removeClass("mtm-drop-hover"));
		el.addEventListener("drop", (e) => {
			el.removeClass("mtm-drop-hover");
			const raw = e.dataTransfer?.getData(DND_TASKS);
			if (!raw) return;
			e.preventDefault();
			const ids = JSON.parse(raw) as string[];
			const tasks = ids.map((id) => this.plugin.index.get(id)).filter((x): x is Task => !!x);
			if (tasks.length) onDrop(tasks);
		});
	}
}
