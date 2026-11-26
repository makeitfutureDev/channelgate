export interface ForkRequest { title: string; prompt: string }
type ForkStatus = "pending" | "creating" | "created" | "starting" | "cancelled" | "failed" | "created_with_error";
interface ForkRow {
  title: string;
  status: ForkStatus;
  threadKey?: string;
  url?: string;
  error?: string;
}
interface ChildLifecycle {
  row: ForkRow;
  created: (key: string, url?: string) => void;
  startTurn: (dispatch: (copiedOrSettled: () => void) => void) => void;
}
interface ForkExecution {
  stopped: () => boolean;
  authorize: () => Promise<unknown>;
  create: (fork: ForkRequest, child: ChildLifecycle) => Promise<void>;
  failed?: (row: ForkRow) => Promise<void>;
}

// A transport owns its source lane and remote calls. This journal makes a single pass over the
// approved children. An uncertain remote creation is recorded and never retried.
export class ForkBatch {
  readonly rows: ForkRow[];
  private readonly requests: ForkRequest[];
  private readonly persist: (rows: ForkRow[]) => void;
  private readonly copies: Promise<void>[] = [];

  constructor(requests: ForkRequest[], persist: (rows: ForkRow[]) => void) {
    this.requests = requests;
    this.persist = persist;
    this.rows = requests.map(({ title }) => ({ title, status: "pending" }));
  }

  async start({ stopped, authorize, create, failed }: ForkExecution): Promise<void> {
    for (const [index, fork] of this.requests.entries()) {
      const row = this.rows[index];
      try {
        if (!stopped()) await authorize();
        // Access lookup may yield to a stop while the source is reserved.
        if (stopped()) {
          row.status = "cancelled";
          this.persist(this.rows);
          continue;
        }
        row.status = "creating";
        this.persist(this.rows);
        await create(fork, {
          row,
          created: (key, url) => {
            row.threadKey = key;
            if (url) row.url = url;
            row.status = "created";
            this.persist(this.rows);
          },
          startTurn: dispatch => {
            row.status = "starting";
            this.persist(this.rows);
            // Resolve on the engine's first source snapshot or on terminal startup failure.
            let copied!: () => void;
            this.copies.push(new Promise<void>(resolve => { copied = resolve; }));
            try { dispatch(copied); } catch (error) { copied(); throw error; }
          },
        });
      } catch (error) {
        row.status = row.threadKey ? "created_with_error" : "failed";
        row.error = (error instanceof Error ? error.message : String(error)).slice(0, 200);
        await failed?.(row);
        this.persist(this.rows);
      }
    }
  }

  // The calling lane releases its reservation in finally, after posting the source index.
  async waitForCopies(): Promise<void> {
    await Promise.all(this.copies);
  }
}
