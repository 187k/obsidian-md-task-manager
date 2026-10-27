import { setIcon } from "obsidian";
import { Priority, Task } from "../types";

/**
 * Status checkbox. Shape follows the status type (square for to-do/done, round for in progress,
 * a cross for cancelled), the border color follows priority, and a custom Lucide icon is drawn inside if configured.
 */
export function renderCheckbox(parent: HTMLElement, task: Task): HTMLElement {
	const box = parent.createDiv({
		cls: ["mtm-checkbox", `mtm-status-${task.status.type}`, `mtm-prio-${Priority[task.priority].toLowerCase()}`],
		attr: { role: "checkbox", "aria-checked": String(task.status.type === "done"), "aria-label": task.status.name },
	});
	if (task.status.icon) setIcon(box, task.status.icon);
	else if (task.status.type === "done") setIcon(box, "check");
	else if (task.status.type === "cancelled") setIcon(box, "x");
	return box;
}

/** Plain-text version of inline Markdown for list rows (links show their label, emphasis markers dropped). */
export function plainText(md: string): string {
	return md
		.replace(/!?\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
		.replace(/!?\[\[([^\]]+)\]\]/g, (_m, target: string) => target.split("#").pop() ?? target)
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/(\*\*|__|~~|==)(.+?)\1/g, "$2")
		.replace(/(^|[^*])\*([^*]+)\*/g, "$1$2")
		.replace(/`([^`]+)`/g, "$1");
}

function hash(s: string): number {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
	return Math.abs(h);
}

/** Stable color per tag / project name so the same tag always looks the same. */
export function colorFor(name: string): string {
	return `hsl(${hash(name.toLowerCase()) % 360}, 65%, 55%)`;
}
