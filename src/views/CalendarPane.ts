import { moment, setIcon } from "obsidian";
import { t } from "../i18n";
import { ISO, today } from "../parser/dates";
import { parseQuickAdd } from "../parser/quickAdd";
import { buildParserConfig } from "../parser/TaskParser";
import { fromMinutes } from "../parser/time";
import {
	CalItem,
	DAY_MINUTES,
	dayOrder,
	diffDays,
	itemsInRange,
	layoutBars,
	layoutTimed,
	moveByDays,
	moveToTime,
	resizeDuration,
	resizeTimeStart,
	resizeEnd,
	resizeStart,
	shiftIso,
	shiftTime,
	snap,
	SNAP_MINUTES,
	toItem,
} from "../services/calendarModel";
import { applyFilter } from "../services/query";
import { CalendarMode, TaskPatch } from "../types";
import { confirmDelete } from "./menus";
import { QuickAddModal } from "./modals";
import { colorFor, plainText, projectColor, renderCheckbox } from "./render";
import type { TaskManagerView } from "./TaskManagerView";

const HOUR_PX = 48;
const PX_PER_MIN = HOUR_PX / 60;
const MONTH_MAX_PER_DAY = 6;
const DRAG_THRESHOLD = 4;
/** Month view: dragging a timed chip's edge by this many pixels changes its time by 15 minutes. */
const PX_PER_SNAP = 8;

type DragKind = "move" | "resize-start" | "resize-end" | "resize-bottom" | "time-start" | "time-end";
type Zone = "day" | "allday" | "timed";

interface DragState {
	kind: DragKind;
	item: CalItem;
	sourceEl: HTMLElement;
	/** Day under the pointer when the drag began (matters for multi-day bars). */
	originDate: string;
	/** Minutes between the block's top and the pointer, so a moved block doesn't jump. */
	grabOffsetMin: number;
	x0: number;
	y0: number;
	started: boolean;
	preview?: HTMLElement;
	lastTarget?: { date: string; zone: Zone; min: number };
}

/**
 * Calendar with month / week / day views (time blocking).
 *
 * Interaction model, as in the reference video:
 * - drag a task to another day, or into the hour grid to give it a time;
 * - drag the right/left edge of an all-day task to stretch it over several days (🛫 start … 📅 due);
 * - drag the bottom edge of a time block to change its duration;
 * - keyboard on the selected task: ←/→ day, ↑/↓ 15 minutes (a week in month view),
 *   Shift+←/→ stretch over days, Shift+↑/↓ change duration, Tab / Shift+Tab next/previous task of the day.
 * Every change is written to the task line; the index event re-renders the calendar.
 */
export class CalendarPane {
	anchor = today();
	filter = "";
	private drag: DragState | null = null;
	private queue: Promise<unknown> = Promise.resolve();
	private gridScroll: number | null = null;

	constructor(
		private view: TaskManagerView,
		private el: HTMLElement,
	) {
		el.tabIndex = 0;
		el.addEventListener("keydown", (e) => this.onKey(e));
		view.registerInterval(window.setInterval(() => this.updateNowLine(), 60_000));
	}

	private get settings() {
		return this.view.plugin.settings;
	}

	private get mode(): CalendarMode {
		return this.settings.calendarView;
	}

	// ---- navigation ---------------------------------------------------------

	async setMode(mode: CalendarMode, anchor?: string): Promise<void> {
		if (anchor) this.anchor = anchor;
		this.settings.calendarView = mode;
		await this.view.plugin.saveSettings();
		this.render();
	}

	private step(dir: number): void {
		const unit = this.mode === "month" ? "month" : this.mode === "week" ? "week" : "day";
		this.anchor = moment(this.anchor, ISO).add(dir, unit).format(ISO);
		this.render();
	}

	private weekStartOf(iso: string): string {
		const m = moment(iso, ISO);
		const offset = (m.day() - this.settings.weekStart + 7) % 7;
		return m.subtract(offset, "days").format(ISO);
	}

