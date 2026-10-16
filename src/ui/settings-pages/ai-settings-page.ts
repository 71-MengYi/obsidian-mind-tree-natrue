import { Setting } from "obsidian";
import { t } from "../../i18n";
import {
  buildMcpPageModel,
  describeMcpStatus,
  describePortFallbacks,
  MAX_MCP_PORT,
  MIN_MCP_PORT,
  parseMcpPortInput,
  type McpPageModel
} from "../../services/mcp/settings-page-model";
import type { SettingsPageObject, SettingsPagePort } from "./ports";

/**
 * The slice of Obsidian's toggle component this page keeps a reference to.
 *
 * Refresh writes the model back onto the switches, and a structural type keeps
 * the page from needing any Obsidian type import beyond `Setting`.
 */
interface ToggleLike {
  setValue(value: boolean): unknown;
  setDisabled(value: boolean): unknown;
}

/** How long the "copied" confirmation stays on screen before it clears itself. */
const COPY_FEEDBACK_MS = 4_000;

/**
 * "AI" tab: the local MCP endpoint for external clients.
 *
 * The page is deliberately thin. Every rule that a user can observe — which
 * control is disabled, what the status sentence says, the client JSON, whether
 * the config block exists, and whether typed port text is a valid port — is
 * decided by `buildMcpPageModel` / `describeMcpStatus` / `parseMcpPortInput`, so
 * those rules stay testable without a DOM. This file only moves values between
 * one resolved snapshot and the elements, and asks the port for named
 * transitions.
 *
 * Everything is rendered even on a platform without MCP support: an absent
 * feature is invisible, while a disabled one explains itself.
 */
export class AiSettingsPage implements SettingsPageObject {
  readonly element: HTMLElement;

  private enableToggle?: ToggleLike;
  private writeToggle?: ToggleLike;
  private treeCreationToggle?: ToggleLike;
  private portInput?: HTMLInputElement;
  private configText?: HTMLTextAreaElement;
  private readonly configSection: HTMLElement;
  private readonly statusLine: HTMLElement;
  private readonly portError: HTMLElement;
  private readonly copyFeedback: HTMLElement;
  private readonly notice: HTMLElement;
  private copyFeedbackTimer?: ReturnType<typeof setTimeout>;

