import { App, FuzzySuggestModal, Modal, Setting } from "obsidian";
import { t } from "../i18n";
import { today } from "../parser/dates";
import { basename } from "../services/TaskIndex";

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
