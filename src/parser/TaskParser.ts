import {
	DateField,
	MetadataFormat,
	Priority,
	StatusDef,
	Task,
	TaskManagerSettings,
	TaskTime,
} from "../types";
import { formatTime, splitTime } from "./time";

/** Settings-derived lookup tables used by the parser and line editors. */
export interface ParserConfig {
	statuses: Map<string, StatusDef>;
	priorityByKeyword: Map<string, Priority>;
	keywordByPriority: Map<Priority, string>;
	globalFilter: string;
	format: MetadataFormat;
}

export function buildParserConfig(settings: TaskManagerSettings): ParserConfig {
	const statuses = new Map<string, StatusDef>();
	for (const s of settings.statuses) if (!statuses.has(s.symbol)) statuses.set(s.symbol, s);

	const priorityByKeyword = new Map<string, Priority>();
	const keywordByPriority = new Map<Priority, string>();
	for (const [level, words] of Object.entries(settings.priorityKeywords)) {
		const p = Number(level) as Priority;
		const list = words
			.split(",")
			.map((w) => w.trim().toLowerCase())
			.filter(Boolean);
		list.forEach((w) => priorityByKeyword.set(w, p));
		if (list.length) keywordByPriority.set(p, list[0]);
	}
	return {
		statuses,
		priorityByKeyword,
		keywordByPriority,
		globalFilter: settings.globalFilter.trim(),
		format: settings.metadataFormat,
	};
}

// ---------------------------------------------------------------------------
// Syntax tables
// ---------------------------------------------------------------------------

export const TASK_LINE = /^((?:[ \t]|>)*)([-*+]|\d+[.)])[ \t]+\[(.)\](?:[ \t]+(.*))?$/;
const LIST_LINE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t#]*$/;
const FENCE = /^[ \t]*(```|~~~)/;

const VS = "\\uFE0F?";

const PRIORITY_EMOJI: [string, Priority][] = [
	["🔺", Priority.Highest],
	["⏫", Priority.High],
	["🔼", Priority.Medium],
	["🔽", Priority.Low],
	["⏬", Priority.Lowest],
];

const DATE_EMOJI: Record<DateField, string[]> = {
	due: ["📅", "📆", "🗓"],
	scheduled: ["⏳", "⌛"],
	start: ["🛫"],
	created: ["➕"],
	done: ["✅"],
	cancelled: ["❌"],
};

/** Dataview field names accepted per date field; the first one is used when writing. */
const DATE_KEYS: Record<DateField, string[]> = {
	due: ["due"],
	scheduled: ["scheduled"],
	start: ["start"],
	created: ["created"],
	done: ["completion", "done", "completed"],
	cancelled: ["cancelled", "canceled"],
};

const RECUR_KEYS = ["repeat", "recurrence", "recurs"];

const ALL_EMOJI = [
	...PRIORITY_EMOJI.map(([e]) => e),
	...Object.values(DATE_EMOJI).flat(),
	"🔁",
	"🆔",
	"⛔",
	"🏁",
];

function esc(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const EMOJI_ALT = ALL_EMOJI.map(esc).join("|");
const DATE_RE = "(\\d{4}-\\d{2}-\\d{2})";

/** One metadata token. Used both to strip metadata from titles and to peel the trailing metadata block. */
const TOKEN_ALTS = [
	`(?:${Object.values(DATE_EMOJI).flat().map(esc).join("|")})${VS}[ \\t]*\\d{4}-\\d{2}-\\d{2}`,
	`(?:${PRIORITY_EMOJI.map(([e]) => esc(e)).join("|")})${VS}`,
	`🔁${VS}[ \\t]*[a-zA-Z0-9 ,!]+?(?=[ \\t]*(?:$|${EMOJI_ALT}|#|\\[|\\(|\\^))`,
	`(?:🆔|⛔|🏁)${VS}[ \\t]*[\\w,-]+`,
	`[\\[(][^\\[\\]()]*?::[^\\[\\]()]*[\\])]`,
	`[\\w-]+::[ \\t]*\\S+`,
	`#[^\\s#]+`,
	`\\^[\\w-]+`,
];

const TRAILING_TOKEN = new RegExp(`(?:^|[ \\t])(${TOKEN_ALTS.join("|")})[ \\t]*$`, "u");
const ANY_TOKEN = new RegExp(`(?:^|(?<=[ \\t]))(?:${TOKEN_ALTS.join("|")})`, "gu");

const TAG_RE = /(?:^|[ \t])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu;
const BLOCK_ID_RE = /[ \t]\^([\w-]+)[ \t]*$/;
const BRACKET_FIELD_RE = /[[(][ \t]*([\w-]+)[ \t]*::[ \t]*([^\])]*?)[ \t]*[\])]/g;
const BARE_FIELD_RE = /(?:^|[ \t])([\w-]+)::[ \t]*([^\s\])]+)/g;