  constructor(parent: HTMLElement, private readonly port: SettingsPagePort) {
    this.element = parent;
    parent.createEl("h3", { text: t("settings.tabs.ai") });

    const model = this.readModel();
    parent.createEl("h4", { text: model.heading });
    parent.createEl("p", { cls: "setting-item-description", text: model.description });

    new Setting(parent)
      .setName(t("settings.ai.mcp.enable"))
      .setDesc(t("settings.ai.mcp.enable.desc"))
      .addToggle((toggle) => {
        this.enableToggle = toggle;
        toggle.setValue(model.enable.value);
        toggle.setDisabled(model.enable.disabled);
        toggle.onChange((value) => {
          void this.transition(() => this.port.mcp.setEnabled(value));
        });
      });

    new Setting(parent)
      .setName(t("settings.ai.mcp.writes"))
      .setDesc(t("settings.ai.mcp.writes.desc"))
      .addToggle((toggle) => {
        this.writeToggle = toggle;
        toggle.setValue(model.writes.value);
        toggle.setDisabled(model.writes.disabled);
        toggle.onChange((value) => {
          void this.transition(() => this.port.mcp.setAllowWrites(value));
        });
      });

    new Setting(parent)
      .setName(t("settings.ai.mcp.treeCreation"))
      .setDesc(t("settings.ai.mcp.treeCreation.desc"))
      .addToggle((toggle) => {
        this.treeCreationToggle = toggle;
        toggle.setValue(model.treeCreation.value);
        toggle.setDisabled(model.treeCreation.disabled);
        toggle.onChange((value) => {
          void this.transition(() => this.port.mcp.setAllowTreeCreation(value));
        });
      });

    new Setting(parent)
      .setName(t("settings.ai.mcp.port"))
      .setDesc(t("settings.ai.mcp.port.desc", {
        min: MIN_MCP_PORT,
        max: MAX_MCP_PORT,
        fallbacks: describePortFallbacks()
      }))
      .addText((text) => {
        this.portInput = text.inputEl;
        text.setValue(String(model.port.value));
        text.setDisabled(model.port.disabled);
        text.inputEl.addClass("mtn-settings-ai-port-input");
        // A number input would drop the rejected characters before the page can
        // report them, so the field stays textual and only the keyboard hints.
        text.inputEl.setAttribute("inputmode", "numeric");
        text.inputEl.setAttribute("aria-label", t("settings.ai.mcp.port"));
        // Committed on blur or Enter, never per keystroke: validating every
        // character would reject "1" while the user is still typing "1024" and
        // pull the field back to the stored port mid-word.
        text.inputEl.addEventListener("blur", () => {
          void this.commitPort(text.inputEl.value);
        });
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          void this.commitPort(text.inputEl.value);
        });
      });

    this.statusLine = parent.createDiv({
      cls: "mtn-settings-ai-status",
      attr: { role: "status", "aria-live": "polite" }
    });
    this.portError = parent.createDiv({
      cls: "mtn-settings-ai-port-error",
      attr: { role: "status", "aria-live": "polite" }
    });
    this.portError.hidden = true;

    this.configSection = parent.createDiv({ cls: "mtn-settings-ai-config" });
    this.configSection.createEl("h4", { text: t("settings.ai.mcp.config.heading") });
    this.configSection.createEl("p", {
      cls: "setting-item-description",
      text: t("settings.ai.mcp.config.desc", { clients: t("settings.ai.mcp.config.clients") })
    });
    // The manual-copy hint points at the text below it, so it sits above the field.
    this.copyFeedback = this.configSection.createDiv({
      cls: "mtn-settings-ai-copy-feedback",
      attr: { role: "status", "aria-live": "polite" }
    });
    new Setting(this.configSection)
      .setDesc(t("settings.ai.mcp.config.secretWarning"))
      .addTextArea((area) => {
        this.configText = area.inputEl;
        area.setValue(model.config.text);
        // The JSON carries the access token: a stray keystroke must not be able
        // to corrupt the credential the client is about to paste.
        area.inputEl.readOnly = true;
        area.inputEl.addClass("mtn-settings-ai-config-text");
        area.inputEl.setAttribute("aria-label", t("settings.ai.mcp.config.heading"));
        area.inputEl.setAttribute("spellcheck", "false");
      })
      .addButton((button) => {
        button.setButtonText(t("settings.ai.mcp.config.copy"));
        button.buttonEl.addClass("mtn-settings-ai-copy");
        button.onClick(() => {
          void this.copyConfig();
        });
      });

    this.notice = parent.createDiv({
      cls: "mtn-settings-ai-notice",
      // The same resolved sentence the status line uses for an unsupported
      // platform, repeated as a standing notice at the end of the section.
      text: describeMcpStatus({ kind: "unsupported" })
    });

    this.applyModel(model);
  }

  /**
   * Only the copy confirmation timer is owned by this page: every listener sits
   * on an element inside the settings panel, which the host drops wholesale
   * when the tab is hidden.
   */
  destroy(): void {
    if (this.copyFeedbackTimer === undefined) return;
    clearTimeout(this.copyFeedbackTimer);
    this.copyFeedbackTimer = undefined;
  }

  private readModel(): McpPageModel {
    return buildMcpPageModel(this.port.mcp.state());
  }

  /** Write one resolved snapshot onto the elements; nothing is decided here. */
  private applyModel(model: McpPageModel): void {
    this.enableToggle?.setValue(model.enable.value);
    this.enableToggle?.setDisabled(model.enable.disabled);
    this.writeToggle?.setValue(model.writes.value);
    this.writeToggle?.setDisabled(model.writes.disabled);
    this.treeCreationToggle?.setValue(model.treeCreation.value);
    this.treeCreationToggle?.setDisabled(model.treeCreation.disabled);
    if (this.portInput) {
      this.portInput.value = String(model.port.value);
      this.portInput.disabled = model.port.disabled;
    }
    this.setStatus(model.status.text, model.status.kind);
    // A state the host cannot serve has no token to hand out, so the whole
    // client-config block is withdrawn rather than shown with an empty field.
    this.configSection.hidden = !model.config.visible;
    if (this.configText) this.configText.value = model.config.text;
    this.notice.hidden = model.supported;
  }

  private setStatus(text: string, kind: McpPageModel["status"]["kind"]): void {
    this.statusLine.setText(text);
    this.statusLine.dataset["status"] = kind;
  }

  /**
   * Run one named transition and re-read the port's resolved state afterwards.
   *
   * A rejected transition still has to explain why the switch stayed where it
   * was, so its message replaces the status line until the next refresh.
   */
  private async transition(run: () => Promise<void>): Promise<void> {
    let failure: string | undefined;
    try {
      await run();
    } catch (error) {
      failure = describeError(error);
    }
    this.applyModel(this.readModel());
    if (failure !== undefined) this.setStatus(describeMcpStatus({ kind: "failed", message: failure }), "failed");
  }

  private async commitPort(raw: string): Promise<void> {
    if (parseMcpPortInput(raw) === undefined) {
      this.rejectPort();
      return;
    }
    let applied: boolean;
    try {
      applied = await this.port.mcp.applyPortInput(raw);
    } catch (error) {
      this.setStatus(describeMcpStatus({ kind: "failed", message: describeError(error) }), "failed");
      this.restorePortValue();
      return;
    }
    if (!applied) {
      // The host may still refuse text this page parsed, so its answer decides.
      this.rejectPort();
      return;
    }
    this.hidePortError();
    this.applyModel(this.readModel());
  }

  private rejectPort(): void {
    this.portError.setText(t("settings.ai.mcp.port.invalid", { min: MIN_MCP_PORT, max: MAX_MCP_PORT }));
    this.portError.hidden = false;
    this.restorePortValue();
  }

  /** Rejected text must not look stored: show what the port still holds. */
  private restorePortValue(): void {
    if (this.portInput) this.portInput.value = String(this.port.mcp.state().port);
  }

  private hidePortError(): void {
    this.portError.setText("");
    this.portError.hidden = true;
  }

  private async copyConfig(): Promise<void> {
    let copied = false;
    const text = this.readModel().config.text;
    try {
      copied = await this.port.mcp.copyText(text);
    } catch {
      copied = false;
    }
    if (!copied) {
      // A failed automatic copy is exactly the moment the manual path has to be
      // available, so the readonly field is revealed and named by the hint.
      if (this.configText) this.configText.hidden = false;
      this.setCopyFeedback(t("settings.ai.mcp.config.copyFailed"));
      return;
    }
    this.setCopyFeedback(t("settings.ai.mcp.config.copied"));
  }

  private setCopyFeedback(text: string): void {
    this.copyFeedback.setText(text);
    if (this.copyFeedbackTimer !== undefined) clearTimeout(this.copyFeedbackTimer);
    this.copyFeedbackTimer = setTimeout(() => {
      this.copyFeedback.setText("");
      this.copyFeedbackTimer = undefined;
    }, COPY_FEEDBACK_MS);
  }
}

/**
 * Error objects format differently across hosts; the message is what matters.
 *
 * Deliberately not `error instanceof Error`: `instanceof` is realm-local, so a
 * failure raised by another realm (a plugin host, an iframe, or the `vm` realm a
 * test evaluates this module in) would not match and would fall back to
 * `String(error)`, leaking an "Error:" prefix into the user's status line. A
 * duck-typed `message` string is both sufficient and realm-independent.
 */
function describeError(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return String(error);
}
