import { debounce, MarkdownPostProcessorContext, MarkdownRenderChild, setIcon } from "obsidian";
import { t } from "../i18n";
import { daysFromToday, displayDate, today } from "../parser/dates";
import { parseQuickAdd } from "../parser/quickAdd";
import { buildParserConfig } from "../parser/TaskParser";
import { applyFilter, effectiveDate, hideNestedSubtasks, isOpen, sortTasks, tasksForNav } from "../services/query";
import { basename } from "../services/TaskIndex";
import type TaskManagerPlugin from "../main";
import { NavTarget, SMART_LISTS, SmartList, Task } from "../types";
import { colorFor, plainText, renderCheckbox, renderProjectMarker } from "./render";

/**
 * ```task-manager
 * view: today            # home | inbox | today | upcoming | all
 * project: Projects/Site # or a project note instead of view
 * tag: work              # or a tag
 * limit: 10
 * title: My day
 * completed: true
 * add: true              # quick-add field under the list
 * filter: report
 * ```
 * A live task list inside a note — e.g. on the note the Homepage plugin opens.
 */
interface EmbedOptions {
	nav: NavTarget | null;
	raw: string;
	limit: number;
	title?: string;
	completed: boolean;
	add: boolean;
	filter: string;
}

export function registerEmbed(plugin: TaskManagerPlugin): void {
	const handler = (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
		ctx.addChild(new TaskListEmbed(plugin, el, parseOptions(plugin, source, ctx.sourcePath)));
	};
	plugin.registerMarkdownCodeBlockProcessor("task-manager", handler);
	plugin.registerMarkdownCodeBlockProcessor("mtm", handler);
}