export function indentWidth(indent: string): number {
	let w = 0;
	for (const ch of indent) w += ch === "\t" ? 4 : ch === " " ? 1 : 0;
	return w;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface InlineMeta {
	priority?: Priority;
	dates: Partial<Record<DateField, string>>;
	recurrence?: string;
}

function readFields(body: string, cfg: ParserConfig): InlineMeta {
	const meta: InlineMeta = { dates: {} };

	for (const [emoji, p] of PRIORITY_EMOJI) {
		if (body.includes(emoji)) {
			meta.priority = p;
			break;
		}
	}
	for (const [field, emojis] of Object.entries(DATE_EMOJI) as [DateField, string[]][]) {
		const re = new RegExp(`(?:${emojis.map(esc).join("|")})${VS}[ \\t]*${DATE_RE}`, "u");
		const m = re.exec(body);
		if (m) meta.dates[field] = m[1];
	}
	const recur = /🔁️?[ \t]*([a-zA-Z0-9 ,!]+?)(?=[ \t]*(?:$|[#[(^]|\p{Extended_Pictographic}))/u.exec(body);
	if (recur) meta.recurrence = recur[1].trim();

	const applyField = (key: string, value: string) => {
		const k = key.toLowerCase();
		const v = value.trim();
		if (k === "priority") {
			const p = cfg.priorityByKeyword.get(v.toLowerCase());
			if (p !== undefined) meta.priority = p;
			return;
		}
		if (RECUR_KEYS.includes(k)) {
			meta.recurrence = v;
			return;
		}
		for (const [field, keys] of Object.entries(DATE_KEYS) as [DateField, string[]][]) {
			if (keys.includes(k)) {
				const d = /^\d{4}-\d{2}-\d{2}/.exec(v);
				if (d) meta.dates[field] = d[0];
			}
		}
	};
	const withoutBrackets = body.replace(BRACKET_FIELD_RE, (_all, k: string, v: string) => {
		applyField(k, v);
		return " ";
	});
	for (const m of withoutBrackets.matchAll(BARE_FIELD_RE)) applyField(m[1], m[2]);
	return meta;
}

export function readTags(body: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const m of body.matchAll(TAG_RE)) {
		const tag = m[1].replace(/\/+$/, "");
		if (tag && !seen.has(tag.toLowerCase())) {
			seen.add(tag.toLowerCase());
			out.push(tag);
		}
	}
	return out;
}

/** Display title: body without metadata tokens, tags and block id. */
export function titleOf(body: string): string {
	return body.replace(ANY_TOKEN, "").replace(/\s{2,}/g, " ").trim();
}

function resolveStatus(symbol: string, cfg: ParserConfig): StatusDef {
	return (
		cfg.statuses.get(symbol) ?? {
			symbol,
			name: symbol === " " ? "Todo" : symbol,
			type: symbol === "x" || symbol === "X" ? "done" : symbol === "-" ? "cancelled" : "todo",
			icon: "",
		}
	);
}

/** Parses a single line. Returns null when it is not a task. */
export function parseTaskLine(
	line: string,
	cfg: ParserConfig,
): Omit<Task, "id" | "path" | "line" | "headers" | "childIds" | "notes"> | null {
	const m = TASK_LINE.exec(line);
	if (!m) return null;
	if (cfg.globalFilter && !line.includes(cfg.globalFilter)) return null;
	const [, indent, listMarker, statusSymbol, rawBody] = m;
	const body = rawBody ?? "";
	const meta = readFields(body, cfg);
	const blockId = BLOCK_ID_RE.exec(" " + body)?.[1];
	const { time, rest } = splitTime(body);
	return {
		originalLine: line,
		indent,
		indentWidth: indentWidth(indent.replace(/.*>/, "")),
		listMarker,
		statusSymbol,
		status: resolveStatus(statusSymbol, cfg),
		body,
		title: titleOf(rest),
		tags: readTags(body),
		priority: meta.priority ?? Priority.Normal,
		dates: meta.dates,
		time,
		recurrence: meta.recurrence,
		blockId,
	};
}

/** Cheap pre-check so files without any checkbox are skipped. */
export function mayContainTasks(content: string): boolean {
	return /^(?:[ \t]|>)*(?:[-*+]|\d+[.)])[ \t]+\[.\]/m.test(content);
}

/** Parses every task in a file, including nesting, parent headings and description lines. */
export function parseFile(path: string, content: string, cfg: ParserConfig): Task[] {
	const lines = content.split(/\r?\n/);
	const tasks: Task[] = [];
	const headers: { level: number; text: string }[] = [];
	const stack: Task[] = [];
	let i = 0;

	if (lines[0] === "---") {
		for (i = 1; i < lines.length && lines[i] !== "---" && lines[i] !== "..."; i++);
		i++;
	}

	let inFence = false;
	for (; i < lines.length; i++) {
		const line = lines[i];
		if (FENCE.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;

		const h = HEADING.exec(line);
		if (h) {
			const level = h[1].length;
			while (headers.length && headers[headers.length - 1].level >= level) headers.pop();
			headers.push({ level, text: h[2] });
			stack.length = 0;
			continue;
		}
		if (line.trim() === "") continue;

		const parsed = parseTaskLine(line, cfg);
		const width = parsed ? parsed.indentWidth : indentWidth(/^[ \t]*/.exec(line)![0]);
		while (stack.length && stack[stack.length - 1].indentWidth >= width) stack.pop();

		if (parsed) {
			const parent = stack[stack.length - 1];
			const task: Task = {
				...parsed,
				id: `${path}:${i}`,
				path,
				line: i,
				headers: headers.map((x) => x.text),
				parentId: parent?.id,
				childIds: [],
				notes: [],
			};
			parent?.childIds.push(task.id);
			tasks.push(task);
			stack.push(task);
		} else if (stack.length) {
			stack[stack.length - 1].notes.push(line.trim());
		} else if (!LIST_LINE.test(line)) {
			stack.length = 0;
		}
	}
	return tasks;
}

/**
 * Index of the last line belonging to the task at `start`
 * (subtasks and indented notes), excluding trailing blank lines.
 */
export function blockEnd(lines: string[], start: number): number {
	const m = TASK_LINE.exec(lines[start]);
	const base = m ? indentWidth(m[1].replace(/.*>/, "")) : 0;
	let end = start;
	for (let i = start + 1; i < lines.length; i++) {
		const l = lines[i];
		if (l.trim() === "") continue;
		const w = indentWidth(/^[ \t]*/.exec(l)![0]);
		if (w <= base || HEADING.test(l)) break;
		end = i;
	}
	return end;
}

// ---------------------------------------------------------------------------
// Writing — targeted edits that keep everything else on the line intact
// ---------------------------------------------------------------------------

function splitLine(line: string): { prefix: string; body: string } | null {
	const m = /^((?:[ \t]|>)*(?:[-*+]|\d+[.)])[ \t]+\[.\])(?:[ \t]+(.*))?$/.exec(line);
	if (!m) return null;
	return { prefix: m[1], body: m[2] ?? "" };
}

function join(prefix: string, body: string): string {
	const b = body.replace(/[ \t]{2,}/g, " ").trim();
	return b ? `${prefix} ${b}` : `${prefix} `;
}

/** Appends a metadata token, keeping a trailing block id (^abc) last. */
function appendToken(body: string, token: string): string {
	const m = BLOCK_ID_RE.exec(" " + body);
	if (m) {
		const idx = body.length - (m[0].length - 1);
		return `${body.slice(0, idx).trimEnd()} ${token} ${body.slice(idx).trim()}`;
	}
	return `${body.trimEnd()} ${token}`;
}

export function setStatusSymbol(line: string, symbol: string): string {
	return line.replace(/^((?:[ \t]|>)*(?:[-*+]|\d+[.)])[ \t]+\[).(\])/, `$1${symbol}$2`);
}

function removePriority(body: string): string {
	let b = body;
	for (const [e] of PRIORITY_EMOJI) b = b.replace(new RegExp(`[ \\t]*${esc(e)}${VS}`, "gu"), "");
	b = b.replace(/[ \t]*[[(][ \t]*priority[ \t]*::[^\])]*[\])]/gi, "");
	b = b.replace(/(^|[ \t])priority::[ \t]*[^\s\])]+/gi, "$1");
	return b;
}

