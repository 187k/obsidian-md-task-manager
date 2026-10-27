import { App, CachedMetadata, debounce, Events, TAbstractFile, TFile, getAllTags } from "obsidian";
import { buildParserConfig, mayContainTasks, parseFile, ParserConfig } from "../parser/TaskParser";
import { Task, TaskManagerSettings } from "../types";

/**
 * In-memory index of every task in the vault.
 *
 * The full scan runs once on layout-ready; after that only the files that change are re-parsed.
 * Listeners subscribe to the "changed" event, which is debounced so a burst of edits
 * (e.g. a bulk operation touching ten files) results in a single UI refresh.
 */
export class TaskIndex extends Events {
	private byFile = new Map<string, Task[]>();
	private byId = new Map<string, Task>();
	private projectFiles = new Set<string>();
	private pending = new Set<string>();
	private cfg: ParserConfig;
	ready = false;

	constructor(
		private app: App,
		private getSettings: () => TaskManagerSettings,
	) {
		super();
		this.cfg = buildParserConfig(getSettings());
	}

	// ---- lifecycle ----------------------------------------------------------

	/** Registers vault listeners. Returns the event refs so the plugin can unregister them on unload. */
	attach(register: (ref: ReturnType<Events["on"]>) => void): void {
		const { vault, metadataCache } = this.app;
		register(vault.on("create", (f) => this.queue(f)));
		register(vault.on("modify", (f) => this.queue(f)));
		register(vault.on("delete", (f) => this.remove(f.path)));
		register(
			vault.on("rename", (f, oldPath) => {
				this.remove(oldPath);
				this.queue(f);
			}),
		);
		// Frontmatter can turn a note into a project without its tasks changing.
		register(metadataCache.on("changed", (f) => this.queue(f)));
	}

	async rebuild(): Promise<void> {
		this.cfg = buildParserConfig(this.getSettings());
		this.byFile.clear();
		this.byId.clear();
		this.projectFiles.clear();
		const files = this.app.vault.getMarkdownFiles().filter((f) => !this.isExcluded(f.path));
		const BATCH = 50;
		for (let i = 0; i < files.length; i += BATCH) {
			await Promise.all(files.slice(i, i + BATCH).map((f) => this.indexFile(f, false)));
			// Yield to the UI between batches so large vaults don't freeze on startup.
			await new Promise((r) => window.setTimeout(r, 0));
		}
		this.ready = true;
		this.trigger("changed");
	}

	// ---- incremental updates -----------------------------------------------

	private queue(file: TAbstractFile): void {
		if (!(file instanceof TFile) || file.extension !== "md") return;
		this.pending.add(file.path);
		this.flush();
	}

	private flush = debounce(
		async () => {
			const paths = [...this.pending];
			this.pending.clear();
			for (const path of paths) {
				const f = this.app.vault.getAbstractFileByPath(path);
				if (f instanceof TFile && !this.isExcluded(path)) await this.indexFile(f, false);
				else this.drop(path);
			}
			this.emitChanged();
		},
		150,
		true,
	);

	private emitChanged = debounce(() => this.trigger("changed"), 50, true);

	private remove(path: string): void {
		this.drop(path);
		this.emitChanged();
	}

	private drop(path: string): void {
		for (const t of this.byFile.get(path) ?? []) this.byId.delete(t.id);
		this.byFile.delete(path);
		this.projectFiles.delete(path);
	}

	/** Re-reads one file right away. The writer calls this after editing so the UI never shows stale lines. */
	async refreshFile(path: string): Promise<void> {
		const f = this.app.vault.getAbstractFileByPath(path);
		if (f instanceof TFile) await this.indexFile(f, true);
		else this.remove(path);
	}

	private async indexFile(file: TFile, notify: boolean): Promise<void> {
		const content = await this.app.vault.cachedRead(file);
		this.drop(file.path);
		if (mayContainTasks(content)) {
			const tasks = parseFile(file.path, content, this.cfg);
			if (tasks.length) {
				this.byFile.set(file.path, tasks);
				for (const t of tasks) this.byId.set(t.id, t);
			}
		}
		if (this.isProjectFile(file)) this.projectFiles.add(file.path);
		if (notify) this.emitChanged();
	}

	// ---- classification -----------------------------------------------------

	private isExcluded(path: string): boolean {
		return this.getSettings().excludeFolders.some((f) => f && (path === f || path.startsWith(f.replace(/\/$/, "") + "/")));
	}

	private isProjectFile(file: TFile): boolean {
		const s = this.getSettings();
		if (file.path === s.inboxPath) return false;
		if (s.projectFolders.some((f) => f && file.path.startsWith(f.replace(/\/$/, "") + "/"))) return true;
		const marker = s.projectTag.trim().replace(/^#/, "").toLowerCase();
		if (!marker) return false;
		const cache: CachedMetadata | null = this.app.metadataCache.getFileCache(file);
		const tags = (cache ? getAllTags(cache) ?? [] : []).map((t) => t.replace(/^#/, "").toLowerCase());
		const fmType = cache?.frontmatter?.type;
		const types = (Array.isArray(fmType) ? fmType : fmType ? [fmType] : []).map((x: unknown) => String(x).toLowerCase());
		return tags.includes(marker) || types.includes(marker);
	}

	// ---- queries ------------------------------------------------------------

	get(id: string): Task | undefined {
		return this.byId.get(id);
	}

	all(): Task[] {
		const out: Task[] = [];
		for (const list of this.byFile.values()) out.push(...list);
		return out;
	}

	inFile(path: string): Task[] {
		return this.byFile.get(path) ?? [];
	}

	/** Project notes that currently contain at least one task, sorted by name. */
	projects(): string[] {
		return [...this.projectFiles].filter((p) => this.byFile.has(p)).sort((a, b) => basename(a).localeCompare(basename(b)));
	}

	allProjects(): string[] {
		return [...this.projectFiles].sort((a, b) => basename(a).localeCompare(basename(b)));
	}

	isProject(path: string): boolean {
		return this.projectFiles.has(path);
	}

	/** Walks up the parent chain; useful to decide whether a subtask is shown on its own. */
	parentOf(task: Task): Task | undefined {
		return task.parentId ? this.byId.get(task.parentId) : undefined;
	}
}

export function basename(path: string): string {
	const name = path.split("/").pop() ?? path;
	return name.replace(/\.md$/, "");
}
