import { encodeEventTopics, formatLog, numberToHex, parseEventLogs } from 'viem'
import type {
    Abi,
    AbiEvent,
    AbiParameter,
    AbiParameterToPrimitiveType,
    Address,
    GetLogsParameters,
    Log,
    LogTopic,
    PublicClient,
} from 'viem'

/**
 * Returns the smallest bigint.
 */
export function minBigInt(a: bigint, b: bigint) {
    return a < b ? a : b;
}

/**
 * A log of any of the events in TAbiEvent. Distributes over the union, so `.eventName`
 * and `.args` stay narrowable per event.
 */
export type EventLog<TAbiEvent extends AbiEvent> =
    TAbiEvent extends AbiEvent ? Log<bigint, number, false, TAbiEvent, true> : never;


export type PostQueryEventFilter<TAbiEvent extends AbiEvent> = (allEvents: EventLog<TAbiEvent>[], newChunkEvents: EventLog<TAbiEvent>[],firstBlock:bigint, lastBlock:bigint) => [result:EventLog<TAbiEvent>[],quitEarly:boolean]


type UnionToIntersection<TUnion> =
    (TUnion extends unknown ? (arg: TUnion) => void : never) extends (arg: infer TIntersection) => void
        ? TIntersection
        : never;

type IndexedInput<TAbiEvent extends AbiEvent> = Extract<TAbiEvent['inputs'][number], { indexed: true }>;

/**
 * Names of the indexed params of a single event. Falls back to `string` when the abi wasn't
 * declared `as const` (`indexed` widened to boolean), so this stays usable instead of collapsing to never.
 */
type IndexedNames<TAbiEvent extends AbiEvent> =
    [IndexedInput<TAbiEvent>] extends [never] ? string : NonNullable<IndexedInput<TAbiEvent>['name']>;

/**
 * Indexed param names present in *every* event of the union. Wrapping each event's names in an
 * object and intersecting turns the union of name-sets into their intersection.
 */
type SharedIndexedNames<TAbiEvent extends AbiEvent> =
    UnionToIntersection<TAbiEvent extends AbiEvent ? { names: IndexedNames<TAbiEvent> } : never> extends { names: infer TNames }
        ? TNames & string
        : never;

type IndexedInputByName<TAbiEvent extends AbiEvent, TName extends string> =
    Extract<IndexedInput<TAbiEvent>, { name: TName }>;

type SharedArgValue<TAbiEvent extends AbiEvent, TName extends string> =
    [IndexedInputByName<TAbiEvent, TName>] extends [never]
        ? unknown
        : IndexedInputByName<TAbiEvent, TName> extends infer TInput
            ? TInput extends AbiParameter ? AbiParameterToPrimitiveType<TInput> : never
            : never;

/**
 * Filter on indexed params that all queried events share. A value may be a single value or an
 * array of values (matches any of them), same as viem's `args`.
 */
export type SharedEventFilterArgs<TAbiEvent extends AbiEvent> = {
    [TName in SharedIndexedNames<TAbiEvent>]?:
        | SharedArgValue<TAbiEvent, TName>
        | readonly SharedArgValue<TAbiEvent, TName>[]
        | null
        | undefined
};

/**
 * Finds the abi entries of an event by name. Overloaded events (same name, different params)
 * yield multiple entries, all are returned.
 */
function getEventAbis<TAbiEvent extends AbiEvent>(abi: Abi, eventName: string): TAbiEvent[] {
    const matches = abi.filter((item) => item.type === 'event' && item.name === eventName) as TAbiEvent[];
    if (matches.length === 0) {
        throw new Error(`Event "${eventName}" not found in ABI`);
    }
    return matches;
}

/**
 * Fetches contract events in chunks to avoid RPC limits on big block ranges.
 * Can filter on indexed args and scan backwards (latest first) but returns in normal order (earliest first).
 *
 * Reverse order helps when you want recent events first, so you can stop early with maxEvents without scanning everything.
 * maxEvents lets you quit once you hit enough events, saving RPC calls.
 *
 * Note: No concurrency implemented. This usually messes with rate limits on most RPCs. For local setups, just bump up chunkSize.
 *
 * @param {PublicClient} args.publicClient
 * @param {{ address: Address; abi: TAbi }} args.contract - the viem contract object (returned from getContract). Or just pass  {address: 0xUrContract; abi: ["ur", "abi"] }
 * @param {TEventName} args.eventName
 * @param {GetLogsParameters<TAbiEvent>['args']} [args.eventFilterArgs] - Filters for indexed parameters (this is passed to publicClient.getLogs aka eth_getLog)
 * @param {bigint} [args.firstBlock] - Start block (inclusive). Defaults to 0n.
 * @param {bigint} [args.lastBlock] - End block (inclusive). Defaults to current block.
 * @param {boolean} [args.reverseOrder] - Scan latest to earliest, but returns the normal order.
 * @param {number} [args.maxEvents] - Max events to fetch; stops early if hit. (events are counted after postQueryFilter is applied)
 * @param {bigint} [args.chunkSize] - amount of block will be requested with eth_getLogs
 * @param {(events: EventLog<TAbiEvent>[]) => EventLog<TAbiEvent>[]} [args.postQueryFilter] - Filter applied after events are queried.
 *
 * @returns {Promise<EventLog<TAbiEvent>[]>} Array of event logs, earliest to latest.
 */