export function setPriority(line: string, p: Priority, cfg: ParserConfig): string {
	const parts = splitLine(line);
	if (!parts) return line;
	let body = removePriority(parts.body);
	if (p !== Priority.Normal) {
		if (cfg.format === "dataview") {
			body = appendToken(body, `[priority:: ${cfg.keywordByPriority.get(p) ?? Priority[p].toLowerCase()}]`);
		} else {
			const emoji = PRIORITY_EMOJI.find(([, v]) => v === p)?.[0];
			if (emoji) body = appendToken(body, emoji);
		}
	}
	return join(parts.prefix, body);
}

function removeDate(body: string, field: DateField): string {
	let b = body;
	for (const e of DATE_EMOJI[field]) b = b.replace(new RegExp(`[ \\t]*${esc(e)}${VS}[ \\t]*\\d{4}-\\d{2}-\\d{2}`, "gu"), "");
	for (const k of DATE_KEYS[field]) {
		b = b.replace(new RegExp(`[ \\t]*[[(][ \\t]*${k}[ \\t]*::[^\\])]*[\\])]`, "gi"), "");
		b = b.replace(new RegExp(`(^|[ \\t])${k}::[ \\t]*[^\\s\\])]+`, "gi"), "$1");
	}
	return b;
}

export function setDate(line: string, field: DateField, value: string | null, cfg: ParserConfig): string {
	const parts = splitLine(line);
	if (!parts) return line;
	let body = removeDate(parts.body, field);
	if (value) {
		body =
			cfg.format === "dataview"
				? appendToken(body, `[${DATE_KEYS[field][0]}:: ${value}]`)
				: appendToken(body, `${DATE_EMOJI[field][0]} ${value}`);
	}
	return join(parts.prefix, body);
}

