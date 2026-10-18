export interface ItemRef {
  is24Id: string;
  title?: string;
  slug?: string;
  webflowItemId?: string;
}

export interface SyncReport {
  success: boolean;
  /**
   * false, wenn das Zeitbudget erschöpft war und noch Writes ausstehen —
   * der Aufrufer ruft dann erneut auf (der Hash-Diff macht dort weiter).
   */
  complete: boolean;
  /** Anzahl der in diesem Lauf nicht mehr verarbeiteten Writes/Unpublishes. */
  pendingCount: number;
  dryRun: boolean;
  runId: string;
  sourceCount: number;
  existingWebflowCount: number;
  createCount: number;
  updateCount: number;
  unchangedCount: number;
  unpublishCount: number;
  warningCount: number;
  errorCount: number;
  durationMs: number;
  created: ItemRef[];
  updated: ItemRef[];
  unchanged: ItemRef[];
  /** Im Dry-Run bzw. bei INACTIVE_ACTION=ignore: was unveröffentlicht würde. */
  wouldUnpublish: ItemRef[];
  unpublished: ItemRef[];
  warnings: string[];
  errors: string[];
}

export class ReportBuilder {
  private readonly startedAt: number;
  readonly created: ItemRef[] = [];
  readonly updated: ItemRef[] = [];
  readonly unchanged: ItemRef[] = [];
  readonly wouldUnpublish: ItemRef[] = [];
  readonly unpublished: ItemRef[] = [];
  readonly warnings: string[] = [];
  readonly errors: string[] = [];
  sourceCount = 0;
  existingWebflowCount = 0;
  pendingCount = 0;

  constructor(
    private readonly runId: string,
    private readonly dryRun: boolean,
  ) {
    this.startedAt = Date.now();
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  error(message: string): void {
    this.errors.push(message);
  }

  build(success: boolean): SyncReport {
    return {
      success,
      complete: this.pendingCount === 0,
      pendingCount: this.pendingCount,
      dryRun: this.dryRun,
      runId: this.runId,
      sourceCount: this.sourceCount,
      existingWebflowCount: this.existingWebflowCount,
      createCount: this.created.length,
      updateCount: this.updated.length,
      unchangedCount: this.unchanged.length,
      unpublishCount: this.unpublished.length,
      warningCount: this.warnings.length,
      errorCount: this.errors.length,
      durationMs: Date.now() - this.startedAt,
      created: this.created,
      updated: this.updated,
      unchanged: this.unchanged,
      wouldUnpublish: this.wouldUnpublish,
      unpublished: this.unpublished,
      warnings: this.warnings,
      errors: this.errors,
    };
  }
}
