import { Priority, TaskTime } from "../types";
import { parseDateWord } from "./dates";
import { parseTimeWord } from "./time";
import { NewTaskSpec, ParserConfig } from "./TaskParser";

const NUMERIC_PRIORITY: Record<string, Priority> = {
	"1": Priority.Highest,
	"2": Priority.High,
	"3": Priority.Medium,
	"4": Priority.Low,
	"5": Priority.Lowest,
};

/**
 * Todoist-style quick add:
 *   "Write report #work/dev !high tomorrow"  →  title "Write report", tag, priority, due date.
 * Recognised tokens: #tag, !keyword or !1–!5, one date word (today, tomorrow, mon…sun,
 * сегодня, завтра, пн…вс, or YYYY-MM-DD) and one time (10:00 or 10:00-11:30).
 * Everything else stays in the title.
 */
export function parseQuickAdd(text: string, cfg: ParserConfig): NewTaskSpec {
	const tags: string[] = [];
	let priority: Priority | undefined;
	let due: string | undefined;
	let time: TaskTime | undefined;
	const rest: string[] = [];

	for (const word of text.trim().split(/\s+/)) {
		if (/^#[^\s#]+$/.test(word)) {
			tags.push(word.slice(1));
			continue;
		}
		if (word.startsWith("!") && word.length > 1) {
			const key = word.slice(1).toLowerCase();
			const p = NUMERIC_PRIORITY[key] ?? cfg.priorityByKeyword.get(key);
			if (p !== undefined) {
				priority = p;
				continue;
			}
		}
		if (!due) {
			const d = parseDateWord(word);
			if (d) {
				due = d;
				continue;
			}
		}
		if (!time) {
			const tm = parseTimeWord(word);
			if (tm) {
				time = tm;
				continue;
			}
		}
		rest.push(word);
	}
	const spec: NewTaskSpec = { title: rest.join(" "), tags, priority, due };
	if (time) spec.time = time;
	return spec;
}