export async function queryEventInChunks<
  const TAbi extends Abi,
  const TEventName extends string,
  TAbiEvent extends AbiEvent = Extract<TAbi[number], AbiEvent & { name: TEventName }>
>({
    publicClient,
    contract,
    eventName,
    eventFilterArgs,
    firstBlock = 0n,
    lastBlock,
    reverseOrder = false,
    maxEvents = Infinity,
    chunkSize = 20000n,
    postQueryFilter,
}: {
    publicClient: PublicClient;
    contract: { address: Address; abi: TAbi };
    eventName: TEventName;
    eventFilterArgs?: GetLogsParameters<TAbiEvent>['args'];
    firstBlock?:bigint;
    lastBlock?: bigint;
    reverseOrder?: boolean;
    maxEvents?: number;
    chunkSize?: bigint;
    postQueryFilter?:PostQueryEventFilter<TAbiEvent>;
}): Promise<EventLog<TAbiEvent>[]> {
    const address = contract.address;

    // Find the event abi based on eventName (now fully typed)
    const eventAbi = getEventAbis<TAbiEvent>(contract.abi, eventName)[0];

    return await scanInChunks<TAbiEvent>({
        publicClient,
        firstBlock,
        lastBlock,
        reverseOrder,
        maxEvents,
        chunkSize,
        postQueryFilter,
        queryChunk: async (fromBlock, toBlock) => await publicClient.getLogs({
            address,
            event: eventAbi,
            args: eventFilterArgs,
            fromBlock,
            toBlock,
        }) as EventLog<TAbiEvent>[],
    });
}

/**
 * Same as {@link queryEventInChunks} but for several events at once: one eth_getLogs per chunk with
 * every event signature OR'd into topic0, so N event names cost the same amount of RPC calls as 1.
 *
 * Filtering (sharedEventFilterArgs) is possible, but only on indexed params that *every* queried event has
 * at the same indexed position and with the same type. eth_getLogs topics are positional, not named:
 * topic1 is the 1st indexed param of whatever event matched, so a filter on it only means one thing
 * if all the events agree on what their 1st indexed param is. Filtering on a param that isn't shared
 * like that throws, instead of silently matching the wrong param on some of the events.
 *
 * @param {PublicClient} args.publicClient
 * @param {{ address: Address; abi: TAbi }} args.contract - the viem contract object (returned from getContract). Or just pass  {address: 0xUrContract; abi: ["ur", "abi"] }
 * @param {TEventName[]} args.eventNames - the events to query, all in one filter
 * @param {SharedEventFilterArgs<TAbiEvent>} [args.sharedEventFilterArgs] - Filters for indexed params shared by all queried events, e.g. { treeId: [1n, 2n] }. Throws if a param isn't shared.
 * @param {bigint} [args.firstBlock] - Start block (inclusive). Defaults to 0n.
 * @param {bigint} [args.lastBlock] - End block (inclusive). Defaults to current block.
 * @param {boolean} [args.reverseOrder] - Scan latest to earliest, but returns the normal order.
 * @param {number} [args.maxEvents] - Max events to fetch; stops early if hit. (events are counted after postQueryFilter is applied)
 * @param {bigint} [args.chunkSize] - amount of block will be requested with eth_getLogs
 * @param {PostQueryEventFilter<TAbiEvent>} [args.postQueryFilter] - Filter applied after events are queried.
 *
 * @returns {Promise<EventLog<TAbiEvent>[]>} Array of logs of all requested events mixed together, earliest to latest.
 */
export async function queryMultiEventsInChunks<
  const TAbi extends Abi,
  const TEventName extends string,
  TAbiEvent extends AbiEvent = Extract<TAbi[number], AbiEvent & { name: TEventName }>