export function setRecurrence(line: string, rule: string | null, cfg: ParserConfig): string {
	const parts = splitLine(line);
	if (!parts) return line;
	let body = parts.body
		.replace(new RegExp(`[ \\t]*🔁${VS}[ \\t]*[a-zA-Z0-9 ,!]+?(?=[ \\t]*(?:$|${EMOJI_ALT}|#|\\[|\\(|\\^))`, "u"), "")
		.replace(/[ \t]*[[(][ \t]*(?:repeat|recurrence|recurs)[ \t]*::[^\])]*[\])]/gi, "");
	if (rule && rule.trim()) {
		body = cfg.format === "dataview" ? appendToken(body, `[repeat:: ${rule.trim()}]`) : appendToken(body, `🔁 ${rule.trim()}`);
	}
	return join(parts.prefix, body);
}

export function normalizeTag(tag: string): string {
	return tag.trim().replace(/^#+/, "").replace(/\s+/g, "-");
}

export function addTag(line: string, tag: string): string {
	const parts = splitLine(line);
	const clean = normalizeTag(tag);
	if (!parts || !clean) return line;
	if (readTags(parts.body).some((t) => t.toLowerCase() === clean.toLowerCase())) return line;
	return join(parts.prefix, appendToken(parts.body, `#${clean}`));
}

export function removeTag(line: string, tag: string): string {
	const parts = splitLine(line);
	if (!parts) return line;
	const re = new RegExp(`(^|[ \\t])#${esc(normalizeTag(tag))}(?=$|[\\s#,.;:!?)\\]])`, "giu");
	return join(parts.prefix, parts.body.replace(re, "$1"));
}

/**
 * Replaces the human-readable part of the task, keeping every metadata token.
 * Tags or fields that sat in the middle of the old text are moved to the end.
 */
export function setTitle(line: string, newTitle: string): string {
	const parts = splitLine(line);
	if (!parts) return line;
	const { time, rest } = splitTime(parts.body);
	let desc = rest;
	let suffix = "";
	for (;;) {
		const m = TRAILING_TOKEN.exec(desc);
		if (!m || m[1].length === 0) break;
		const start = desc.length - m[0].length;
		suffix = desc.slice(start).trim() + (suffix ? " " + suffix : "");
		desc = desc.slice(0, start);
	}
	const midTokens = (desc.match(ANY_TOKEN) ?? []).filter((tok) => !newTitle.includes(tok));
	const body = [time ? formatTime(time) : "", newTitle.trim(), ...midTokens, suffix].filter(Boolean).join(" ");
	return join(parts.prefix, body);
}

/** Sets or removes the leading time ("10:00" / "10:00 - 11:30"). */
export function setTime(line: string, time: TaskTime | null): string {
	const parts = splitLine(line);
	if (!parts) return line;
	const { rest } = splitTime(parts.body);
	return join(parts.prefix, time ? `${formatTime(time)} ${rest}` : rest);
}

export interface NewTaskSpec {
	title: string;
	indent?: string;
	tags?: string[];
	priority?: Priority;
	due?: string;
	start?: string;
	time?: TaskTime;
	created?: string;
}

export function buildTaskLine(spec: NewTaskSpec, cfg: ParserConfig): string {
	const time = spec.time ? `${formatTime(spec.time)} ` : "";
	let line = `${spec.indent ?? ""}- [ ] ${time}${spec.title.trim()}`;
	for (const tag of spec.tags ?? []) line = addTag(line, tag);
	if (spec.priority !== undefined && spec.priority !== Priority.Normal) line = setPriority(line, spec.priority, cfg);
	if (spec.created) line = setDate(line, "created", spec.created, cfg);
	if (spec.start) line = setDate(line, "start", spec.start, cfg);
	if (spec.due) line = setDate(line, "due", spec.due, cfg);
	return line;
}
