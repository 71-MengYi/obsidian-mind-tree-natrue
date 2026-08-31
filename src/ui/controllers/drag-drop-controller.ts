import { EXTERNAL_FILE_CONFIRM_BYTES, EXTERNAL_FILE_REJECT_BYTES } from "../../input-limits";

export interface ExternalFileBatch {
  readonly importable: File[];
  readonly rejected: File[];
  readonly totalBytes: number;
  readonly needsConfirmation: boolean;
}

/** View-session drag state and fixed external-file admission policy. */
export class DragDropController {
  private internalPaths: string[] = [];

  rememberInternalPaths(paths: Iterable<string>): void {
    this.internalPaths = [...new Set(paths)];
  }

  takeInternalPaths(): string[] {
    const paths = this.internalPaths;
    this.internalPaths = [];
    return paths;
  }

  clear(): void { this.internalPaths = []; }

  classifyExternalFiles(files: Iterable<File>): ExternalFileBatch {
    const all = [...files];
    const rejected = all.filter((file) => file.size > EXTERNAL_FILE_REJECT_BYTES);
    const importable = all.filter((file) => file.size <= EXTERNAL_FILE_REJECT_BYTES);
    const totalBytes = importable.reduce((total, file) => total + file.size, 0);
    return {
      importable, rejected, totalBytes,
      needsConfirmation: totalBytes > EXTERNAL_FILE_CONFIRM_BYTES
        || importable.some((file) => file.size > EXTERNAL_FILE_CONFIRM_BYTES)
    };
  }
}