>({
    publicClient,
    contract,
    eventNames,
    sharedEventFilterArgs,
    firstBlock = 0n,
    lastBlock,
    reverseOrder = false,
    maxEvents = Infinity,
    chunkSize = 20000n,
    postQueryFilter,
}: {
    publicClient: PublicClient;
    contract: { address: Address; abi: TAbi };
    eventNames: readonly TEventName[];
    sharedEventFilterArgs?: SharedEventFilterArgs<TAbiEvent>;
    firstBlock?:bigint;
    lastBlock?: bigint;
    reverseOrder?: boolean;
    maxEvents?: number;
    chunkSize?: bigint;
    postQueryFilter?:PostQueryEventFilter<TAbiEvent>;
}): Promise<EventLog<TAbiEvent>[]> {
    const address = contract.address;
    const abi = contract.abi;

    if (eventNames.length === 0) {
        throw new Error(`No event names given`);
    }

    const eventAbis = eventNames.flatMap((eventName) => getEventAbis<AbiEvent>(abi, eventName));
    const topics = buildSharedTopics(eventAbis, sharedEventFilterArgs);

    return await scanInChunks<TAbiEvent>({
        publicClient,
        firstBlock,
        lastBlock,
        reverseOrder,
        maxEvents,
        chunkSize,
        postQueryFilter,
        // viem's getLogs refuses args together with multiple events (it can't map named args onto
        // positional topics for a union of events), so the filter is handed to the node as raw topics.
        queryChunk: async (fromBlock, toBlock) => {
            const rpcLogs = await publicClient.request({
                method: 'eth_getLogs',
                params: [{
                    address,
                    topics,
                    fromBlock: numberToHex(fromBlock),
                    toBlock: numberToHex(toBlock),
                }],
            });
            return parseEventLogs({
                abi: abi as Abi,
                eventName: [...eventNames],
                logs: rpcLogs.map((log) => formatLog(log)),
                strict: true,
            }) as unknown as EventLog<TAbiEvent>[];
        },
    });
}

/**
 * Builds the eth_getLogs topics for a multi event query: topic0 is every event signature (OR'd),
 * the rest are the shared indexed args. Throws if an arg isn't shared by all events.
 */
function buildSharedTopics(eventAbis: AbiEvent[], sharedEventFilterArgs?: Record<string, unknown>): LogTopic[] {
    const signatures = eventAbis.map((eventAbi) => encodeEventTopics({ abi: [eventAbi] })[0]);
    const topic0 = [...new Set(signatures)];

    const filterNames = Object.entries(sharedEventFilterArgs ?? {})
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([name]) => name);
    if (filterNames.length === 0) {
        return [topic0];
    }

    const indexedInputsPerEvent = eventAbis.map((eventAbi) => ({
        eventAbi,
        inputs: eventAbi.inputs.filter((input) => input.indexed),
    }));

    for (const name of filterNames) {
        // Every event must have this param indexed, at the same position and with the same type,
        // otherwise the same topic slot would mean different things per event.
        const found = indexedInputsPerEvent.map(({ eventAbi, inputs }) => {
            const position = inputs.findIndex((input) => input.name === name);
            return {
                eventName: eventAbi.name,
                position,
                type: position === -1 ? undefined : inputs[position].type,
                isNonIndexedParam: position === -1 && eventAbi.inputs.some((input) => input.name === name),
            };
        });

        const missing = found.filter(({ position }) => position === -1);
        if (missing.length !== 0) {
            const reasons = missing
                .map(({ eventName, isNonIndexedParam }) =>
                    `${eventName} (${isNonIndexedParam ? 'not indexed' : 'no such param'})`)
                .join(', ');
            throw new Error(
                `Cannot filter on "${name}": it is not an indexed param of every queried event. Missing in: ${reasons}. ` +
                `Only params shared by all events can be filtered, since eth_getLogs topics are positional.`
            );
        }

        const positions = [...new Set(found.map(({ position }) => position))];
        if (positions.length !== 1) {
            const perEvent = found.map(({ eventName, position }) => `${eventName}: #${position + 1}`).join(', ');
            throw new Error(
                `Cannot filter on "${name}": it is not the same indexed param position in every queried event (${perEvent}). ` +
                `A topic slot is positional, so it must line up across all events.`
            );
        }

        const types = [...new Set(found.map(({ type }) => type))];
        if (types.length !== 1) {
            const perEvent = found.map(({ eventName, type }) => `${eventName}: ${type}`).join(', ');
            throw new Error(
                `Cannot filter on "${name}": its type differs between the queried events (${perEvent}).`
            );
        }
    }

    // Positions were just verified to be identical across all events, so encoding against the first
    // event gives the topics for all of them.
    const [, ...argTopics] = encodeEventTopics({
        abi: [eventAbis[0]] as Abi,
        eventName: eventAbis[0].name,
        args: sharedEventFilterArgs,
    });

    // Trailing nulls are just "match anything", no need to send them.
    while (argTopics.length !== 0 && argTopics[argTopics.length - 1] === null) {
        argTopics.pop();
    }

    return [topic0, ...argTopics] as LogTopic[];
}