function parseOptions(plugin: TaskManagerPlugin, source: string, sourcePath: string): EmbedOptions {
	const kv = new Map<string, string>();
	for (const line of source.split("\n")) {
		const m = line.match(/^\s*([a-zA-Z]+)\s*:\s*(.*?)\s*$/);
		if (m) kv.set(m[1].toLowerCase(), m[2]);
	}
	const bool = (k: string, def: boolean) => (kv.has(k) ? /^(true|yes|1|да)$/i.test(kv.get(k)!) : def);
	let nav: NavTarget | null = null;
	let raw = "";
	if (kv.get("project")) {
		raw = kv.get("project")!;
		const link = raw.replace(/^\[\[|\]\]$/g, "").split("|")[0];
		const file = plugin.app.metadataCache.getFirstLinkpathDest(link, sourcePath);
		nav = { kind: "project", path: file?.path ?? (link.endsWith(".md") ? link : `${link}.md`) };
	} else if (kv.get("tag")) {
		nav = { kind: "tag", tag: kv.get("tag")!.replace(/^#/, "") };
	} else {
		raw = (kv.get("view") ?? "today").toLowerCase();
		if ((SMART_LISTS as string[]).includes(raw)) nav = { kind: raw as SmartList };
	}
	const limit = parseInt(kv.get("limit") ?? "", 10);
	return {
		nav,
		raw,
		limit: limit > 0 ? limit : 20,
		title: kv.get("title") || undefined,
		completed: bool("completed", false),
		add: bool("add", false),
		filter: kv.get("filter") ?? "",
	};
}

class TaskListEmbed extends MarkdownRenderChild {
	constructor(
		private plugin: TaskManagerPlugin,
		containerEl: HTMLElement,
		private opts: EmbedOptions,
	) {
		super(containerEl);
	}

	onload(): void {
		this.render();
		this.registerEvent(this.plugin.index.on("changed", this.refresh));
	}

	onunload(): void {
		this.refresh.cancel();
	}

	private refresh = debounce(() => this.render(), 100, true);

	private label(nav: NavTarget): string {
		if (nav.kind === "project") return basename(nav.path);
		if (nav.kind === "tag") return `#${nav.tag}`;
		return t(nav.kind);
	}

	private render(): void {
		const { plugin, opts } = this;
		const { index, settings } = plugin;
		const el = this.containerEl;
		el.empty();
		el.addClass("mtm-embed");
		const nav = opts.nav;
		if (!nav) {
			el.createDiv({ cls: "mtm-embed-error", text: t("embedUnknown", { v: opts.raw }) });
			return;
		}

		const head = el.createDiv({ cls: "mtm-embed-head" });
		const icon = head.createSpan({ cls: "mtm-embed-icon" });
		if (nav.kind === "project") renderProjectMarker(icon, settings, nav.path);
		else if (nav.kind === "tag") icon.createSpan({ cls: "mtm-dot" }).style.background = colorFor(nav.tag);
		else setIcon(icon, { home: "home", inbox: "inbox", today: "calendar", upcoming: "calendar-range", all: "list" }[nav.kind]);
		head.createSpan({ cls: "mtm-embed-title", text: opts.title ?? this.label(nav) });
		const countEl = head.createSpan({ cls: "mtm-embed-count" });
		head.createDiv({ cls: "mtm-spacer" });
		const open = head.createDiv({ cls: "clickable-icon", attr: { "aria-label": t("embedOpen") } });
		setIcon(open, "arrow-up-right");
		open.addEventListener("click", () => void plugin.activateView(nav));

		const list = el.createDiv({ cls: "mtm-embed-list" });
		if (!index.ready) {
			list.createDiv({ cls: "mtm-embed-empty", text: t("indexing") });
			return;
		}
		let tasks = tasksForNav(nav, index, settings, opts.completed);
		tasks = applyFilter(tasks, opts.filter);
		tasks = sortTasks(hideNestedSubtasks(tasks), "smart");
		countEl.setText(String(tasks.length));
		if (!tasks.length) list.createDiv({ cls: "mtm-embed-empty", text: t("noTasks") });
		for (const task of tasks.slice(0, opts.limit)) this.renderRow(list, task);
		if (tasks.length > opts.limit) {
			const more = list.createDiv({ cls: "mtm-embed-more", text: t("embedMore", { n: tasks.length - opts.limit }) });
			more.addEventListener("click", () => void plugin.activateView(nav));
		}

		if (opts.add) {
			const add = el.createDiv({ cls: "mtm-quickadd mtm-embed-add" });
			setIcon(add.createSpan({ cls: "mtm-quickadd-icon" }), "plus");
			const input = add.createEl("input", { type: "text", cls: "mtm-quickadd-input", attr: { placeholder: t("addTask") } });
			input.addEventListener("keydown", async (e) => {
				if (e.key !== "Enter" || e.isComposing || !input.value.trim()) return;
				e.preventDefault();
				const spec = parseQuickAdd(input.value, buildParserConfig(settings));
				input.value = "";
				if (!spec.title) return;
				let path = settings.inboxPath;
				if (nav.kind === "project") path = nav.path;
				else if (nav.kind === "tag") spec.tags = [...(spec.tags ?? []), nav.tag];
				else if (nav.kind === "today") spec.due ??= today();
				await plugin.writer.createTask(path, spec);
			});
		}
	}

	private renderRow(parent: HTMLElement, task: Task): void {
		const { plugin } = this;
		const { index, settings } = plugin;
		const row = parent.createDiv({ cls: "mtm-embed-row" });
		row.toggleClass("is-closed", !isOpen(task));
		const box = renderCheckbox(row, task);
		box.addEventListener("click", (e) => {
			e.stopPropagation();
			void plugin.writer.toggle([task]);
		});
		row.createSpan({ cls: "mtm-embed-row-title", text: plainText(task.title) || "—" });
		const meta = row.createDiv({ cls: "mtm-row-meta" });
		const date = effectiveDate(task);
		if (date) {
			const chip = meta.createSpan({ cls: "mtm-chip mtm-date" });
			const diff = daysFromToday(date);
			chip.toggleClass("is-overdue", isOpen(task) && diff < 0);
			chip.toggleClass("is-today", diff === 0);
			setIcon(chip.createSpan(), "calendar");
			chip.createSpan({ text: displayDate(date, settings.dateDisplayFormat) });
		}
		const project = index.projectOf(task.path);
		if (project) {
			const chip = meta.createSpan({ cls: "mtm-chip mtm-project-chip" });
			renderProjectMarker(chip, settings, project);
			chip.createSpan({ text: basename(project) });
		}
		for (const tag of task.tags.slice(0, 2)) {
			meta.createSpan({ cls: "mtm-tag", text: `#${tag}` }).style.setProperty("--mtm-tag-color", colorFor(tag));
		}
		row.addEventListener("click", () => {
			void plugin.app.workspace.openLinkText(task.path, "", false, { eState: { line: task.line } });
		});
	}
}
