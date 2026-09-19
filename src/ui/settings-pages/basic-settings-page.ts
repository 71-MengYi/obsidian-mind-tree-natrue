import { Setting } from "obsidian";
import { t } from "../../i18n";
import {
  MAX_FILE_BADGE_RULE_ENTRIES,
  normalizeFileBadgeAlias,
  normalizeFileBadgeExtension
} from "../resource-badges";
import type { SettingsPageObject, SettingsPagePort } from "./ports";

export class BasicSettingsPage implements SettingsPageObject {
  readonly element: HTMLElement;

  constructor(parent: HTMLElement, port: SettingsPagePort) {
    this.element = parent;
    parent.createEl("h3", { text: t("settings.tabs.basic") });
    new Setting(parent)
      .setName(t("settings.autosave.name"))
      .setDesc(t("settings.autosave.desc"))
      .addSlider((slider) => slider
        .setLimits(250, 2_000, 250)
        .setDynamicTooltip()
        .setValue(port.settings.autosaveDelayMs)
        .onChange(async (value) => {
          port.settings.autosaveDelayMs = value;
          await port.save();
        }));

    parent.createEl("h3", { text: t("settings.fileBadges.heading") });
    parent.createEl("p", { cls: "setting-item-description", text: t("settings.fileBadges.desc") });
    this.renderIgnoredExtensions(parent, port);
    this.renderExtensionAliases(parent, port);
  }

  private renderIgnoredExtensions(parent: HTMLElement, port: SettingsPagePort): void {
    const setting = new Setting(parent)
      .setName(t("settings.fileBadges.ignore.name"))
      .setDesc(t("settings.fileBadges.ignore.desc"));
    let rawExtension = "";
    let input: HTMLInputElement | undefined;
    setting.addText((text) => {
      input = text.inputEl;
      text.setPlaceholder(t("settings.fileBadges.extensionPlaceholder"))
        .onChange((value) => { rawExtension = value; hideError(); });
    });
    setting.addButton((button) => button
      .setButtonText(t("settings.fileBadges.add"))
      .onClick(() => void addExtension()));
    const error = setting.descEl.createDiv("mtn-setting-inline-error");
    const list = parent.createDiv("mtn-file-badge-rule-list");

    const hideError = (): void => {
      error.empty();
      error.removeClass("is-visible");
    };
    const showError = (message: string): void => {
      error.setText(message);
      error.addClass("is-visible");
    };
    const persist = async (): Promise<void> => {
      port.refreshOpenLayouts();
      await port.save();
    };
    const renderList = (): void => {
      list.empty();
      for (const extension of [...port.settings.ignoredFileBadgeExtensions].sort()) {
        const row = list.createDiv("mtn-file-badge-rule-row");
        row.createEl("code", { text: `.${extension}` });
        const remove = row.createEl("button", {
          text: t("settings.fileBadges.remove"),
          attr: { type: "button", "aria-label": t("settings.fileBadges.removeIgnore", { extension }) }
        });
        remove.addEventListener("click", () => {
          port.settings.ignoredFileBadgeExtensions = port.settings.ignoredFileBadgeExtensions
            .filter((candidate) => candidate !== extension);
          renderList();
          void persist();
        });
      }
    };
    const addExtension = async (): Promise<void> => {
      const extension = normalizeFileBadgeExtension(rawExtension);
      if (!extension) { showError(t("settings.fileBadges.invalidExtension")); return; }
      if (!port.settings.ignoredFileBadgeExtensions.includes(extension)) {
        if (port.settings.ignoredFileBadgeExtensions.length >= MAX_FILE_BADGE_RULE_ENTRIES) {
          showError(t("settings.fileBadges.tooManyRules"));
          return;
        }
        port.settings.ignoredFileBadgeExtensions = [...port.settings.ignoredFileBadgeExtensions, extension];
        renderList();
        await persist();
      }
      rawExtension = "";
      if (input) input.value = "";
      hideError();
    };
    input?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      void addExtension();
    });
    renderList();
  }

  private renderExtensionAliases(parent: HTMLElement, port: SettingsPagePort): void {
    const setting = new Setting(parent)
      .setName(t("settings.fileBadges.alias.name"))
      .setDesc(t("settings.fileBadges.alias.desc"));
    let rawExtension = "";
    let rawAlias = "";
    let extensionInput: HTMLInputElement | undefined;
    let aliasInput: HTMLInputElement | undefined;
    setting.addText((text) => {
      extensionInput = text.inputEl;
      text.setPlaceholder(t("settings.fileBadges.extensionPlaceholder"))
        .onChange((value) => { rawExtension = value; hideError(); });
    });
    setting.addText((text) => {
      aliasInput = text.inputEl;
      text.setPlaceholder(t("settings.fileBadges.aliasPlaceholder"))
        .onChange((value) => { rawAlias = value; hideError(); });
    });
    setting.addButton((button) => button
      .setButtonText(t("settings.fileBadges.addOrUpdate"))
      .onClick(() => void addAlias()));
    const error = setting.descEl.createDiv("mtn-setting-inline-error");
    const list = parent.createDiv("mtn-file-badge-rule-list");

    const hideError = (): void => {
      error.empty();
      error.removeClass("is-visible");
    };
    const showError = (message: string): void => {
      error.setText(message);
      error.addClass("is-visible");
    };
    const persist = async (): Promise<void> => {
      port.refreshOpenLayouts();
      await port.save();
    };
    const renderList = (): void => {
      list.empty();
      for (const [extension, alias] of Object.entries(port.settings.fileExtensionBadgeAliases)
        .sort(([left], [right]) => left.localeCompare(right))) {
        const row = list.createDiv("mtn-file-badge-rule-row");
        const value = row.createDiv("mtn-file-badge-rule-value");
        value.createEl("code", { text: `.${extension}` });
        value.createSpan({ text: "→" });
        value.createSpan({ text: alias });
        const remove = row.createEl("button", {
          text: t("settings.fileBadges.remove"),
          attr: { type: "button", "aria-label": t("settings.fileBadges.removeAlias", { extension }) }
        });
        remove.addEventListener("click", () => {
          const next: Record<string, string> = Object.create(null) as Record<string, string>;
          for (const [key, value] of Object.entries(port.settings.fileExtensionBadgeAliases)) {
            if (key !== extension) next[key] = value;
          }
          port.settings.fileExtensionBadgeAliases = next;
          renderList();
          void persist();
        });
      }
    };
    const addAlias = async (): Promise<void> => {
      const extension = normalizeFileBadgeExtension(rawExtension);
      if (!extension) { showError(t("settings.fileBadges.invalidExtension")); return; }
      const alias = normalizeFileBadgeAlias(rawAlias);
      if (!alias) { showError(t("settings.fileBadges.invalidAlias")); return; }
      const isNew = port.settings.fileExtensionBadgeAliases[extension] === undefined;
      if (isNew && Object.keys(port.settings.fileExtensionBadgeAliases).length >= MAX_FILE_BADGE_RULE_ENTRIES) {
        showError(t("settings.fileBadges.tooManyRules"));
        return;
      }
      port.settings.fileExtensionBadgeAliases = {
        ...port.settings.fileExtensionBadgeAliases,
        [extension]: alias
      };
      renderList();
      await persist();
      rawExtension = "";
      rawAlias = "";
      if (extensionInput) extensionInput.value = "";
      if (aliasInput) aliasInput.value = "";
      hideError();
    };
    for (const input of [extensionInput, aliasInput]) input?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      void addAlias();
    });
    renderList();
  }
}