/**
 * Walks the block range in chunks, calling queryChunk per chunk, and applies
 * postQueryFilter / maxEvents. Shared by the single and multi event queries.
 *
 * TODO: optional concurrency (bounded worker pool over the chunk indices, default 1 so nothing
 * changes for whoever doesn't opt in). Chunks are independent, so this is close to a linear speedup
 * up to whatever ceiling applies:
 *
 * - self hosters (biggest win by far): no rate limit at all, the ceiling is NVMe queue depth and
 *   cores. Erigon/reth resolve a chunk from their inverted log index (bitmap of blocks per topic),
 *   so the per chunk cost is mostly materializing receipts for matched blocks, which parallelizes
 *   fine. Bump chunkSize way up too, the provider result caps below don't exist locally.
 * - paid RPCs (still worth it, just capped): providers meter *throughput*, not concurrency, so
 *   sequential scanning leaves most of the budget unused. Infura bills eth_getLogs at 255 credits
 *   against a per second credit ceiling (2k/s free, up to 40k/s on higher plans), Alchemy meters
 *   CUPS (330 free, 10k on PAYG, and it lets you burst above your tier on elastic capacity).
 *   Little's law gives the in flight budget: creditsPerSecond * avgLatency / costPerRequest, so
 *   Infura free at ~500ms per call is only ~4 in flight, a Team plan is ~78. Past that it's 429s.
 * - free/public RPCs: don't. That's what the default of 1 is for.
 *
 * Two things to get right when implementing:
 * - maxEvents early stop: in flight chunks overshoot before the stop is noticed. Harmless forwards,
 *   but in reverseOrder the results have to be stitched back in block order before slicing.
 * - retries: concurrency turns a rate limit into 429s on several chunks at once, so it needs
 *   per chunk backoff to not just fail the whole scan.
 */
async function scanInChunks<TAbiEvent extends AbiEvent>({
    publicClient,
    queryChunk,
    firstBlock,
    lastBlock,
    reverseOrder,
    maxEvents,
    chunkSize,
    postQueryFilter,
}: {
    publicClient: PublicClient;
    queryChunk: (fromBlock: bigint, toBlock: bigint) => Promise<EventLog<TAbiEvent>[]>;
    firstBlock: bigint;
    lastBlock?: bigint;
    reverseOrder: boolean;
    maxEvents: number;
    chunkSize: bigint;
    postQueryFilter?: PostQueryEventFilter<TAbiEvent>
}): Promise<EventLog<TAbiEvent>[]> {
    lastBlock ??= await publicClient.getBlockNumber();
    let allEvents: EventLog<TAbiEvent>[] = [];
    let done = false;

    const scanLogic = async (index: bigint):Promise<[EventLog<TAbiEvent>[], bigint, bigint]> => {
        const start = firstBlock + index * chunkSize;
        const stop  = minBigInt(start + chunkSize - 1n, lastBlock);
        return [(await queryChunk(start, stop)), start, stop];
    };

    const range = lastBlock - firstBlock + 1n;
    const numIters = Math.ceil(Number(range) / Number(chunkSize));
    if (reverseOrder) {
        for (let index = BigInt(numIters - 1); index >= 0n; index--) {
            const [events, firstBlock, lastBlock] = await scanLogic(index);
            allEvents = [...events as EventLog<TAbiEvent>[], ...allEvents];
            if (postQueryFilter) {
                [allEvents, done] = postQueryFilter(allEvents, events, firstBlock, lastBlock)
            }
            allEvents = allEvents.slice(-maxEvents);
            if (done || allEvents.length >= maxEvents) {
                console.log(`stopped scanning at chunk ${index}/${numIters-1}`);
                break
            };
        }
        
    } else {
        for (let index = 0n; index < BigInt(numIters); index++) {
            const [events, firstBlock, lastBlock] = await scanLogic(index);
            allEvents = [...allEvents, ...events as EventLog<TAbiEvent>[]];
            if (postQueryFilter) {
                [allEvents, done] = postQueryFilter(allEvents, events, firstBlock, lastBlock)
            }
            allEvents = allEvents.slice(0, maxEvents);
            if (done || allEvents.length >= maxEvents) {console.log(`stopped scanning at chunk ${index}/${numIters-1}`);break};
        }
    }

    return allEvents;
}
