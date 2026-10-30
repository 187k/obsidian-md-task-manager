/** Priority levels, ordered so that a higher number means more urgent. */
export enum Priority {
	Lowest = 0,
	Low = 1,
	Normal = 2,
	Medium = 3,
	High = 4,
	Highest = 5,
}

export const PRIORITIES_DESC: Priority[] = [
	Priority.Highest,
	Priority.High,
	Priority.Medium,
	Priority.Normal,
	Priority.Low,
	Priority.Lowest,
];

export type StatusType = "todo" | "in_progress" | "done" | "cancelled";

export interface StatusDef {
	/** Character inside the checkbox brackets, e.g. " ", "x", "/". */
	symbol: string;
	name: string;
	type: StatusType;
	/** Optional Lucide icon id shown inside the checkbox (e.g. "eye", "help-circle"). */
	icon: string;
}

export type DateField = "due" | "scheduled" | "start" | "created" | "done" | "cancelled";

export const DATE_FIELDS: DateField[] = ["due", "scheduled", "start", "created", "done", "cancelled"];

/** Time of day, "HH:mm". `end` is optional; without it the calendar uses the default duration. */
export interface TaskTime {
	start: string;
	end?: string;
}

/** A partial change to a task's dates/time. `null` removes the value. */
export interface TaskPatch {
	dates?: Partial<Record<DateField, string | null>>;
	time?: TaskTime | null;
}

export interface Task {
	/** `${path}:${line}` — stable until lines above the task change. */
	id: string;
	path: string;
	/** 0-based line number in the file. */
	line: number;
	/** The exact line as read from disk. Writes are refused if the file no longer contains it. */
	originalLine: string;
	indent: string;
	/** Indent width (tabs count as 4). */
	indentWidth: number;
	listMarker: string;
	statusSymbol: string;
	status: StatusDef;
	/** Everything after the checkbox. */
	body: string;
	/** Human-readable title: body without metadata, tags and block id. */
	title: string;
	tags: string[];
	priority: Priority;
	dates: Partial<Record<DateField, string>>;
	/** Leading "10:00" / "10:00 - 11:30" in the task text. */
	time?: TaskTime;
	recurrence?: string;
	blockId?: string;
	/** Heading chain above the task, outermost first. */
	headers: string[];
	parentId?: string;
	childIds: string[];
	/** Indented non-task lines directly under the task (description / comments), trimmed of list markers. */
	notes: string[];
}

export type MetadataFormat = "tasks" | "dataview";

export type GroupBy = "none" | "date" | "priority" | "status" | "file" | "project" | "tag";
export type SortBy = "smart" | "due" | "priority" | "title" | "file";

export interface NavPrefs {
	groupBy: GroupBy;
	sortBy: SortBy;
	showCompleted: boolean;
}

/** Which tasks the "Home" list shows. */
export type HomeDateScope = "any" | "today" | "week" | "dated" | "undated";

export interface HomeQuery {
	dateScope: HomeDateScope;
	/** Project note paths; empty = tasks from anywhere. */
	projects: string[];
	/** Tags (without #); empty = any tag or none. */
	tags: string[];
	/** Only tasks with at least this priority. */
	minPriority: Priority;
	/** Also include inbox tasks when projects are restricted. */
	includeInbox: boolean;
}

/** Per-project appearance chosen by the user. */
export interface ProjectStyle {
	/** Lucide icon id. */
	icon?: string;
	/** Any CSS color. */
	color?: string;
}

export const SCALE_MIN = 0.7;
export const SCALE_MAX = 1.6;
export const SCALE_STEP = 0.1;

export type SmartList = "home" | "inbox" | "today" | "upcoming" | "all";
export const SMART_LISTS: SmartList[] = ["home", "inbox", "today", "upcoming", "all"];

export interface TaskManagerSettings {
	language: "auto" | "en" | "ru";
	inboxPath: string;
	/** When true, every open task without tags, date or project counts as inbox. */
	untaggedIsInbox: boolean;
	projectFolders: string[];
	/** A note whose frontmatter tags/type contain this value is a project. */
	projectTag: string;
	/** Notes added as projects by hand (paths), regardless of folder or tag. */
	manualProjects: string[];
	/** Notes removed from projects by hand (paths), even if a folder or tag rule matches. */
	hiddenProjects: string[];
	excludeFolders: string[];
	/** If set, only checkbox lines containing this string are tasks (like the Tasks plugin's global filter). */
	globalFilter: string;
	metadataFormat: MetadataFormat;
	setDoneDate: boolean;
	setCreatedDate: boolean;
	dateDisplayFormat: string;
	priorityKeywords: Record<string, string>;
	statuses: StatusDef[];
	pinnedTags: string[];
	navPrefs: Record<string, NavPrefs>;
	showSidebar: boolean;
	showDetails: boolean;
	/** Filter bar under the header. */
	showFilters: boolean;
	/** Pane widths in px, changed by dragging the dividers. */
	sidebarWidth: number;
	detailsWidth: number;
	/** Interface scale of the task manager, 1 = 100 %. */
	uiScale: number;
	/** List opened in a new task manager tab. */
	startScreen: SmartList;
	/** Smart lists hidden from the sidebar. */
	hiddenSmartLists: SmartList[];
	home: HomeQuery;
	/** Extra notes attached to a project (project path → note paths); their tasks show in the project. */
	projectNotes: Record<string, string[]>;
	projectStyles: Record<string, ProjectStyle>;
	/** Open the task manager when Obsidian starts. */
	openOnStartup: boolean;
	viewMode: ViewMode;
	calendarView: CalendarMode;
	/** 0 = Sunday, 1 = Monday. */
	weekStart: 0 | 1;
	/** Minutes a timed task without an end time occupies in the calendar. */
	defaultDuration: number;
	calendarShowCompleted: boolean;
}

export type ViewMode = "list" | "calendar";
export type CalendarMode = "month" | "week" | "day";

/** What the center pane is currently showing. */
export type NavTarget =
	| { kind: "home" }
	| { kind: "inbox" }
	| { kind: "today" }
	| { kind: "upcoming" }
	| { kind: "all" }
	| { kind: "tag"; tag: string }
	| { kind: "project"; path: string };

export function navKey(nav: NavTarget): string {
	switch (nav.kind) {
		case "tag":
			return `tag:${nav.tag}`;
		case "project":
			return `project:${nav.path}`;
		default:
			return nav.kind;
	}
}
