/**
 * Durable operations state: the append-only log plus its projection.
 *
 * The log primitive is the GENERIC append-only event store from
 * `packages/core/src/event-store.ts` -- append, fsync, content hash, snapshot,
 * truncated-line recovery, replay. It is a core primitive defined once and
 * consumed by both this module and the durable team kernel; there is
 * deliberately no second JSONL implementation here.
 *
 * Write-ahead: the event is appended and fsynced BEFORE the in-memory
 * projection moves. A projection that advanced first would, after a crash,
 * describe an action the log never recorded.
 * @module @helium/core/operations/store
 */
import { openEventStore, type EventStore } from "../event-store.js";
import { OperationsEventSchema, type OperationsEvent } from "./events.js";
import {
  reduceOperations,
  type OperationsState,
} from "./reducer.js";

export class OperationsStore {
  readonly #log: EventStore<OperationsEvent>;
  #state: OperationsState;
  #ids: Set<string>;

  private constructor(
    log: EventStore<OperationsEvent>,
    private readonly validateEvent?: (event: OperationsEvent) => void,
  ) {
    this.#log = log;
    const replayed = log.replay();
    for (const event of replayed) this.validateEvent?.(event);
    this.#state = reduceOperations(replayed);
    this.#ids = new Set(replayed.map((e) => e.id));
  }

  static open(
    dir: string,
    options: {
      sync?: (fd: number) => void;
      validateEvent?: (event: OperationsEvent) => void;
    } = {},
  ): OperationsStore {
    return new OperationsStore(
      openEventStore<OperationsEvent>(dir, {
        schema: OperationsEventSchema,
        ...(options.sync === undefined ? {} : { sync: options.sync }),
      }),
      options.validateEvent,
    );
  }

  /**
   * Validate, append, fsync, then project.
   *
   * @throws on a duplicate event id, an unsupported version, or an illegal
   * transition -- and it throws BEFORE appending, so a rejected event never
   * enters the log.
   */
  append(raw: unknown): OperationsEvent {
    const event = OperationsEventSchema.parse(raw);
    this.validateEvent?.(event);
    if (this.#ids.has(event.id)) {
      throw new Error(`duplicate operations event id: ${event.id}`);
    }
    // Project speculatively first: an illegal transition must be refused
    // before it is made durable, not discovered on the next replay.
    const next = reduceOperations([event], this.#state);
    this.#log.append(event);
    this.#state = next;
    this.#ids.add(event.id);
    return event;
  }

  state(): OperationsState {
    return this.#state;
  }

  replay(): OperationsEvent[] {
    return this.#log.replay();
  }

  snapshot(): void {
    this.#log.snapshot();
  }

  get logPath(): string {
    return this.#log.logPath;
  }
}
