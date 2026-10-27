import { App, moment, normalizePath, Notice, TFile } from "obsidian";
import { t } from "../i18n";
import { nextOccurrence, today } from "../parser/dates";
import * as P from "../parser/TaskParser";
import { DateField, Priority, Task, TaskManagerSettings, TaskPatch, TaskTime } from "../types";
import { TaskIndex } from "./TaskIndex";

/**
 * Receives the lines of a task block (task line first, then subtasks / notes)
 * and returns the replacement lines. Return [] to delete the block.
 */
type BlockEdit = (block: string[], task: Task) => string[];

class TaskChangedError extends Error {}

/**
 * All writes to Markdown go through here. Every edit:
 *  1. runs inside `vault.process`, so it is atomic with respect to other edits of the file;
 *  2. checks that the task line is still exactly what the index saw (or finds it nearby),
 *     and refuses to write otherwise rather than editing the wrong line;
 *  3. re-indexes the file immediately so the UI reflects the result.
 */
export class TaskWriter {
	constructor(
		private app: App,
		private index: TaskIndex,
		private getSettings: () => TaskManagerSettings,
	) {}

	private get cfg(): P.ParserConfig {
		return P.buildParserConfig(this.getSettings());
	}

	// ---- core ---------------------------------------------------------------

	/** Applies `edit` to each task's block. Tasks are grouped per file and processed bottom-up so line numbers stay valid. */
	async editBlocks(tasks: Task[], edit: BlockEdit): Promise<boolean> {
		const byFile = new Map<string, Task[]>();
		for (const task of tasks) {
			const list = byFile.get(task.path) ?? [];
			list.push(task);
			byFile.set(task.path, list);
		}
		let ok = true;
		for (const [path, list] of byFile) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) {
				new Notice(t("errFileMissing", { path }));
				ok = false;
				continue;
			}
			// Skip tasks whose ancestor is also being edited: the ancestor's block already contains them.
			const ids = new Set(list.map((x) => x.id));
			const roots = list.filter((task) => !this.hasAncestorIn(task, ids));
			roots.sort((a, b) => b.line - a.line);
			try {
				await this.app.vault.process(file, (data) => {
					const eol = data.includes("\r\n") ? "\r\n" : "\n";
					const lines = data.split(/\r?\n/);
					for (const task of roots) {
						const idx = locate(lines, task);
						if (idx < 0) throw new TaskChangedError();
						const end = P.blockEnd(lines, idx);
						const replacement = edit(lines.slice(idx, end + 1), task);
						lines.splice(idx, end - idx + 1, ...replacement);
					}
					return lines.join(eol);
				});
			} catch (e) {
				if (!(e instanceof TaskChangedError)) throw e;
				new Notice(t("errTaskChanged"));
				ok = false;
			}
			await this.index.refreshFile(path);
		}
		return ok;
	}

	/** Shorthand for edits that only touch the task line itself. */
	editLines(tasks: Task[], fn: (line: string, task: Task) => string): Promise<boolean> {
		return this.editBlocks(tasks, (block, task) => [fn(block[0], task), ...block.slice(1)]);
	}

	private hasAncestorIn(task: Task, ids: Set<string>): boolean {
		let cur = this.index.parentOf(task);
		while (cur) {
			if (ids.has(cur.id)) return true;
			cur = this.index.parentOf(cur);
		}
		return false;
	}

	// ---- status -------------------------------------------------------------

	/** Checkbox click: open → done, done/cancelled → todo. Handles done dates and recurrence. */
	async toggle(tasks: Task[]): Promise<void> {
		const s = this.getSettings();
		const doneSymbol = s.statuses.find((x) => x.type === "done")?.symbol ?? "x";
		const todoSymbol = s.statuses.find((x) => x.type === "todo")?.symbol ?? " ";
		const closing = tasks.some((task) => task.status.type === "todo" || task.status.type === "in_progress");
		await this.setStatus(tasks, closing ? doneSymbol : todoSymbol);
	}

	async setStatus(tasks: Task[], symbol: string): Promise<void> {
		const s = this.getSettings();
		const cfg = this.cfg;
		const target = s.statuses.find((x) => x.symbol === symbol);
		const type = target?.type ?? (symbol === "x" ? "done" : "todo");
		await this.editBlocks(tasks, (block, task) => {
			let line = P.setStatusSymbol(block[0], symbol);
			line = P.setDate(line, "done", type === "done" && s.setDoneDate ? today() : null, cfg);
			line = P.setDate(line, "cancelled", type === "cancelled" && s.setDoneDate ? today() : null, cfg);
			const out = [line, ...block.slice(1)];
			const wasOpen = task.status.type === "todo" || task.status.type === "in_progress";
			if (type === "done" && wasOpen && task.recurrence) {
				const next = this.nextRecurrence(block[0], task);
				if (next) out.unshift(next);
			}
			return out;
		});
	}

	/** Builds the next instance of a recurring task, Tasks-plugin style (inserted above the completed one). */
	private nextRecurrence(line: string, task: Task): string | null {
		const rule = task.recurrence!;
		const whenDone = /when done$/i.test(rule.trim());
		const cfg = this.cfg;
		const fields: DateField[] = ["due", "scheduled", "start"];
		const ref = whenDone ? today() : task.dates.due ?? task.dates.scheduled ?? task.dates.start;
		if (!ref) return null;
		const nextRef = nextOccurrence(rule, ref);
		if (!nextRef) return null;
		const offset = (d: string) => Math.round((Date.parse(nextRef) - Date.parse(ref)) / 86400000) + daysBetween(ref, d);
		let next = P.setStatusSymbol(line, this.getSettings().statuses.find((x) => x.type === "todo")?.symbol ?? " ");
		for (const f of fields) {
			const d = task.dates[f];
			if (d) next = P.setDate(next, f, addDaysIso(ref, offset(d)), cfg);
		}
		next = P.setDate(next, "done", null, cfg);
		next = P.setDate(next, "cancelled", null, cfg);
		// A block id must stay unique.
		return next.replace(/[ \t]\^[\w-]+[ \t]*$/, "");
	}

	// ---- metadata -----------------------------------------------------------

	setPriority(tasks: Task[], p: Priority): Promise<boolean> {
		const cfg = this.cfg;
		return this.editLines(tasks, (line) => P.setPriority(line, p, cfg));
	}

	setDate(tasks: Task[], field: DateField, value: string | null): Promise<boolean> {
		const cfg = this.cfg;
		return this.editLines(tasks, (line) => P.setDate(line, field, value, cfg));
	}

	/** Applies a date/time patch per task in one write per file (used by the calendar's drag, resize and keyboard moves). */
	applyPatches(items: { task: Task; patch: TaskPatch }[]): Promise<boolean> {
		const cfg = this.cfg;
		const byId = new Map(items.map((x) => [x.task.id, x.patch]));
		return this.editLines(
			items.map((x) => x.task),
			(line, task) => {
				const patch = byId.get(task.id);
				if (!patch) return line;
				let out = line;
				for (const [field, value] of Object.entries(patch.dates ?? {}) as [DateField, string | null][]) {
					out = P.setDate(out, field, value, cfg);
				}
				if (patch.time !== undefined) out = P.setTime(out, patch.time);
				return out;
			},
		);
	}

	setTime(tasks: Task[], time: TaskTime | null): Promise<boolean> {
		return this.editLines(tasks, (line) => P.setTime(line, time));
	}

	setRecurrence(tasks: Task[], rule: string | null): Promise<boolean> {
		const cfg = this.cfg;
		return this.editLines(tasks, (line) => P.setRecurrence(line, rule, cfg));
	}

	addTag(tasks: Task[], tag: string): Promise<boolean> {
		return this.editLines(tasks, (line) => P.addTag(line, tag));
	}

	removeTag(tasks: Task[], tag: string): Promise<boolean> {
		return this.editLines(tasks, (line) => P.removeTag(line, tag));
	}

	setTitle(task: Task, title: string): Promise<boolean> {
		return this.editLines([task], (line) => P.setTitle(line, title));
	}

	// ---- description, comments, subtasks ------------------------------------

	/**
	 * Replaces the task's description lines (indented non-task lines directly under it)
	 * while keeping subtasks untouched.
	 */
	setDescription(task: Task, text: string): Promise<boolean> {
		return this.editBlocks([task], (block) => {
			const childIndent = childIndentOf(block[0]);
			const childWidth = P.indentWidth(childIndent);
			const rest = block.slice(1);
			// Keep everything that belongs to subtasks: a subtask line and anything indented deeper than it.
			const kept: string[] = [];
			let subtaskWidth = -1;
			for (const l of rest) {
				const w = P.indentWidth(/^[ \t]*/.exec(l)![0]);
				const isTask = P.TASK_LINE.test(l);
				if (isTask && w >= childWidth) {
					subtaskWidth = w;
					kept.push(l);
				} else if (subtaskWidth >= 0 && w > subtaskWidth) {
					kept.push(l);
				} else {
					subtaskWidth = -1;
				}
			}
			const desc = text
				.split(/\r?\n/)
				.map((l) => l.trimEnd())
				.filter((l, i, arr) => l !== "" || (i > 0 && i < arr.length - 1))
				.map((l) => (l === "" ? "" : childIndent + l));
			return [block[0], ...desc, ...kept];
		});
	}

	addComment(task: Task, text: string): Promise<boolean> {
		const stamp = moment().format("YYYY-MM-DD HH:mm");
		return this.editBlocks([task], (block) => {
			const notesEnd = descriptionEnd(block);
			const line = `${childIndentOf(block[0])}- 💬 ${stamp} — ${text.trim()}`;
			return [...block.slice(0, notesEnd + 1), line, ...block.slice(notesEnd + 1)];
		});
	}

	addSubtask(parent: Task, title: string): Promise<boolean> {
		const cfg = this.cfg;
		const s = this.getSettings();
		return this.editBlocks([parent], (block) => {
			const line = P.buildTaskLine(
				{ title, indent: childIndentOf(block[0]), created: s.setCreatedDate ? today() : undefined },
				cfg,
			);
			return [...block, line];
		});
	}

	delete(tasks: Task[]): Promise<boolean> {
		return this.editBlocks(tasks, () => []);
	}

	// ---- creating & moving --------------------------------------------------

	async createTask(path: string, spec: P.NewTaskSpec): Promise<void> {
		const s = this.getSettings();
		const line = P.buildTaskLine({ ...spec, created: s.setCreatedDate ? today() : undefined }, this.cfg);
		await this.appendLines(path, [line]);
		new Notice(t("taskAdded", { path: path.replace(/\.md$/, "") }));
	}

	/** Moves tasks (with subtasks and notes) to the end of another note. Appends first, then deletes, so nothing is lost on failure. */
	async move(tasks: Task[], targetPath: string): Promise<void> {
		const ids = new Set(tasks.map((x) => x.id));
		const roots = tasks.filter((x) => x.path !== targetPath && !this.hasAncestorIn(x, ids));
		if (!roots.length) return;
		const blocks: string[] = [];
		for (const task of roots) {
			const file = this.app.vault.getAbstractFileByPath(task.path);
			if (!(file instanceof TFile)) continue;
			const lines = (await this.app.vault.read(file)).split(/\r?\n/);
			const idx = locate(lines, task);
			if (idx < 0) {
				new Notice(t("errTaskChanged"));
				await this.index.refreshFile(task.path);
				return;
			}
			blocks.push(...dedent(lines.slice(idx, P.blockEnd(lines, idx) + 1)));
		}
		await this.appendLines(targetPath, blocks);
		await this.delete(roots);
		new Notice(t("movedTo", { path: targetPath.replace(/\.md$/, "") }));
	}

	private async appendLines(path: string, newLines: string[]): Promise<void> {
		const normalized = normalizePath(path.endsWith(".md") ? path : `${path}.md`);
		let file = this.app.vault.getAbstractFileByPath(normalized);
		if (!file) {
			const folder = normalized.split("/").slice(0, -1).join("/");
			if (folder && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
			file = await this.app.vault.create(normalized, "");
		}
		if (!(file instanceof TFile)) return;
		await this.app.vault.process(file, (data) => {
			const eol = data.includes("\r\n") ? "\r\n" : "\n";
			const trimmed = data.replace(/\s+$/, "");
			return (trimmed ? trimmed + eol : "") + newLines.join(eol) + eol;
		});
		await this.index.refreshFile(file.path);
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Finds the task line: first at its recorded position, then the nearest identical line (the file may have shifted). */
function locate(lines: string[], task: Task): number {
	if (lines[task.line] === task.originalLine) return task.line;
	let best = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i] === task.originalLine && (best < 0 || Math.abs(i - task.line) < Math.abs(best - task.line))) best = i;
	}
	return best;
}

function childIndentOf(taskLine: string): string {
	const indent = /^[ \t]*/.exec(taskLine)![0];
	return indent + (indent.includes("\t") || indent === "" ? "\t" : "    ");
}

/** Index (within the block) of the last description line before the first subtask. */
function descriptionEnd(block: string[]): number {
	let end = 0;
	for (let i = 1; i < block.length; i++) {
		if (P.TASK_LINE.test(block[i])) break;
		end = i;
	}
	return end;
}

function dedent(block: string[]): string[] {
	const base = /^[ \t]*/.exec(block[0])![0];
	return block.map((l) => (l.startsWith(base) ? l.slice(base.length) : l.trimStart()));
}

function daysBetween(a: string, b: string): number {
	return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

function addDaysIso(iso: string, days: number): string {
	return moment(iso, "YYYY-MM-DD").add(days, "days").format("YYYY-MM-DD");
}

