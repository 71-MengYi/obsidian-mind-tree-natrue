import {
  readClipboardEventContent,
  readClipboardFallbackContent,
  type ClipboardPasteContent
} from "../../services/clipboard";

/** Coordinates synchronous event data with the permission-gated system fallback. */
export class ClipboardController<TContext> {
  constructor(
    private readonly readSystemText: () => Promise<string>,
    private readonly onReadFailure: () => void
  ) {}

  handlePaste(
    event: ClipboardEvent,
    context: TContext,
    isCurrent: (context: TContext) => boolean,
    accept: (content: ClipboardPasteContent, context: TContext) => void
  ): void {
    const content = readClipboardEventContent(event);
    event.preventDefault();
    event.stopPropagation();
    if (content.kind !== "empty") {
      if (isCurrent(context)) accept(content, context);
      return;
    }
    void this.readFallback(context, isCurrent, accept);
  }

  private async readFallback(
    context: TContext,
    isCurrent: (context: TContext) => boolean,
    accept: (content: ClipboardPasteContent, context: TContext) => void
  ): Promise<void> {
    try {
      const content = await readClipboardFallbackContent(this.readSystemText);
      if (isCurrent(context)) accept(content, context);
    } catch {
      if (isCurrent(context)) this.onReadFailure();
    }
  }
}