	private visibleDays(): string[] {
		if (this.mode === "day") return [this.anchor];
		if (this.mode === "week") {
			const start = this.weekStartOf(this.anchor);
			return Array.from({ length: 7 }, (_, i) => shiftIso(start, i));
		}
		const first = moment(this.anchor, ISO).startOf("month").format(ISO);
		const last = moment(this.anchor, ISO).endOf("month").format(ISO);
		const start = this.weekStartOf(first);
		const days: string[] = [];
		for (let d = start; d <= last || days.length % 7 !== 0; d = shiftIso(d, 1)) days.push(d);
		return days;
	}

	/** Brings a date into view (used after keyboard moves). */
	private reveal(date: string): void {
		const days = this.visibleDays();
		if (date < days[0] || date > days[days.length - 1]) this.anchor = date;
	}

	// ---- rendering ----------------------------------------------------------

	private pendingRender = false;

	render(): void {
		if (this.drag?.started) {
			this.pendingRender = true;
			return;
		}
		this.pendingRender = false;
		const scroller = this.el.querySelector<HTMLElement>(".mtm-cal-scroll");
		if (scroller) this.gridScroll = scroller.scrollTop;
		this.el.empty();
		this.el.toggleClass("mtm-cal-mode-month", this.mode === "month");
		this.renderToolbar();
		const body = this.el.createDiv({ cls: "mtm-cal-body" });
		const days = this.visibleDays();
		const tasks = applyFilter(this.view.plugin.index.all(), this.filter);
		const items = itemsInRange(
			tasks,
			days[0],
			days[days.length - 1],
			this.settings.defaultDuration,
			this.settings.calendarShowCompleted,
		);
		if (this.mode === "month") this.renderMonth(body, days, items);
		else this.renderTimeGrid(body, days, items);
	}

	private renderToolbar(): void {
		const bar = this.el.createDiv({ cls: "mtm-cal-toolbar" });
		const nav = bar.createDiv({ cls: "mtm-cal-nav" });
		const prev = nav.createDiv({ cls: "clickable-icon", attr: { "aria-label": t("previous") } });
		setIcon(prev, "chevron-left");
		prev.addEventListener("click", () => this.step(-1));
		nav.createDiv({ cls: "mtm-cal-title", text: this.title() });
		const next = nav.createDiv({ cls: "clickable-icon", attr: { "aria-label": t("next") } });
		setIcon(next, "chevron-right");
		next.addEventListener("click", () => this.step(1));

		bar.createDiv({ cls: "mtm-spacer" });

		const filter = bar.createEl("input", { type: "search", cls: "mtm-filter", attr: { placeholder: t("filterPlaceholder") } });
		filter.value = this.filter;
		filter.addEventListener("input", () => {
			this.filter = filter.value;
			const pos = filter.selectionStart;
			this.render();
			const again = this.el.querySelector<HTMLInputElement>(".mtm-cal-toolbar .mtm-filter");
			again?.focus();
			if (again && pos !== null) again.setSelectionRange(pos, pos);
		});

		const done = bar.createDiv({ cls: "clickable-icon", attr: { "aria-label": t("showCompleted") } });
		setIcon(done, "check-check");
		done.toggleClass("is-active", this.settings.calendarShowCompleted);
		done.addEventListener("click", async () => {
			this.settings.calendarShowCompleted = !this.settings.calendarShowCompleted;
			await this.view.plugin.saveSettings();
		});

		const todayBtn = bar.createEl("button", { cls: "mtm-cal-btn", text: t("today") });
		todayBtn.addEventListener("click", () => {
			this.anchor = today();
			this.render();
		});

		const seg = bar.createDiv({ cls: "mtm-cal-seg" });
		for (const m of ["day", "week", "month"] as CalendarMode[]) {
			const b = seg.createEl("button", { text: t(`cal_${m}`) });
			b.toggleClass("is-active", this.mode === m);
			b.addEventListener("click", () => void this.setMode(m));
		}

		const details = bar.createDiv({ cls: "clickable-icon mtm-icon-btn", attr: { "aria-label": t("toggleDetails") } });
		setIcon(details, "panel-right");
		details.addEventListener("click", () => void this.view.togglePane("details"));
	}

