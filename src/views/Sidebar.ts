import { Menu, setIcon } from "obsidian";
import { t } from "../i18n";
import { addDays, today } from "../parser/dates";
import { countOpen, isOpen } from "../services/query";
import { basename } from "../services/TaskIndex";
import { NavTarget, navKey, SmartList } from "../types";
import { FileSuggestModal, ProjectNoteSuggestModal, ProjectStyleModal } from "./modals";
import { colorFor, renderProjectMarker } from "./render";
import { DND_TAG, TaskManagerView } from "./TaskManagerView";

interface TagNode {
	name: string;
	full: string;
	count: number;
	children: Map<string, TagNode>;
}

function buildTagTree(view: TaskManagerView): TagNode {
	const root: TagNode = { name: "", full: "", count: 0, children: new Map() };
	for (const task of view.plugin.index.all()) {
		const open = isOpen(task);
		// Count each task once per tree node even if several of its tags share a prefix.
		const counted = new Set<string>();
		for (const tag of task.tags) {
			let node = root;
			const parts = tag.split("/");
			parts.forEach((part, i) => {
				const full = parts.slice(0, i + 1).join("/");
				const key = part.toLowerCase();
				let child = node.children.get(key);
				if (!child) {
					child = { name: part, full, count: 0, children: new Map() };
					node.children.set(key, child);
				}
				if (open && !counted.has(full.toLowerCase())) {
					child.count++;
					counted.add(full.toLowerCase());
				}
				node = child;
			});
		}
	}
	return root;
}

