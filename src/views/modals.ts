import { App, FuzzySuggestModal, getIconIds, Modal, setIcon, Setting } from "obsidian";
import { t } from "../i18n";
import type TaskManagerPlugin from "../main";
import { today } from "../parser/dates";
import { priorityLabel } from "../services/query";
import { basename } from "../services/TaskIndex";
import { HomeDateScope, Priority, PRIORITIES_DESC, ProjectStyle, SMART_LISTS, SmartList } from "../types";
import { colorFor } from "./render";

export class DatePickerModal extends Modal {
	constructor(
		app: App,
		private initial: string | undefined,
		private onPick: (iso: string | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(t("setDatePick"));
		const input = this.contentEl.createEl("input", { type: "date", cls: "mtm-date-input" });
		input.value = this.initial ?? today();
		const submit = () => {
			if (input.value) this.onPick(input.value);
			this.close();
		};
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") submit();
		});
		new Setting(this.contentEl)
			.addButton((b) =>
				b.setButtonText(t("clearDate")).onClick(() => {
					this.onPick(null);
					this.close();
				}),
			)
			.addButton((b) => b.setButtonText(t("save")).setCta().onClick(submit));
		window.setTimeout(() => input.focus(), 0);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private message: string,
		private onConfirm: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("p", { text: this.message });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText(t("cancel")).onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText(t("confirm"))
					.setWarning()
					.onClick(() => {
						this.close();
						this.onConfirm();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Pick an existing tag or type a new one. */
export class TagSuggestModal extends FuzzySuggestModal<string> {
	constructor(
		app: App,
		private tags: string[],
		private onPick: (tag: string) => void,
	) {
		super(app);
		this.setPlaceholder(t("addTag"));
	}

	getItems(): string[] {
		const q = this.inputEl.value.trim().replace(/^#/, "");
		const items = [...this.tags];
		if (q && !items.some((x) => x.toLowerCase() === q.toLowerCase())) items.unshift(q);
		return items;
	}

	getItemText(item: string): string {
		return `#${item}`;
	}

	onChooseItem(item: string): void {
		this.onPick(item);
	}
}

export class FileSuggestModal extends FuzzySuggestModal<string> {
	constructor(
		app: App,
		private paths: string[],
		private onPick: (path: string) => void,
		placeholder: string,
	) {
		super(app);
		this.setPlaceholder(placeholder);
	}

	getItems(): string[] {
		return this.paths;
	}

	getItemText(item: string): string {
		return `${basename(item)}  ·  ${item}`;
	}

	onChooseItem(item: string): void {
		this.onPick(item);
	}
}

/** Picks an existing note to use as a project, or offers to create a new note from the typed name. */
export class ProjectNoteSuggestModal extends FuzzySuggestModal<string> {
	constructor(
		app: App,
		private paths: string[],
		private newNoteFolder: string,
		private onPick: (path: string, create: boolean) => void,
	) {
		super(app);
		this.setPlaceholder(t("addProjectPlaceholder"));
	}

	private newPath(): string | null {
		const name = this.inputEl.value.trim().replace(/[\\/:*?"<>|#^[\]]/g, "").replace(/\.md$/i, "");
		if (!name) return null;
		const folder = this.newNoteFolder.replace(/\/$/, "");
		return `${folder ? folder + "/" : ""}${name}.md`;
	}

	getItems(): string[] {
		const p = this.newPath();
		return p && !this.paths.includes(p) ? [NEW_NOTE + p, ...this.paths] : this.paths;
	}

	getItemText(item: string): string {
		if (item.startsWith(NEW_NOTE)) return t("createProjectNote", { path: item.slice(NEW_NOTE.length) });
		return `${basename(item)}  ·  ${item}`;
	}

	onChooseItem(item: string): void {
		if (item.startsWith(NEW_NOTE)) this.onPick(item.slice(NEW_NOTE.length), true);
		else this.onPick(item, false);
	}
}

const NEW_NOTE = "\u0000new:";

/** Command-palette quick add: a single input that understands the same shortcuts as the in-view bar. */
export class QuickAddModal extends Modal {
	constructor(
		app: App,
		private onSubmit: (text: string) => Promise<void>,
		private heading: string = t("quickAdd"),
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.heading);
		const input = this.contentEl.createEl("input", {
			type: "text",
			cls: "mtm-quickadd-modal-input",
			attr: { placeholder: t("addTaskPlaceholder") },
		});
		input.addEventListener("keydown", async (e) => {
			if (e.key === "Enter" && !e.isComposing && input.value.trim()) {
				e.preventDefault();
				const text = input.value;
				this.close();
				await this.onSubmit(text);
			}
		});
		window.setTimeout(() => input.focus(), 0);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

const PALETTE = [
	"#e5484d",
	"#f76b15",
	"#ffc53d",
	"#46a758",
	"#12a594",
	"#00a2c7",
	"#3e63dd",
	"#8e4ec6",
	"#d6409f",
	"#a18072",
	"#8b8d98",
];

const COMMON_ICONS = [
	"folder",
	"briefcase",
	"home",
	"book-open",
	"graduation-cap",
	"code",
	"rocket",
	"target",
	"heart",
	"star",
	"flag",
	"lightbulb",
	"dumbbell",
	"plane",
	"shopping-cart",
	"wallet",
	"music",
	"camera",
	"palette",
	"pen-tool",
	"users",
	"calendar",
	"coffee",
	"gamepad-2",
	"globe",
	"leaf",
	"wrench",
	"zap",
	"trophy",
	"bookmark",
	"gift",
	"film",
	"car",
	"brain",
	"sparkles",
	"layers",
	"archive",
	"building-2",
	"flask-conical",
	"sprout",
];

/** Icon and color of a project. */
export class ProjectStyleModal extends Modal {
	private style: ProjectStyle;

	constructor(
		app: App,
		private path: string,
		initial: ProjectStyle | undefined,
		private onSave: (style: ProjectStyle) => void,
	) {
		super(app);
		this.style = { ...initial };
	}

	onOpen(): void {
		this.modalEl.addClass("mtm-style-modal");
		this.titleEl.setText(t("projectStyle"));
		const { contentEl } = this;

		const preview = contentEl.createDiv({ cls: "mtm-style-preview" });
		const marker = preview.createSpan({ cls: "mtm-project-marker" });
		preview.createSpan({ cls: "mtm-style-preview-name", text: basename(this.path) });
		const update = () => {
			marker.empty();
			marker.style.setProperty("--mtm-project-color", this.style.color || colorFor(this.path));
			if (this.style.icon) setIcon(marker, this.style.icon);
			else marker.createSpan({ cls: "mtm-project-dot" });
			contentEl.querySelectorAll<HTMLElement>("[data-color]").forEach((el) => el.toggleClass("is-active", el.dataset.color === (this.style.color ?? "")));
			contentEl.querySelectorAll<HTMLElement>("[data-icon]").forEach((el) => el.toggleClass("is-active", el.dataset.icon === (this.style.icon ?? "")));
		};

		// ---- color ----
		contentEl.createDiv({ cls: "mtm-style-label", text: t("color") });
		const colors = contentEl.createDiv({ cls: "mtm-swatches" });
		const auto = colors.createDiv({ cls: "mtm-swatch mtm-swatch-auto", attr: { "data-color": "", "aria-label": t("auto") } });
		auto.style.setProperty("--mtm-swatch", colorFor(this.path));
		setIcon(auto, "wand-2");
		auto.addEventListener("click", () => {
			delete this.style.color;
			update();
		});
		for (const c of PALETTE) {
			const sw = colors.createDiv({ cls: "mtm-swatch", attr: { "data-color": c, "aria-label": c } });
			sw.style.setProperty("--mtm-swatch", c);
			sw.addEventListener("click", () => {
				this.style.color = c;
				update();
			});
		}
		const custom = colors.createEl("input", { type: "color", cls: "mtm-swatch-custom", attr: { "aria-label": t("customColor") } });
		custom.value = /^#[0-9a-f]{6}$/i.test(this.style.color ?? "") ? (this.style.color as string) : "#3e63dd";
		custom.addEventListener("input", () => {
			this.style.color = custom.value;
			update();
		});

		// ---- icon ----
		contentEl.createDiv({ cls: "mtm-style-label", text: t("icon") });
		const search = contentEl.createEl("input", { type: "search", cls: "mtm-icon-search", attr: { placeholder: t("searchIcons") } });
		const grid = contentEl.createDiv({ cls: "mtm-icon-grid" });
		const allIds = getIconIds();
		const renderIcons = () => {
			grid.empty();
			const q = search.value.trim().toLowerCase();
			const ids = q ? allIds.filter((id) => id.toLowerCase().includes(q)).slice(0, 80) : COMMON_ICONS;
			const none = grid.createDiv({ cls: "mtm-icon-cell", attr: { "data-icon": "", "aria-label": t("noIcon") } });
			setIcon(none, "ban");
			none.addEventListener("click", () => {
				delete this.style.icon;
				update();
			});
			for (const id of ids) {
				const cell = grid.createDiv({ cls: "mtm-icon-cell", attr: { "data-icon": id, "aria-label": id.replace(/^lucide-/, "") } });
				setIcon(cell, id);
				cell.addEventListener("click", () => {
					this.style.icon = id;
					update();
				});
			}
			update();
		};
		search.addEventListener("input", renderIcons);
		renderIcons();

		new Setting(contentEl)
			.addButton((b) => b.setButtonText(t("cancel")).onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText(t("save"))
					.setCta()
					.onClick(() => {
						this.onSave(this.style);
						this.close();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * Controls for the "Home" list and the start screen. Shared by the settings tab and the modal
 * opened from the Home header; every change is saved right away.
 */
export function renderHomeSettings(el: HTMLElement, plugin: TaskManagerPlugin): void {
	const s = plugin.settings;
	const home = s.home;
	const save = () => plugin.saveSettings();

	new Setting(el)
		.setName(t("s_startScreen"))
		.setDesc(t("s_startScreenDesc"))
		.addDropdown((d) => {
			for (const l of SMART_LISTS) d.addOption(l, t(l));
			d.setValue(s.startScreen).onChange(async (v) => {
				s.startScreen = v as SmartList;
				await save();
			});
		});

	new Setting(el)
		.setName(t("s_homeDates"))
		.setDesc(t("s_homeDatesDesc"))
		.addDropdown((d) => {
			for (const k of ["any", "today", "week", "dated", "undated"] as HomeDateScope[]) d.addOption(k, t(`home_${k}`));
			d.setValue(home.dateScope).onChange(async (v) => {
				home.dateScope = v as HomeDateScope;
				await save();
			});
		});

	new Setting(el).setName(t("s_homePriority")).addDropdown((d) => {
		for (const p of [...PRIORITIES_DESC].reverse()) d.addOption(String(p), p === Priority.Lowest ? t("anyPriority") : `≥ ${priorityLabel(p)}`);
		d.setValue(String(home.minPriority)).onChange(async (v) => {
			home.minPriority = Number(v) as Priority;
			await save();
		});
	});

	new Setting(el)
		.setName(t("s_homeTags"))
		.setDesc(t("s_homeTagsDesc"))
		.addText((x) =>
			x
				.setPlaceholder("work, personal")
				.setValue(home.tags.join(", "))
				.onChange(async (v) => {
					home.tags = v
						.split(",")
						.map((x) => x.trim().replace(/^#/, ""))
						.filter(Boolean);
					await save();
				}),
		);

	new Setting(el).setName(t("s_homeProjects")).setDesc(t("s_homeProjectsDesc"));
	const list = el.createDiv({ cls: "mtm-check-list" });
	const projects = plugin.index.allProjects();
	if (!projects.length) list.createDiv({ cls: "mtm-path-empty", text: t("s_listEmpty") });
	for (const path of projects) {
		const row = list.createEl("label", { cls: "mtm-check-row" });
		const cb = row.createEl("input", { type: "checkbox" });
		cb.checked = home.projects.includes(path);
		row.createSpan({ text: basename(path) });
		cb.addEventListener("change", async () => {
			home.projects = cb.checked ? [...home.projects, path] : home.projects.filter((p) => p !== path);
			await save();
		});
	}

	new Setting(el)
		.setName(t("s_homeInbox"))
		.setDesc(t("s_homeInboxDesc"))
		.addToggle((x) =>
			x.setValue(home.includeInbox).onChange(async (v) => {
				home.includeInbox = v;
				await save();
			}),
		);

	new Setting(el).setName(t("s_sidebarLists")).setDesc(t("s_sidebarListsDesc"));
	const lists = el.createDiv({ cls: "mtm-check-list" });
	for (const l of SMART_LISTS) {
		const row = lists.createEl("label", { cls: "mtm-check-row" });
		const cb = row.createEl("input", { type: "checkbox" });
		cb.checked = !s.hiddenSmartLists.includes(l);
		row.createSpan({ text: t(l) });
		cb.addEventListener("change", async () => {
			s.hiddenSmartLists = cb.checked ? s.hiddenSmartLists.filter((x) => x !== l) : [...s.hiddenSmartLists, l];
			await save();
		});
	}
}

export class HomeSettingsModal extends Modal {
	constructor(
		app: App,
		private plugin: TaskManagerPlugin,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("mtm-home-modal");
		this.titleEl.setText(t("homeSettings"));
		renderHomeSettings(this.contentEl, this.plugin);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
