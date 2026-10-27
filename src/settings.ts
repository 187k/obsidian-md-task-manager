import { App, PluginSettingTab, Setting, setIcon } from "obsidian";
import { t } from "./i18n";
import type TaskManagerPlugin from "./main";
import { Priority, PRIORITIES_DESC, StatusDef, StatusType, TaskManagerSettings } from "./types";

export const DEFAULT_STATUSES: StatusDef[] = [
	{ symbol: " ", name: "To do", type: "todo", icon: "" },
	{ symbol: "/", name: "In progress", type: "in_progress", icon: "" },
	{ symbol: "?", name: "Review", type: "in_progress", icon: "eye" },
	{ symbol: "!", name: "Important", type: "todo", icon: "alert-circle" },
	{ symbol: ">", name: "Rescheduled", type: "todo", icon: "corner-up-right" },
	{ symbol: "x", name: "Done", type: "done", icon: "" },
	{ symbol: "X", name: "Done", type: "done", icon: "" },
	{ symbol: "-", name: "Cancelled", type: "cancelled", icon: "" },
];

export const DEFAULT_SETTINGS: TaskManagerSettings = {
	language: "auto",
	inboxPath: "Inbox.md",
	untaggedIsInbox: false,
	projectFolders: [],
	projectTag: "project",
	excludeFolders: [".trash"],
	globalFilter: "",
	metadataFormat: "tasks",
	setDoneDate: true,
	setCreatedDate: false,
	dateDisplayFormat: "ddd D MMM",
	priorityKeywords: {
		[Priority.Highest]: "highest, urgent, критический",
		[Priority.High]: "high, h, высокий",
		[Priority.Medium]: "medium, med, m, средний",
		[Priority.Normal]: "normal, none, обычный",
		[Priority.Low]: "low, l, низкий",
		[Priority.Lowest]: "lowest, минимальный",
	},
	statuses: DEFAULT_STATUSES,
	pinnedTags: [],
	navPrefs: {},
	showSidebar: true,
	showDetails: true,
	viewMode: "list",
	calendarView: "month",
	weekStart: 1,
	defaultDuration: 60,
	calendarShowCompleted: true,
};

const splitList = (v: string) =>
	v
		.split(",")
		.map((x) => x.trim())
		.filter(Boolean);