export function renderSidebar(view: TaskManagerView, el: HTMLElement): void {
	const { plugin } = view;
	const { index, settings, writer } = plugin;
	const scroll = el.querySelector(".mtm-sidebar-scroll")?.scrollTop ?? 0;
	el.empty();
	const nav = el.createDiv({ cls: "mtm-sidebar-scroll" });
	const current = navKey(view.nav);

	const item = (
		parent: HTMLElement,
		target: NavTarget,
		label: string,
		opts: { icon?: string; color?: string; project?: string; count?: number; depth?: number } = {},
	): HTMLElement => {
		const row = parent.createDiv({ cls: "mtm-nav-item" });
		row.toggleClass("is-active", navKey(target) === current);
		if (opts.depth) row.style.paddingLeft = `${8 + opts.depth * 14}px`;
		const icon = row.createSpan({ cls: "mtm-nav-icon" });
		if (opts.project) renderProjectMarker(icon, settings, opts.project);
		else if (opts.color) icon.createSpan({ cls: "mtm-dot" }).style.background = opts.color;
		else if (opts.icon) setIcon(icon, opts.icon);
		row.createSpan({ cls: "mtm-nav-label", text: label });
		if (opts.count) row.createSpan({ cls: "mtm-nav-count", text: String(opts.count) });
		row.addEventListener("click", () => view.setNav(target));
		return row;
	};

	const section = (
		key: string,
		label: string,
		build: (body: HTMLElement) => void,
		action?: { icon: string; label: string; onClick: () => void },
	) => {
		const id = `section:${key}`;
		const collapsed = view.collapsed.has(id);
		const head = nav.createDiv({ cls: "mtm-nav-section" });
		head.toggleClass("is-collapsed", collapsed);
		setIcon(head.createSpan({ cls: "mtm-chevron" }), "chevron-down");
		head.createSpan({ cls: "mtm-nav-section-label", text: label });
		if (action) {
			const btn = head.createSpan({ cls: "clickable-icon mtm-nav-section-action", attr: { "aria-label": action.label } });
			setIcon(btn, action.icon);
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				action.onClick();
			});
		}
		head.addEventListener("click", () => {
			if (collapsed) view.collapsed.delete(id);
			else view.collapsed.add(id);
			renderSidebar(view, el);
		});
		if (!collapsed) build(nav.createDiv({ cls: "mtm-nav-section-body" }));
	};

	const tagItem = (parent: HTMLElement, tag: string, label: string, count: number, depth = 0, color = colorFor(tag)) => {
		const row = item(parent, { kind: "tag", tag }, label, { color, count, depth });
		// Drag a tag onto a task to add it (as in the video); drop tasks on a tag to tag them.
		row.setAttr("draggable", "true");
		row.addEventListener("dragstart", (e) => e.dataTransfer?.setData(DND_TAG, tag));
		view.makeDropTarget(row, (tasks) => writer.addTag(tasks, tag));
		row.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			const pinned = settings.pinnedTags.some((p) => p.toLowerCase() === tag.toLowerCase());
			new Menu()
				.addItem((i) =>
					i
						.setTitle(pinned ? t("unpinTag") : t("pinTag"))
						.setIcon(pinned ? "pin-off" : "pin")
						.onClick(async () => {
							settings.pinnedTags = pinned
								? settings.pinnedTags.filter((p) => p.toLowerCase() !== tag.toLowerCase())
								: [...settings.pinnedTags, tag];
							await plugin.saveSettings();
							view.renderAll();
						}),
				)
				.showAtMouseEvent(e);
		});
		return row;
	};

	if (!index.ready) {
		nav.createDiv({ cls: "mtm-empty", text: t("indexing") });
		return;
	}

	// ---- smart lists ----
	const smart = nav.createDiv({ cls: "mtm-nav-group" });
	const shown = (l: SmartList) => !settings.hiddenSmartLists.includes(l);
	const smartItem = (kind: SmartList, icon: string) =>
		item(smart, { kind }, t(kind), { icon, count: countOpen({ kind }, index, settings) });
	if (shown("home")) {
		const home = smartItem("home", "home");
		const gear = home.createSpan({ cls: "clickable-icon mtm-nav-item-action", attr: { "aria-label": t("homeSettings") } });
		setIcon(gear, "sliders-horizontal");
		gear.addEventListener("click", (e) => {
			e.stopPropagation();
			view.openHomeSettings();
		});
	}
	if (shown("inbox")) view.makeDropTarget(smartItem("inbox", "inbox"), (tasks) => writer.move(tasks, settings.inboxPath));
	if (shown("today")) view.makeDropTarget(smartItem("today", "calendar"), (tasks) => writer.setDate(tasks, "due", today()));
	if (shown("upcoming")) {
		view.makeDropTarget(smartItem("upcoming", "calendar-range"), (tasks) => writer.setDate(tasks, "due", addDays(today(), 1)));
	}
	if (shown("all")) smartItem("all", "list");

	// ---- pinned tags ----
	if (settings.pinnedTags.length) {
		section("pinned", t("pinned"), (body) => {
			for (const tag of settings.pinnedTags) {
				tagItem(body, tag, `#${tag}`, countOpen({ kind: "tag", tag }, index, settings));
			}
		});
	}

	// ---- projects ----
	// Always shown, so the "+" button is reachable even before the first project exists.
	const projects = index.projects();
	section(
		"projects",
		t("projects"),
		(body) => {
			if (!projects.length) body.createDiv({ cls: "mtm-nav-hint", text: t("noProjectsHint") });
			for (const path of projects) {
				const row = item(body, { kind: "project", path }, basename(path), {
					project: path,
					count: countOpen({ kind: "project", path }, index, settings),
				});
				row.addClass("mtm-project-item");
				row.setAttr("aria-label", path);
				view.makeDropTarget(row, (tasks) => writer.move(tasks, path));
				row.addEventListener("contextmenu", (e) => {
					e.preventDefault();
					new Menu()
						.addItem((i) =>
							i
								.setTitle(t("openNote"))
								.setIcon("file-text")
								.onClick(() => void view.app.workspace.openLinkText(path, "", "tab")),
						)
						.addItem((i) => i.setTitle(t("projectStyle")).setIcon("palette").onClick(() => editProjectStyle(view, path)))
						.addItem((i) => i.setTitle(t("attachNote")).setIcon("paperclip").onClick(() => pickAttachedNote(view, path)))
						.addSeparator()
						.addItem((i) =>
							i
								.setTitle(t("removeProject"))
								.setIcon("folder-minus")
								.onClick(async () => {
									if (view.nav.kind === "project" && view.nav.path === path) view.setNav({ kind: "today" });
									await plugin.removeProject(path);
								}),
						)
						.showAtMouseEvent(e);
				});
			}
		},
		{ icon: "plus", label: t("addProject"), onClick: () => pickProjectNote(view) },
	);

	// ---- tag tree ----
	const tree = buildTagTree(view);
	if (tree.children.size) {
		section("tags", t("tags"), (body) => {
			const renderNode = (node: TagNode, depth: number) => {
				const id = `tag:${node.full.toLowerCase()}`;
				const hasChildren = node.children.size > 0;
				const collapsed = !view.collapsed.has(`open:${id}`);
				const row = tagItem(body, node.full, node.name, node.count, depth);
				if (hasChildren) {
					const chev = row.createSpan({ cls: "mtm-tree-toggle" });
					row.prepend(chev);
					chev.toggleClass("is-collapsed", collapsed);
					setIcon(chev, "chevron-down");
					chev.addEventListener("click", (e) => {
						e.stopPropagation();
						if (collapsed) view.collapsed.add(`open:${id}`);
						else view.collapsed.delete(`open:${id}`);
						renderSidebar(view, el);
					});
				} else {
					row.prepend(createSpan({ cls: "mtm-tree-toggle" }));
				}
				if (hasChildren && !collapsed) {
					for (const child of sortedChildren(node)) renderNode(child, depth + 1);
				}
			};
			for (const child of sortedChildren(tree)) renderNode(child, 0);
		});
	}

	// ---- footer ----
	const footer = el.createDiv({ cls: "mtm-sidebar-footer" });
	const refresh = footer.createDiv({ cls: "clickable-icon", attr: { "aria-label": t("rebuildIndex") } });
	setIcon(refresh, "refresh-cw");
	refresh.addEventListener("click", () => void plugin.rebuildIndex(true));

	nav.scrollTop = scroll;
}