	private title(): string {
		const m = moment(this.anchor, ISO);
		if (this.mode === "month") return m.format("MMMM YYYY");
		if (this.mode === "day") return m.format("dddd, D MMMM YYYY");
		const days = this.visibleDays();
		const a = moment(days[0], ISO);
		const b = moment(days[6], ISO);
		return a.month() === b.month() ? `${a.format("D")} – ${b.format("D MMMM YYYY")}` : `${a.format("D MMM")} – ${b.format("D MMM YYYY")}`;
	}

	private renderMonth(body: HTMLElement, days: string[], items: CalItem[]): void {
		const month = moment(this.anchor, ISO).month();
		const now = today();
		const grid = body.createDiv({ cls: "mtm-cal-month" });

		const head = grid.createDiv({ cls: "mtm-cal-weekdays" });
		head.createDiv();
		for (let i = 0; i < 7; i++) head.createDiv({ text: moment(days[i], ISO).format("ddd") });

		for (let w = 0; w < days.length / 7; w++) {
			const week = days.slice(w * 7, w * 7 + 7);
			const { bars, lanes } = layoutBars(items, week);
			const row = grid.createDiv({ cls: "mtm-cal-week" });
			row.style.gridTemplateRows = `auto ${lanes ? `repeat(${lanes}, auto) ` : ""}1fr`;

			const wn = row.createDiv({ cls: "mtm-cal-weeknum", text: String(moment(week[0], ISO).isoWeek()) });
			wn.style.gridRow = "1 / -1";

			week.forEach((date, i) => {
				const col = String(i + 2);
				const cell = row.createDiv({ cls: "mtm-cal-cell", attr: { "data-date": date, "data-zone": "day" } });
				cell.style.gridColumn = col;
				cell.style.gridRow = "1 / -1";
				cell.toggleClass("is-today", date === now);
				cell.toggleClass("is-other-month", moment(date, ISO).month() !== month);
				cell.toggleClass("is-weekend", [0, 6].includes(moment(date, ISO).day()));
				cell.addEventListener("dblclick", () => this.createAt(date));

				const num = row.createDiv({ cls: "mtm-cal-daynum", text: moment(date, ISO).format("D") });
				num.style.gridColumn = col;
				num.style.gridRow = "1";
				num.toggleClass("is-today", date === now);
				num.addEventListener("click", () => void this.setMode("day", date));

				const list = row.createDiv({ cls: "mtm-cal-daylist" });
				list.style.gridColumn = col;
				list.style.gridRow = String(lanes + 2);
				const singles = dayOrder(items.filter((x) => !x.span && x.start === date));
				singles.slice(0, MONTH_MAX_PER_DAY).forEach((item) => this.renderChip(list, item, { zone: "day" }));
				if (singles.length > MONTH_MAX_PER_DAY) {
					const more = list.createDiv({ cls: "mtm-cal-more", text: t("moreTasks", { n: singles.length - MONTH_MAX_PER_DAY }) });
					more.addEventListener("click", () => void this.setMode("day", date));
				}
			});

			for (const b of bars) {
				const chip = this.renderChip(row, b.item, { zone: "day", bar: b });
				chip.style.gridColumn = `${b.from + 2} / ${b.to + 3}`;
				chip.style.gridRow = String(b.lane + 2);
			}
		}
	}

