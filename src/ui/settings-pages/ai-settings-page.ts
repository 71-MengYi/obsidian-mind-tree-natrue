import { Setting } from "obsidian";
import { t } from "../../i18n";
import type { McpServerGroup } from "../../services/mcp/connection";
import {
  buildMcpPageModel,
  describeMcpStatus,
  describePortFallbacks,
  MAX_MCP_PORT,
  MIN_MCP_PORT,
  parseMcpPortInput,
  type McpPageModel,
  type McpServerModel,
  type McpSettingsStatus
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

/** One server's mutable elements, replaced from a single resolved snapshot. */
interface ServerControls {
  input?: HTMLInputElement;
  readonly status: HTMLElement;
  readonly error: HTMLElement;
}

/** How long the "copied" confirmation stays on screen before it clears itself. */
const COPY_FEEDBACK_MS = 4_000;

/**
 * "AI" tab: the two local MCP servers an external client connects to.
 *
 * Two servers rather than one with permission switches, because an MCP client
 * attaches its tool-approval policy to a *server*: `read` holds nothing that
 * changes a file, so it can run unattended, while `write` holds every tool that
 * does, so the client can require approval for it alone.
 *
 * The page is deliberately thin. Every rule a user can observe — which control
 * is disabled, what each status sentence says, the client JSON, whether the
 * config block exists, and whether typed port text is a valid port — is decided
 * by `buildMcpPageModel` / `describeMcpStatus` / `parseMcpPortInput`, so those
 * rules stay testable without a DOM. This file only moves values between one
 * resolved snapshot and the elements, and asks the port for named transitions.
 *
 * Everything is rendered even on a platform without MCP support: an absent
 * feature is invisible, while a disabled one explains itself.
 */
export class AiSettingsPage implements SettingsPageObject {
  readonly element: HTMLElement;

  private enableToggle?: ToggleLike;
  private writeToggle?: ToggleLike;
  private readonly servers: Record<McpServerGroup, ServerControls>;
  private configText?: HTMLTextAreaElement;
  private readonly configSection: HTMLElement;
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
        toggle.onChange((value) => {
          // The master switch's primary listener is the read server, so its
          // status line is where a rejected start explains itself.
          void this.transition("read", () => this.port.mcp.setEnabled(value));
        });
      });

    // Both servers are always rendered, read first: it is the one that runs
    // unattended, and the write server is the one that asks for approval.
    this.servers = {
      read: this.createServerBlock(parent, "read", model.read),
      write: this.createServerBlock(parent, "write", model.write, (block) => {
        new Setting(block)
          .setName(t("settings.ai.mcp.write.enable"))
          .addToggle((toggle) => {
            this.writeToggle = toggle;
            toggle.onChange((value) => {
              void this.transition("write", () => this.port.mcp.setWriteEnabled(value));
            });
          });
      })
    };

    this.configSection = parent.createDiv({ cls: "mtn-settings-ai-config" });
    this.configSection.createEl("h4", { text: t("settings.ai.mcp.config.heading") });
    // The manual-copy hint points at the text below it, so it sits above the field.
    this.copyFeedback = this.configSection.createDiv({
      cls: "mtn-settings-ai-copy-feedback",
      attr: { role: "status", "aria-live": "polite" }
    });
    new Setting(this.configSection)
      .setDesc(t("settings.ai.mcp.config.desc", { clients: t("settings.ai.mcp.config.clients") }))
      .addTextArea((area) => {
        this.configText = area.inputEl;
        // The JSON carries the access tokens: a stray keystroke must not be able
        // to corrupt the credentials the client is about to paste.
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

    // The token is the credential itself, so the warning follows the field it is
    // about instead of sitting above it — and it hides with the block, because a
    // platform that hands out no token has nothing to warn about.
    this.configSection.createEl("p", {
      cls: "setting-item-description mtn-settings-ai-secret-warning",
      text: t("settings.ai.mcp.config.secretWarning")
    });

    this.notice = parent.createDiv({
      cls: "mtn-settings-ai-notice",
      // The same resolved sentence the status lines use for an unsupported
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

  /**
   * One server's block: sub-heading, scope, optional switch, port and status.
   *
   * The write block's switch is passed in as `addToggle` so it lands between the
   * scope and the port, which keeps both servers one shape with one deviation.
   */
  private createServerBlock(
    parent: HTMLElement,
    group: McpServerGroup,
    server: McpServerModel,
    addToggle?: (block: HTMLElement) => void
  ): ServerControls {
    const block = parent.createDiv({ cls: "mtn-settings-ai-server" });
    block.setAttribute("data-server", group);
    block.createEl("h5", { cls: "mtn-settings-ai-server-heading", text: server.heading });
    block.createEl("p", {
      cls: "setting-item-description mtn-settings-ai-server-scope",
      text: server.scope
    });
    addToggle?.(block);

    const holder: { input?: HTMLInputElement } = {};
    new Setting(block)
      .setName(t("settings.ai.mcp.port"))
      .setDesc(t("settings.ai.mcp.port.desc", {
        min: MIN_MCP_PORT,
        max: MAX_MCP_PORT,
        fallbacks: describePortFallbacks()
      }))
      .addText((text) => {
        const input = text.inputEl;
        holder.input = input;
        input.addClass("mtn-settings-ai-port-input");
        // A number input would drop the rejected characters before the page can
        // report them, so the field stays textual and only the keyboard hints.
        input.setAttribute("inputmode", "numeric");
        input.setAttribute("aria-label", t("settings.ai.mcp.port"));
        // Committed on blur or Enter, never per keystroke: validating every
        // character would reject "1" while the user is still typing "10273" and
        // pull the field back to the stored port mid-word.
        input.addEventListener("blur", () => {
          void this.commitPort(group, input.value);
        });
        input.addEventListener("keydown", (event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          void this.commitPort(group, input.value);
        });
      });

    // The rejection sits with the field it is about; the status reports the
    // listener behind that field.
    const error = block.createDiv({
      cls: "mtn-settings-ai-port-error",
      attr: { "data-server": group, role: "status", "aria-live": "polite" }
    });
    error.hidden = true;
    const status = block.createDiv({
      cls: "mtn-settings-ai-status",
      attr: { "data-server": group, role: "status", "aria-live": "polite" }
    });
    return holder.input === undefined ? { error, status } : { input: holder.input, error, status };
  }

  /** Write one resolved snapshot onto the elements; nothing is decided here. */
  private applyModel(model: McpPageModel): void {
    this.enableToggle?.setValue(model.enable.value);
    this.enableToggle?.setDisabled(model.enable.disabled);
    this.writeToggle?.setValue(model.write.value);
    // The model decides when a server's controls are inert; the page only applies it.
    this.writeToggle?.setDisabled(model.write.disabled);
    this.applyPort("read", model.read.port);
    this.applyPort("write", model.write.port);
    this.setStatus("read", model.read.status.text, model.read.status.kind);
    this.setStatus("write", model.write.status.text, model.write.status.kind);
    // A state the host cannot serve has no token to hand out, so the whole
    // client-config block is withdrawn rather than shown with an empty field.
    this.configSection.hidden = !model.config.visible;
    if (this.configText) this.configText.value = model.config.text;
    this.notice.hidden = model.supported;
  }

  private applyPort(server: McpServerGroup, port: McpServerModel["port"]): void {
    const input = this.servers[server].input;
    if (!input) return;
    input.value = String(port.value);
    input.disabled = port.disabled;
  }

  private setStatus(server: McpServerGroup, text: string, kind: McpSettingsStatus["kind"]): void {
    const status = this.servers[server].status;
    status.setText(text);
    status.dataset["status"] = kind;
  }

  /**
   * Run one named transition and re-read the port's resolved state afterwards.
   *
   * A rejected transition still has to explain why the switch stayed where it
   * was, so its message replaces the touched server's status until the next
   * refresh.
   */
  private async transition(server: McpServerGroup, run: () => Promise<void>): Promise<void> {
    let failure: string | undefined;
    try {
      await run();
    } catch (error) {
      failure = describeError(error);
    }
    this.applyModel(this.readModel());
    if (failure !== undefined) {
      this.setStatus(server, describeMcpStatus({ kind: "failed", message: failure }), "failed");
    }
  }

  private async commitPort(server: McpServerGroup, raw: string): Promise<void> {
    if (parseMcpPortInput(raw) === undefined) {
      this.rejectPort(server);
      return;
    }
    let applied: boolean;
    try {
      applied = await this.port.mcp.applyPortInput(server, raw);
    } catch (error) {
      this.setStatus(server, describeMcpStatus({ kind: "failed", message: describeError(error) }), "failed");
      this.restorePortValue(server);
      return;
    }
    if (!applied) {
      // The host may still refuse text this page parsed, so its answer decides.
      this.rejectPort(server);
      return;
    }
    this.hidePortError(server);
    this.applyModel(this.readModel());
  }

  private rejectPort(server: McpServerGroup): void {
    const error = this.servers[server].error;
    error.setText(t("settings.ai.mcp.port.invalid", { min: MIN_MCP_PORT, max: MAX_MCP_PORT }));
    error.hidden = false;
    this.restorePortValue(server);
  }

  /** Rejected text must not look stored: show what the port still holds. */
  private restorePortValue(server: McpServerGroup): void {
    const input = this.servers[server].input;
    if (input) input.value = String(this.port.mcp.state()[server].port);
  }

  private hidePortError(server: McpServerGroup): void {
    const error = this.servers[server].error;
    error.setText("");
    error.hidden = true;
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