/** "+" on the Projects header: choose a note (or create one) and make it a project. */
function pickProjectNote(view: TaskManagerView): void {
	const { plugin, app } = view;
	const current = new Set(plugin.index.projects());
	const notes = app.vault
		.getMarkdownFiles()
		.filter((f) => !current.has(f.path))
		.sort((a, b) => b.stat.mtime - a.stat.mtime)
		.map((f) => f.path);
	const folder = plugin.settings.projectFolders[0] ?? "";
	new ProjectNoteSuggestModal(app, notes, folder, async (path, create) => {
		if (create) {
			const dir = path.split("/").slice(0, -1).join("/");
			if (dir && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir);
			if (!app.vault.getAbstractFileByPath(path)) await app.vault.create(path, "");
		}
		await plugin.addProject(path);
		view.setNav({ kind: "project", path });
	}).open();
}

export function editProjectStyle(view: TaskManagerView, path: string): void {
	const { plugin } = view;
	new ProjectStyleModal(view.app, path, plugin.settings.projectStyles[path], async (style) => {
		if (style.icon || style.color) plugin.settings.projectStyles[path] = style;
		else delete plugin.settings.projectStyles[path];
		await plugin.saveSettings();
	}).open();
}

/** Attach another note to a project, so its tasks are listed there too. */
export function pickAttachedNote(view: TaskManagerView, project: string): void {
	const { plugin, app } = view;
	const taken = new Set([project, ...plugin.index.notesOf(project)]);
	const notes = app.vault
		.getMarkdownFiles()
		.filter((f) => !taken.has(f.path))
		.sort((a, b) => b.stat.mtime - a.stat.mtime)
		.map((f) => f.path);
	new FileSuggestModal(app, notes, (path) => void plugin.attachNote(project, path), t("attachNotePlaceholder")).open();
}

function sortedChildren(node: TagNode): TagNode[] {
	return [...node.children.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