	private renderTimeGrid(body: HTMLElement, days: string[], items: CalItem[]): void {
		const now = today();
		const cols = `var(--mtm-cal-gutter) repeat(${days.length}, minmax(0, 1fr))`;
		const wrap = body.createDiv({ cls: "mtm-cal-timeview" });

		// day headers
		const head = wrap.createDiv({ cls: "mtm-cal-dayheads" });
		head.style.gridTemplateColumns = cols;
		head.createDiv();
		for (const date of days) {
			const h = head.createDiv({ cls: "mtm-cal-dayhead" });
			h.toggleClass("is-today", date === now);
			h.createSpan({ cls: "mtm-cal-dayhead-name", text: moment(date, ISO).format("ddd") });
			h.createSpan({ cls: "mtm-cal-dayhead-num", text: moment(date, ISO).format("D") });
			if (this.mode === "week") h.addEventListener("click", () => void this.setMode("day", date));
		}

		// all-day row: multi-day bars + tasks without a time
		const { bars, lanes } = layoutBars(items, days);
		const allday = wrap.createDiv({ cls: "mtm-cal-allday" });
		allday.style.gridTemplateColumns = cols;
		allday.style.gridTemplateRows = `${lanes ? `repeat(${lanes}, auto) ` : ""}auto`;
		const label = allday.createDiv({ cls: "mtm-cal-gutter-label", text: t("allDay") });
		label.style.gridRow = "1 / -1";
		days.forEach((date, i) => {
			const cell = allday.createDiv({ cls: "mtm-cal-cell", attr: { "data-date": date, "data-zone": "allday" } });
			cell.style.gridColumn = String(i + 2);
			cell.style.gridRow = "1 / -1";
			cell.toggleClass("is-today", date === now);
			cell.addEventListener("dblclick", () => this.createAt(date));
			const list = allday.createDiv({ cls: "mtm-cal-daylist" });
			list.style.gridColumn = String(i + 2);
			list.style.gridRow = String(lanes + 1);
			for (const item of dayOrder(items.filter((x) => !x.span && !x.timed && x.start === date))) {
				this.renderChip(list, item, { zone: "allday" });
			}
		});
		for (const b of bars) {
			const chip = this.renderChip(allday, b.item, { zone: "allday", bar: b });
			chip.style.gridColumn = `${b.from + 2} / ${b.to + 3}`;
			chip.style.gridRow = String(b.lane + 1);
		}

		// hour grid
		const scroll = wrap.createDiv({ cls: "mtm-cal-scroll" });
		const grid = scroll.createDiv({ cls: "mtm-cal-grid" });
		grid.style.gridTemplateColumns = cols;
		grid.style.height = `${24 * HOUR_PX}px`;
		const gutter = grid.createDiv({ cls: "mtm-cal-hours" });
		for (let h = 1; h < 24; h++) {
			const l = gutter.createDiv({ cls: "mtm-cal-hour", text: `${h < 10 ? "0" : ""}${h}:00` });
			l.style.top = `${h * HOUR_PX}px`;
		}
		for (const date of days) {
			const col = grid.createDiv({ cls: "mtm-cal-col", attr: { "data-date": date, "data-zone": "timed" } });
			col.style.backgroundSize = `100% ${HOUR_PX}px`;
			col.toggleClass("is-today", date === now);
			col.addEventListener("dblclick", (e) => {
				if (e.target !== col) return;
				const min = snap((e.clientY - col.getBoundingClientRect().top) / PX_PER_MIN - SNAP_MINUTES / 2);
				this.createAt(date, min);
			});
			for (const block of layoutTimed(items.filter((x) => x.timed && x.start === date))) {
				const el = this.renderChip(col, block.item, { zone: "timed" });
				el.style.top = `${block.item.startMin * PX_PER_MIN}px`;
				el.style.height = `${Math.max((block.item.endMin - block.item.startMin) * PX_PER_MIN, 18)}px`;
				el.style.left = `calc(${(block.col / block.cols) * 100}% + 1px)`;
				el.style.width = `calc(${100 / block.cols}% - 3px)`;
			}
			if (date === now) col.createDiv({ cls: "mtm-cal-now" });
		}
		this.updateNowLine();

		// Keep header columns aligned with the scrolling grid (which has a scrollbar).
		window.requestAnimationFrame(() => {
			const sb = scroll.offsetWidth - scroll.clientWidth;
			head.style.paddingRight = allday.style.paddingRight = `${sb}px`;
			if (this.gridScroll !== null) scroll.scrollTop = this.gridScroll;
			else {
				const nowMin = moment().hours() * 60 + moment().minutes();
				scroll.scrollTop = Math.max(0, (days.includes(now) ? nowMin - 120 : 7 * 60) * PX_PER_MIN);
			}
		});
	}

	private updateNowLine(): void {
		const line = this.el.querySelector<HTMLElement>(".mtm-cal-now");
		if (!line) return;
		const min = moment().hours() * 60 + moment().minutes();
		line.style.top = `${min * PX_PER_MIN}px`;
	}

