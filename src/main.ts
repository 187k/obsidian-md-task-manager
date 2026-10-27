import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { setLanguage, t } from "./i18n";
import { parseQuickAdd } from "./parser/quickAdd";
import { buildParserConfig } from "./parser/TaskParser";
import { TaskIndex } from "./services/TaskIndex";
import { TaskWriter } from "./services/TaskWriter";
import { DEFAULT_SETTINGS, DEFAULT_STATUSES, TaskManagerSettingTab } from "./settings";
import { TaskManagerSettings } from "./types";
import { QuickAddModal } from "./views/modals";
import { TaskManagerView, VIEW_TYPE_TASK_MANAGER } from "./views/TaskManagerView";

export default class TaskManagerPlugin extends Plugin {
	settings!: TaskManagerSettings;
	index!: TaskIndex;
	writer!: TaskWriter;

	async onload(): Promise<void> {
		await this.loadSettings();
		setLanguage(this.settings.language);

		this.index = new TaskIndex(this.app, () => this.settings);
		this.writer = new TaskWriter(this.app, this.index, () => this.settings);

		this.registerView(VIEW_TYPE_TASK_MANAGER, (leaf) => new TaskManagerView(leaf, this));
		this.addSettingTab(new TaskManagerSettingTab(this.app, this));

		this.addRibbonIcon("list-checks", t("openView"), () => void this.activateView());

		this.addCommand({
			id: "open",
			name: t("openView"),
			callback: () => void this.activateView(),
		});
		this.addCommand({
			id: "quick-add",
			name: t("quickAdd"),
			callback: () =>
				new QuickAddModal(this.app, async (text) => {
					const spec = parseQuickAdd(text, buildParserConfig(this.settings));
					if (spec.title) await this.writer.createTask(this.settings.inboxPath, spec);
				}).open(),
		});
		this.addCommand({
			id: "rebuild-index",
			name: t("rebuildIndex"),
			callback: () => void this.rebuildIndex(true),
		});

		// Keep the manual project lists pointing at the right notes when they are renamed or deleted.
		this.registerEvent(this.app.vault.on("rename", (f, oldPath) => void this.onNotePathChanged(oldPath, f.path)));
		this.registerEvent(this.app.vault.on("delete", (f) => void this.onNotePathChanged(f.path, null)));

		// Index after the vault is loaded, so the initial "create" events for every file are not processed one by one.
		this.app.workspace.onLayoutReady(async () => {
			this.index.attach((ref) => this.registerEvent(ref));
			await this.index.rebuild();
		});
	}

	onunload(): void {
		// Vault/metadata listeners were registered via registerEvent and views are detached by Obsidian,
		// so only our own timer needs cleaning up.
		if (this.reindexTimer !== null) window.clearTimeout(this.reindexTimer);
	}

	async loadSettings(): Promise<void> {
		const data = ((await this.loadData()) ?? {}) as Partial<TaskManagerSettings>;
		this.settings = {
			...DEFAULT_SETTINGS,
			...data,
			priorityKeywords: { ...DEFAULT_SETTINGS.priorityKeywords, ...(data.priorityKeywords ?? {}) },
			statuses: (data.statuses?.length ? data.statuses : DEFAULT_STATUSES).map((s) => ({ ...s })),
			pinnedTags: [...(data.pinnedTags ?? DEFAULT_SETTINGS.pinnedTags)],
			projectFolders: [...(data.projectFolders ?? DEFAULT_SETTINGS.projectFolders)],
			excludeFolders: [...(data.excludeFolders ?? DEFAULT_SETTINGS.excludeFolders)],
			manualProjects: [...(data.manualProjects ?? [])],
			hiddenProjects: [...(data.hiddenProjects ?? [])],
			navPrefs: { ...(data.navPrefs ?? {}) },
		};
	}

	/**
	 * Persists settings and refreshes open views.
	 * Pass `reindex` when the change affects parsing (statuses, keywords, folders, global filter).
	 */
	async saveSettings(reindex = false): Promise<void> {
		await this.saveData(this.settings);
		setLanguage(this.settings.language);
		if (reindex) this.scheduleReindex();
		else this.refreshViews();
	}

	private reindexTimer: number | null = null;

	private scheduleReindex(): void {
		if (this.reindexTimer !== null) window.clearTimeout(this.reindexTimer);
		this.reindexTimer = window.setTimeout(() => {
			this.reindexTimer = null;
			void this.rebuildIndex(false);
		}, 500);
	}

	/** Makes a note a project by hand (and un-hides it if it was hidden). */
	async addProject(path: string): Promise<void> {
		const s = this.settings;
		s.hiddenProjects = s.hiddenProjects.filter((p) => p !== path);
		if (!s.manualProjects.includes(path)) s.manualProjects.push(path);
		await this.saveData(s);
		await this.index.refreshFile(path);
		this.refreshViews();
	}

	/**
	 * Removes a note from projects. A note added by hand is simply dropped from that list;
	 * a note that a folder/tag rule would still pick up is put on the hidden list.
	 */
	async removeProject(path: string): Promise<void> {
		const s = this.settings;
		s.manualProjects = s.manualProjects.filter((p) => p !== path);
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile && this.index.matchesProjectRules(file) && !s.hiddenProjects.includes(path)) {
			s.hiddenProjects.push(path);
		}
		await this.saveData(s);
		await this.index.refreshFile(path);
		this.refreshViews();
	}

	/** Un-hides a note so the folder/tag rules apply to it again. */
	async unhideProject(path: string): Promise<void> {
		this.settings.hiddenProjects = this.settings.hiddenProjects.filter((p) => p !== path);
		await this.saveData(this.settings);
		await this.index.refreshFile(path);
		this.refreshViews();
	}

	private async onNotePathChanged(oldPath: string, newPath: string | null): Promise<void> {
		let changed = false;
		for (const list of [this.settings.manualProjects, this.settings.hiddenProjects]) {
			const i = list.indexOf(oldPath);
			if (i < 0) continue;
			if (newPath) list[i] = newPath;
			else list.splice(i, 1);
			changed = true;
		}
		if (changed) await this.saveData(this.settings);
	}

	async rebuildIndex(notify: boolean): Promise<void> {
		await this.index.rebuild();
		if (notify) new Notice(t("indexRebuilt", { n: this.index.all().length }));
	}

	refreshViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TASK_MANAGER)) {
			if (leaf.view instanceof TaskManagerView) leaf.view.renderAll();
		}
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_TASK_MANAGER)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: VIEW_TYPE_TASK_MANAGER, active: true });
		}
		await workspace.revealLeaf(leaf);
	}

	openSettings(): void {
		const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
		setting?.open();
		setting?.openTabById(this.manifest.id);
	}
}