export class TaskManagerSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: TaskManagerPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		containerEl.empty();

		// ---- General ----
		new Setting(containerEl).setName(t("s_general")).setHeading();

		new Setting(containerEl)
			.setName(t("s_language"))
			.setDesc(t("s_languageDesc"))
			.addDropdown((d) =>
				d
					.addOptions({ auto: "Auto", en: "English", ru: "Русский" })
					.setValue(s.language)
					.onChange(async (v) => {
						s.language = v as TaskManagerSettings["language"];
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		new Setting(containerEl)
			.setName(t("s_inboxPath"))
			.setDesc(t("s_inboxPathDesc"))
			.addText((x) =>
				x
					.setPlaceholder("Inbox.md")
					.setValue(s.inboxPath)
					.onChange(async (v) => {
						const p = v.trim() || "Inbox.md";
						s.inboxPath = p.endsWith(".md") ? p : `${p}.md`;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(t("s_untaggedInbox"))
			.setDesc(t("s_untaggedInboxDesc"))
			.addToggle((x) =>
				x.setValue(s.untaggedIsInbox).onChange(async (v) => {
					s.untaggedIsInbox = v;
					await this.plugin.saveSettings();
				}),
			);

		this.listSetting(t("s_projectFolders"), t("s_projectFoldersDesc"), "02 - Projects", s.projectFolders, (v) => (s.projectFolders = v), true);

		new Setting(containerEl)
			.setName(t("s_projectTag"))
			.setDesc(t("s_projectTagDesc"))
			.addText((x) =>
				x
					.setPlaceholder("project")
					.setValue(s.projectTag)
					.onChange(async (v) => {
						s.projectTag = v.trim();
						await this.plugin.saveSettings(true);
					}),
			);

		this.listSetting(t("s_exclude"), t("s_excludeDesc"), "Templates, Archive", s.excludeFolders, (v) => (s.excludeFolders = v), true);

		new Setting(containerEl)
			.setName(t("s_globalFilter"))
			.setDesc(t("s_globalFilterDesc"))
			.addText((x) =>
				x.setValue(s.globalFilter).onChange(async (v) => {
					s.globalFilter = v.trim();
					await this.plugin.saveSettings(true);
				}),
			);

		this.listSetting(t("s_pinned"), t("s_pinnedDesc"), "work/dev, personal", s.pinnedTags, (v) => (s.pinnedTags = v.map((x) => x.replace(/^#/, ""))), false);

		// ---- Metadata ----
		new Setting(containerEl).setName(t("s_metadata")).setHeading();

		new Setting(containerEl)
			.setName(t("s_format"))
			.setDesc(t("s_formatDesc"))
			.addDropdown((d) =>
				d
					.addOptions({ tasks: t("s_formatTasks"), dataview: t("s_formatDataview") })
					.setValue(s.metadataFormat)
					.onChange(async (v) => {
						s.metadataFormat = v as TaskManagerSettings["metadataFormat"];
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(t("s_doneDate"))
			.setDesc(t("s_doneDateDesc"))
			.addToggle((x) =>
				x.setValue(s.setDoneDate).onChange(async (v) => {
					s.setDoneDate = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName(t("s_createdDate"))
			.setDesc(t("s_createdDateDesc"))
			.addToggle((x) =>
				x.setValue(s.setCreatedDate).onChange(async (v) => {
					s.setCreatedDate = v;
					await this.plugin.saveSettings();
				}),
			);

		const fmt = new Setting(containerEl).setName(t("s_dateFormat"));
		const preview = createSpan({ cls: "mtm-setting-preview" });
		const updatePreview = () => preview.setText(" → " + window.moment().format(s.dateDisplayFormat));
		fmt.setDesc(createFragment((f) => {
			f.appendText(t("s_dateFormatDesc"));
			f.append(preview);
		}));
		updatePreview();
		fmt.addMomentFormat((m) =>
			m
				.setDefaultFormat("ddd D MMM")
				.setValue(s.dateDisplayFormat)
				.onChange(async (v) => {
					s.dateDisplayFormat = v || "ddd D MMM";
					updatePreview();
					await this.plugin.saveSettings();
				}),
		);

		new Setting(containerEl).setName(t("s_priorityKeywords")).setDesc(t("s_priorityKeywordsDesc"));
		for (const p of PRIORITIES_DESC) {
			new Setting(containerEl)
				.setClass("mtm-setting-indent")
				.setName(t(`prio_${p}` as "prio_0"))
				.addText((x) =>
					x.setValue(s.priorityKeywords[p] ?? "").onChange(async (v) => {
						s.priorityKeywords[p] = v;
						await this.plugin.saveSettings(true);
					}),
				);
		}

		// ---- Calendar ----
		new Setting(containerEl).setName(t("s_calendar")).setHeading();

		new Setting(containerEl).setName(t("s_weekStart")).addDropdown((d) =>
			d
				.addOptions({ "1": t("monday"), "0": t("sunday") })
				.setValue(String(s.weekStart))
				.onChange(async (v) => {
					s.weekStart = v === "0" ? 0 : 1;
					await this.plugin.saveSettings();
				}),
		);

		new Setting(containerEl)
			.setName(t("s_defaultDuration"))
			.setDesc(t("s_defaultDurationDesc"))
			.addText((x) =>
				x
					.setPlaceholder("60")
					.setValue(String(s.defaultDuration))
					.onChange(async (v) => {
						const n = parseInt(v, 10);
						if (n >= 15 && n <= 24 * 60) {
							s.defaultDuration = n;
							await this.plugin.saveSettings();
						}
					}),
			);

		// ---- Statuses ----
		new Setting(containerEl).setName(t("s_statuses")).setHeading().setDesc(t("s_statusesDesc"));
		this.renderStatuses(containerEl);
	}

	private listSetting(
		name: string,
		desc: string,
		placeholder: string,
		value: string[],
		set: (v: string[]) => void,
		reindex: boolean,
	): void {
		new Setting(this.containerEl)
			.setName(name)
			.setDesc(desc)
			.addText((x) =>
				x
					.setPlaceholder(placeholder)
					.setValue(value.join(", "))
					.onChange(async (v) => {
						set(splitList(v));
						await this.plugin.saveSettings(reindex);
					}),
			);
	}

	private renderStatuses(containerEl: HTMLElement): void {
		const s = this.plugin.settings;
		const wrap = containerEl.createDiv({ cls: "mtm-status-table" });
		const head = wrap.createDiv({ cls: "mtm-status-row mtm-status-head" });
		for (const k of ["s_symbol", "s_name", "s_type", "s_icon"] as const) head.createSpan({ text: t(k) });
		head.createSpan();

		s.statuses.forEach((status, i) => {
			const row = wrap.createDiv({ cls: "mtm-status-row" });
			const save = () => this.plugin.saveSettings(true);

			const sym = row.createEl("input", { type: "text", value: status.symbol, cls: "mtm-status-symbol" });
			sym.maxLength = 1;
			sym.addEventListener("change", async () => {
				status.symbol = sym.value.length ? sym.value[0] : " ";
				await save();
			});

			const name = row.createEl("input", { type: "text", value: status.name });
			name.addEventListener("change", async () => {
				status.name = name.value;
				await save();
			});

			const type = row.createEl("select", { cls: "dropdown" });
			for (const ty of ["todo", "in_progress", "done", "cancelled"] as StatusType[]) {
				type.createEl("option", { value: ty, text: t(`type_${ty}`) });
			}
			type.value = status.type;
			type.addEventListener("change", async () => {
				status.type = type.value as StatusType;
				await save();
			});

			const iconCell = row.createDiv({ cls: "mtm-status-icon-cell" });
			const icon = iconCell.createEl("input", { type: "text", value: status.icon, placeholder: "lucide id" });
			const iconPreview = iconCell.createSpan({ cls: "mtm-status-icon-preview" });
			const showIcon = () => {
				iconPreview.empty();
				if (status.icon) setIcon(iconPreview, status.icon);
			};
			showIcon();
			icon.addEventListener("change", async () => {
				status.icon = icon.value.trim();
				showIcon();
				await save();
			});

			const del = row.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Delete" } });
			setIcon(del, "trash-2");
			del.addEventListener("click", async () => {
				s.statuses.splice(i, 1);
				await save();
				this.display();
			});
		});

		new Setting(containerEl)
			.addButton((b) =>
				b.setButtonText(t("s_addStatus")).onClick(async () => {
					s.statuses.push({ symbol: "", name: "", type: "todo", icon: "" });
					await this.plugin.saveSettings();
					this.display();
				}),
			)
			.addButton((b) =>
				b
					.setButtonText(t("s_resetStatuses"))
					.setWarning()
					.onClick(async () => {
						s.statuses = DEFAULT_STATUSES.map((x) => ({ ...x }));
						await this.plugin.saveSettings(true);
						this.display();
					}),
			);
	}
}