	// ---- chips --------------------------------------------------------------

	private renderChip(
		parent: HTMLElement,
		item: CalItem,
		opts: { zone: Zone; bar?: { startsHere: boolean; endsHere: boolean } },
	): HTMLElement {
		const { task } = item;
		const open = task.status.type === "todo" || task.status.type === "in_progress";
		const chip = parent.createDiv({ cls: "mtm-cal-chip", attr: { "data-id": task.id } });
		chip.toggleClass("is-selected", this.view.selected.has(task.id));
		chip.toggleClass("is-closed", !open);
		chip.toggleClass("is-timed", opts.zone === "timed");
		chip.toggleClass("is-bar", !!opts.bar);
		chip.toggleClass("is-overdue", open && item.end < today());
		const project = this.view.plugin.index.projectOf(task.path);
		const color = task.tags[0] ? colorFor(task.tags[0]) : project ? projectColor(this.settings, project) : "";
		if (color) chip.style.setProperty("--mtm-chip-color", color);

		const bar = opts.bar;
		if (bar) {
			chip.toggleClass("is-continued-left", !bar.startsHere);
			chip.toggleClass("is-continued-right", !bar.endsHere);
		}
		// For a multi-day bar the checkbox sits where the task ends (on the due day), as in the video.
		const showBox = !bar || bar.endsHere;
		const box = showBox ? renderCheckbox(chip, task) : null;
		if (box) {
			if (bar) chip.addClass("has-end-box");
			box.addEventListener("pointerdown", (e) => e.stopPropagation());
			box.addEventListener("click", (e) => {
				e.stopPropagation();
				void this.view.plugin.writer.toggle([task]);
			});
		}
		const text = chip.createDiv({ cls: "mtm-cal-chip-text" });
		if (task.time) {
			// Single-day tasks show their full interval; multi-day bars only the start time.
			const label = item.timed ? `${fromMinutes(item.startMin)}–${fromMinutes(item.endMin)}` : task.time.start;
			text.createSpan({ cls: "mtm-cal-chip-time", text: label });
		}
		text.createSpan({ cls: "mtm-cal-chip-title", text: plainText(task.title) || "—" });
		chip.setAttr("aria-label", `${task.time ? task.time.start + " " : ""}${plainText(task.title)}\n${task.path}`);

		// resize handles
		if (opts.zone === "timed") {
			this.handle(chip, "mtm-cal-resize-bottom", "resize-bottom", item);
		} else if (item.timed) {
			// Month view / all-day row: the edges of a timed chip change its start / end time.
			chip.addClass("has-time-handles");
			this.handle(chip, "mtm-cal-resize-left mtm-cal-resize-time", "time-start", item);
			this.handle(chip, "mtm-cal-resize-right mtm-cal-resize-time", "time-end", item);
		} else {
			if (!bar || bar.endsHere) this.handle(chip, "mtm-cal-resize-right", "resize-end", item);
			if (bar?.startsHere) this.handle(chip, "mtm-cal-resize-left", "resize-start", item);
		}

		chip.addEventListener("pointerdown", (e) => this.beginDrag(e, "move", item, chip));
		chip.addEventListener("dblclick", (e) => {
			e.stopPropagation();
			void this.view.openTask(task);
		});
		chip.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			this.view.showContextMenu(task, e);
		});
		return chip;
	}

	private handle(chip: HTMLElement, cls: string, kind: DragKind, item: CalItem): void {
		const h = chip.createDiv({ cls: `mtm-cal-resize ${cls}` });
		h.addEventListener("pointerdown", (e) => {
			e.stopPropagation();
			this.beginDrag(e, kind, item, chip);
		});
	}

	// ---- drag & drop --------------------------------------------------------

	private targetAt(x: number, y: number): { date: string; zone: Zone; min: number } | null {
		for (const el of document.elementsFromPoint(x, y)) {
			if (!(el instanceof HTMLElement) || !el.dataset.zone || !this.el.contains(el)) continue;
			const zone = el.dataset.zone as Zone;
			const min = zone === "timed" ? (y - el.getBoundingClientRect().top) / PX_PER_MIN : 0;
			return { date: el.dataset.date!, zone, min };
		}
		return null;
	}

	private beginDrag(e: PointerEvent, kind: DragKind, item: CalItem, chip: HTMLElement): void {
		if (e.button !== 0) return;
		e.preventDefault();
		this.el.focus({ preventScroll: true });
		const rect = chip.getBoundingClientRect();
		this.drag = {
			kind,
			item,
			sourceEl: chip,
			originDate: this.targetAt(e.clientX, e.clientY)?.date ?? item.start,
			grabOffsetMin: chip.hasClass("is-timed") ? (e.clientY - rect.top) / PX_PER_MIN : 0,
			x0: e.clientX,
			y0: e.clientY,
			started: false,
		};
		const move = (ev: PointerEvent) => this.onDragMove(ev);
		const up = (ev: PointerEvent) => {
			document.removeEventListener("pointermove", move);
			document.removeEventListener("pointerup", up);
			document.removeEventListener("pointercancel", up);
			void this.onDragEnd(ev);
		};
		document.addEventListener("pointermove", move);
		document.addEventListener("pointerup", up);
		document.addEventListener("pointercancel", up);
	}

	private onDragMove(e: PointerEvent): void {
		const d = this.drag;
		if (!d) return;
		if (!d.started) {
			if (Math.abs(e.clientX - d.x0) + Math.abs(e.clientY - d.y0) < DRAG_THRESHOLD) return;
			d.started = true;
			d.sourceEl.addClass("is-dragging");
			this.el.addClass("is-dragging");
		}
		if (d.kind === "time-start" || d.kind === "time-end") {
			const { start, end } = this.timeDragRange(d, e.clientX);
			d.sourceEl.querySelector(".mtm-cal-chip-time")?.setText(`${fromMinutes(start)}–${fromMinutes(end)}`);
			d.sourceEl.setAttr("data-time-hint", `${fromMinutes(start)}–${fromMinutes(end)}`);
			return;
		}
		this.autoScroll(e.clientY);
		const target = this.targetAt(e.clientX, e.clientY);
		this.clearPreview();
		if (!target) return;
		d.lastTarget = target;

		if (d.kind === "resize-bottom") {
			const end = Math.max(d.item.startMin + SNAP_MINUTES, Math.min(DAY_MINUTES, snap(this.minInOwnColumn(d.sourceEl, e.clientY))));
			d.sourceEl.style.height = `${(end - d.item.startMin) * PX_PER_MIN}px`;
			const time = d.sourceEl.querySelector(".mtm-cal-chip-time");
			time?.setText(`${fromMinutes(d.item.startMin)}–${fromMinutes(end)}`);
			return;
		}
		if (d.kind === "move" && target.zone === "timed") {
			const duration = d.item.timed ? d.item.endMin - d.item.startMin : this.settings.defaultDuration;
			const start = Math.max(0, Math.min(DAY_MINUTES - SNAP_MINUTES, snap(target.min - d.grabOffsetMin)));
			const col = this.el.querySelector<HTMLElement>(`.mtm-cal-col[data-date="${target.date}"]`);
			if (!col) return;
			const p = col.createDiv({ cls: "mtm-cal-preview" });
			p.style.top = `${start * PX_PER_MIN}px`;
			p.style.height = `${Math.min(duration, DAY_MINUTES - start) * PX_PER_MIN}px`;
			p.setText(`${fromMinutes(start)}–${fromMinutes(Math.min(start + duration, DAY_MINUTES))}`);
			d.preview = p;
			return;
		}
		// Day-level targets: highlight the days the task will cover.
		let from = target.date;
		let to = target.date;
		if (d.kind === "move") {
			const delta = diffDays(d.originDate, target.date);
			from = shiftIso(d.item.start, delta);
			to = shiftIso(d.item.end, delta);
		} else if (d.kind === "resize-end") {
			from = d.item.start;
			to = target.date < d.item.start ? d.item.start : target.date;
		} else if (d.kind === "resize-start") {
			from = target.date > d.item.end ? d.item.end : target.date;
			to = d.item.end;
		}
		for (let day = from; day <= to; day = shiftIso(day, 1)) {
			this.el.querySelectorAll(`.mtm-cal-cell[data-date="${day}"][data-zone="${target.zone}"]`).forEach((c) => c.addClass("mtm-drop-hover"));
		}
	}

	/** Horizontal edge drag on a timed chip (month view): new start/end, snapped to 15 minutes. */
	private timeDragRange(d: DragState, clientX: number): { start: number; end: number } {
		const delta = Math.round((clientX - d.x0) / PX_PER_SNAP) * SNAP_MINUTES;
		const { startMin, endMin } = d.item;
		if (d.kind === "time-end") {
			return { start: startMin, end: Math.max(startMin + SNAP_MINUTES, Math.min(DAY_MINUTES, snap(endMin + delta))) };
		}
		return { start: Math.max(0, Math.min(endMin - SNAP_MINUTES, snap(startMin + delta))), end: endMin };
	}

	/** Minutes at `clientY` inside the hour column the dragged block lives in. */
	private minInOwnColumn(sourceEl: HTMLElement, clientY: number): number {
		const col = sourceEl.parentElement;
		return col ? (clientY - col.getBoundingClientRect().top) / PX_PER_MIN : 0;
	}

	private autoScroll(clientY: number): void {
		const scroll = this.el.querySelector<HTMLElement>(".mtm-cal-scroll");
		if (!scroll) return;
		const r = scroll.getBoundingClientRect();
		if (clientY < r.top + 30) scroll.scrollTop -= 12;
		else if (clientY > r.bottom - 30) scroll.scrollTop += 12;
	}

	private clearPreview(): void {
		this.drag?.preview?.remove();
		this.el.querySelectorAll(".mtm-drop-hover").forEach((c) => c.removeClass("mtm-drop-hover"));
	}

	private async onDragEnd(e: PointerEvent): Promise<void> {
		const d = this.drag;
		this.drag = null;
		if (!d) return;
		this.clearPreview();
		this.el.removeClass("is-dragging");
		d.sourceEl.removeClass("is-dragging");
		const { item } = d;

		if (!d.started) {
			this.view.select(item.task.id, e);
			if (this.pendingRender) this.render();
			return;
		}
		let patch: TaskPatch | null = null;
		const target = this.targetAt(e.clientX, e.clientY) ?? d.lastTarget;
		d.sourceEl.removeAttribute("data-time-hint");
		if (d.kind === "resize-bottom") {
			patch = resizeDuration(item, this.minInOwnColumn(d.sourceEl, e.clientY));
		} else if (d.kind === "time-start" || d.kind === "time-end") {
			const { start, end } = this.timeDragRange(d, e.clientX);
			patch = d.kind === "time-end" ? resizeDuration(item, end) : resizeTimeStart(item, start);
		} else if (target) {
			if (d.kind === "move" && target.zone === "timed") {
				patch = moveToTime(item, target.date, target.min - d.grabOffsetMin, this.settings.defaultDuration);
			} else if (d.kind === "move") {
				patch = moveByDays(item.task, diffDays(d.originDate, target.date));
				// Dragging a time block up into the all-day row removes its time.
				if (item.timed && target.zone === "allday") patch.time = null;
			} else if (d.kind === "resize-end") {
				patch = resizeEnd(item, target.date);
			} else if (d.kind === "resize-start") {
				patch = resizeStart(item, target.date);
			}
		}
		if (!patch || isEmpty(patch)) {
			this.render();
			return;
		}
		if (this.pendingRender) this.render();
		this.view.select(item.task.id);
		await this.view.plugin.writer.applyPatches([{ task: item.task, patch }]);
	}

	// ---- keyboard -----------------------------------------------------------

	private focusedItem(): CalItem | null {
		const id = this.view.focusId;
		const task = id ? this.view.plugin.index.get(id) : undefined;
		return task ? toItem(task, this.settings.defaultDuration) : null;
	}

	/** Queues an edit so fast key repeats apply one after another to the fresh task line. */
	private apply(taskId: string, make: (item: CalItem) => TaskPatch | null): void {
		this.queue = this.queue
			.then(async () => {
				const task = this.view.plugin.index.get(taskId);
				const item = task && toItem(task, this.settings.defaultDuration);
				if (!task || !item) return;
				const patch = make(item);
				if (!patch || isEmpty(patch)) return;
				await this.view.plugin.writer.applyPatches([{ task, patch }]);
				const after = this.view.plugin.index.get(taskId);
				const moved = after && toItem(after, this.settings.defaultDuration);
				if (moved) {
					this.reveal(moved.end);
					this.render();
				}
			})
			.catch((err) => console.error("[md-task-manager]", err));
	}

	private onKey(e: KeyboardEvent): void {
		const target = e.target as HTMLElement;
		if (target.matches("input, textarea, select")) return;
		const item = this.focusedItem();
		const timedView = this.mode !== "month";

		if (!item) {
			if (e.key === "ArrowLeft") this.step(-1);
			else if (e.key === "ArrowRight") this.step(1);
			else if (e.key === "t") {
				this.anchor = today();
				this.render();
			} else return;
			e.preventDefault();
			return;
		}

		const id = item.task.id;
		switch (e.key) {
			case "ArrowLeft":
			case "ArrowRight": {
				const dir = e.key === "ArrowRight" ? 1 : -1;
				if (e.shiftKey) this.apply(id, (it) => resizeEnd(it, shiftIso(it.end, dir)));
				else this.apply(id, (it) => moveByDays(it.task, dir));
				break;
			}
			case "ArrowUp":
			case "ArrowDown": {
				const dir = e.key === "ArrowDown" ? 1 : -1;
				if (!timedView && item.timed && e.shiftKey) {
					// Month view: Shift+↑/↓ changes the duration of a timed task.
					this.apply(id, (it) => resizeDuration(it, it.endMin + dir * SNAP_MINUTES));
				} else if (timedView && item.task.time && !item.span) {
					if (e.shiftKey) this.apply(id, (it) => resizeDuration(it, it.endMin + dir * SNAP_MINUTES));
					else this.apply(id, (it) => shiftTime(it, dir * SNAP_MINUTES));
				} else if (!e.shiftKey) {
					this.apply(id, (it) => moveByDays(it.task, dir * (timedView ? 1 : 7)));
				}
				break;
			}
			case "Tab": {
				const day = item.start;
				const all = itemsInRange(
					this.view.plugin.index.all(),
					day,
					day,
					this.settings.defaultDuration,
					this.settings.calendarShowCompleted,
				);
				const list = dayOrder(all.filter((x) => x.start === day || x.end === day));
				const i = list.findIndex((x) => x.task.id === id);
				const next = list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length];
				if (next) this.view.select(next.task.id);
				break;
			}
			case " ":
			case "x":
				void this.view.plugin.writer.toggle([item.task]);
				break;
			case "Enter":
				if (!this.settings.showDetails) void this.view.togglePane("details");
				break;
			case "Delete":
			case "Backspace":
				confirmDelete(this.view, [item.task]);
				break;
			case "Escape":
				this.view.clearSelection();
				break;
			default:
				return;
		}
		e.preventDefault();
	}

	// ---- creating -----------------------------------------------------------

	private createAt(date: string, startMin?: number): void {
		const label = moment(date, ISO).format("ddd D MMM") + (startMin !== undefined ? ` · ${fromMinutes(startMin)}` : "");
		new QuickAddModal(
			this.view.app,
			async (text) => {
				const { settings, writer } = this.view.plugin;
				const spec = parseQuickAdd(text, buildParserConfig(settings));
				if (!spec.title) return;
				spec.due ??= date;
				if (startMin !== undefined && !spec.time) {
					spec.time = { start: fromMinutes(startMin), end: fromMinutes(Math.min(startMin + settings.defaultDuration, DAY_MINUTES)) };
				}
				await writer.createTask(settings.inboxPath, spec);
			},
			`${t("quickAdd")} — ${label}`,
		).open();
	}
}

function isEmpty(p: TaskPatch): boolean {
	return Object.keys(p.dates ?? {}).length === 0 && p.time === undefined;
}

