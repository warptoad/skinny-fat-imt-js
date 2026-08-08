import { LeanIMT, type LeanIMTHashFunction } from "@zk-kit/lean-imt";
import { poseidon2Hash } from "@zkpassport/poseidon2";
import { getContract, toHex, type Abi, type AbiEvent, type Address, type GetContractReturnType, type Hex, type Log, type PublicClient, type WalletClient } from "viem";

import { getInterfaceId, detectSupportedInterfaces, supportsInterface } from "./interfaceId.js";

import { minBigInt, queryEventInChunks, queryMultiEventsInChunks, type EventLog, type PostQueryEventFilter } from "./eventScanning.js";

import type { SkinnyIMTReadableStorage$Type } from "../artifacts/@warptoad/skinny-imt.sol/SkinnyIMTReadableStorage.sol/artifacts.js";
import type { SkinnyIMTReadableEvent$Type } from "../artifacts/@warptoad/skinny-imt.sol/SkinnyIMTReadableEvent.sol/artifacts.js";
import type { FatIMTReadableStorage$Type } from "../artifacts/@warptoad/fat-imt.sol/FatIMTReadableStorage.sol/artifacts.js";
import type { FatIMTReadableEvent$Type } from "../artifacts/@warptoad/fat-imt.sol/FatIMTReadableEvent.sol/artifacts.js";
import type { IIMTEvents$Type } from "../artifacts/@warptoad/fat-imt.sol/interfaces/IIMTEvents.sol/artifacts.js"

// runtime ABIs of the read *interfaces*, to derive their ERC-165 ids (below) directly from
// each interface artifact — no need to diff the full contract ABIs.
import iSkinnyEvent from "../artifacts/@warptoad/skinny-imt.sol/interfaces/ISkinnyIMTReadableEvent.sol/ISkinnyIMTReadableEvent.json" with { type: "json" };
import iSkinnyStorage from "../artifacts/@warptoad/skinny-imt.sol/interfaces/ISkinnyIMTReadableStorage.sol/ISkinnyIMTReadableStorage.json" with { type: "json" };
import iFatEvent from "../artifacts/@warptoad/fat-imt.sol/interfaces/IFatIMTReadableEvent.sol/IFatIMTReadableEvent.json" with { type: "json" };
import iFatStorage from "../artifacts/@warptoad/fat-imt.sol/interfaces/IFatIMTReadableStorage.sol/IFatIMTReadableStorage.json" with { type: "json" };

// runtime ABIs of the full read contracts, to build the concatenated ABI *value* for getContract.
import skinnyStorageArtifact from "../artifacts/@warptoad/skinny-imt.sol/SkinnyIMTReadableStorage.sol/SkinnyIMTReadableStorage.json" with { type: "json" };
import fatStorageArtifact from "../artifacts/@warptoad/fat-imt.sol/FatIMTReadableStorage.sol/FatIMTReadableStorage.json" with { type: "json" };
import skinnyEventArtifact from "../artifacts/@warptoad/skinny-imt.sol/SkinnyIMTReadableEvent.sol/SkinnyIMTReadableEvent.json" with { type: "json" };
import IIMTEventsArtifact from "../artifacts/@warptoad/fat-imt.sol/interfaces/IIMTEvents.sol/IIMTEvents.json" with { type: "json" };
import fatEventArtifact from "../artifacts/@warptoad/fat-imt.sol/FatIMTReadableEvent.sol/FatIMTReadableEvent.json" with { type: "json" };
import { DEPLOY_BLOCK, getDeploymentBlock } from "./config.js";

export type AnyContract = {
    address: Address
    abi: Abi
    read: Record<string, (...args: any[]) => Promise<any>>
}

type ReadableStorageAbi = readonly [
    ...SkinnyIMTReadableStorage$Type["abi"],
    ...FatIMTReadableStorage$Type["abi"],
];

type ReadableEventAbi = readonly [
    ...FatIMTReadableEvent$Type["abi"],
    ...SkinnyIMTReadableEvent$Type["abi"],
    ...IIMTEvents$Type["abi"]
]

type ReadableAbi = readonly [...ReadableStorageAbi, ...ReadableEventAbi]

/**
 * A single event *entry* of the contract abi, by name. `EventLog`/`PostQueryEventFilter` want one
 * AbiEvent, not a whole abi, and this is the exact same thing `queryEventInChunks` infers for
 * `eventName`, so filters typed with it line up with the query they're passed to.
 */
type ReadableEvent<TName extends string> = Extract<ReadableAbi[number], AbiEvent & { name: TName }>;


export const skinnyStorageAbi = skinnyStorageArtifact.abi as SkinnyIMTReadableStorage$Type["abi"]
export const skinnyEventAbi = skinnyEventArtifact.abi as SkinnyIMTReadableEvent$Type["abi"]
export const fatStorageAbi = fatStorageArtifact.abi as FatIMTReadableStorage$Type["abi"]
export const fatEventAbi = fatEventArtifact.abi as FatIMTReadableEvent$Type["abi"]

export const readableStorageAbi = [
    ...skinnyStorageArtifact.abi,
    ...fatStorageArtifact.abi,
] as unknown as ReadableStorageAbi;

export const readableEventAbi = [
    ...skinnyEventArtifact.abi,
    ...fatEventArtifact.abi,
    ...IIMTEventsArtifact.abi
] as unknown as ReadableEventAbi;

export type ReadableContract = GetContractReturnType<ReadableAbi, PublicClient>;
export type ReadableContractStorage = GetContractReturnType<ReadableStorageAbi, PublicClient>;
export type ReadableContractEvent = GetContractReturnType<ReadableEventAbi, PublicClient>;

export type ReadableContractSkinnyEvent = GetContractReturnType<SkinnyIMTReadableEvent$Type["abi"], PublicClient>;
export type ReadableContractSkinnyStorage = GetContractReturnType<SkinnyIMTReadableStorage$Type["abi"], PublicClient>;
export type ReadableContractFatEvent = GetContractReturnType<FatIMTReadableEvent$Type["abi"], PublicClient>;
export type ReadableContractFatStorage = GetContractReturnType<FatIMTReadableStorage$Type["abi"], PublicClient>;

export const ERC165_IDS = {
    skinnyEvent: getInterfaceId(iSkinnyEvent.abi as Abi),
    skinnyStorage: getInterfaceId(iSkinnyStorage.abi as Abi, [iSkinnyEvent.abi as Abi]),
    fatEvent: getInterfaceId(iFatEvent.abi as Abi),
    fatStorage: getInterfaceId(iFatStorage.abi as Abi, [iFatEvent.abi as Abi]),
} as const satisfies Record<string, Hex>;

type IStorageSupport = {
    event: boolean | undefined;
    storage: boolean | undefined;
};

type IFamilySupport = {
    skinny: IStorageSupport;
    fat: IStorageSupport;
};

enum TREE_TYPE {
    UNKNOWN,
    FAT_STORAGE,
    FAT_EVENT,
    SKINNY_STORAGE,
    SKINNY_EVENT,
    NO_INTERFACE
}

export const LeanIMTHashFuncPoseidon2: LeanIMTHashFunction = (a: bigint, b: bigint) => poseidon2Hash([a, b])

export type CachedTree = { tree: LeanIMT<bigint>, type: TREE_TYPE, lastSynced: bigint, insertOnlyTree?: boolean }

export class Trees {
    private trees: { [treeId: Hex]: CachedTree } = {}
    /** last known size per tree, with the block it was read at. See {@link getTreeSizeStorage}. */
    private sizes: { [treeId: Hex]: { blockNumber: bigint, size: bigint } } = {}

    public contractAddress: Address;
    public contract!: ReadableContract;
    public hashFunc: LeanIMTHashFunction;
    private publicClient: PublicClient;

    constructor(contractAddress: Address, client: PublicClient, hashFunc = LeanIMTHashFuncPoseidon2) {
        this.contractAddress = contractAddress
        this.publicClient = client
        this.hashFunc = hashFunc;
    }

    async sync(treeIds: bigint[] | undefined = undefined, { fullNodeMode = true, attemptFastSizeMatch = true, syncToRoot, eventChunkSize = 2000n, storageChunkSize = 2000n, insertOnlyTree, autoDiscovery, hasRepeatedLeafs = true, blockNumber }: { fullNodeMode?: boolean, blockNumber?: bigint, attemptFastSizeMatch?: boolean, syncToRoot?: bigint, eventChunkSize?: bigint, storageChunkSize?: bigint, hasRepeatedLeafs?: boolean, insertOnlyTree?: boolean, autoDiscovery?: boolean | undefined } = {}) {
        let syncedTrees: { [treeId: `0x${string}`]: CachedTree; };
        if ((autoDiscovery || (treeIds?.length === undefined)) && fullNodeMode) { throw new Error(`auto treeId discovery not supported in fullNodeMode, please provide treeIds to sync. Or turn off fullNodeMode: \`Trees.sync([],{fullNodeMode:false)\``) }
        if (fullNodeMode) {
            syncedTrees = await this.syncTreesStorage(
                treeIds,
                { chunkSize: storageChunkSize, attemptFastSizeMatch, blockNumber }
            )
            // syncing to a specific root is not possible with pure storage, so we sync with storage first
            // then syncTreesEvent will look for the root and try to trim off the leaves that happened after the root we want
            // in tree with only inserts this will work and will allows us to get any tree that is up to 1 year old
            // if there are updates or resets, currently syncTreesEvent will have to go down till it found all leaves
            if (syncToRoot) {
                syncedTrees = await this.syncTreesEvent(
                    treeIds,
                    { attemptFastSizeMatch, syncToRoot, chunkSize: eventChunkSize, insertOnlyTree, autoDiscovery, hasRepeatedLeafs }
                )
            }
        } else {
            syncedTrees = await this.syncTreesEvent(
                treeIds,
                { attemptFastSizeMatch, syncToRoot, chunkSize: eventChunkSize, insertOnlyTree, autoDiscovery, hasRepeatedLeafs }
            )
        }
        return syncedTrees;
    }

    /**
     * Reads trees straight from contract storage, at `blockNumber` (defaults to the safe block).
     *
     * `attemptFastSizeMatch` (default true) bets that the cached tree is still the right *prefix* of the
     * onchain one, so only the difference in size has to be dealt with: read the leaves past the
     * cache's end, or drop the ones past the onchain size. It is a hope, not a promise, so it always
     * ends in a root check — a tree that had an update(), or was reset and regrown with different
     * leaves, fails that check and is re-read in full. Turning it off re-reads every leaf up front.
     */
    async syncTreesStorage(
        treeIds: bigint[] | undefined = undefined,
        { chunkSize = 2000n, attemptFastSizeMatch = true, blockNumber }: { attemptFastSizeMatch?: boolean, chunkSize?: bigint, blockNumber?: bigint } = {}
    ): Promise<{ [treeId: Hex]: CachedTree }> {
        // default syncs all previously synced trees
        treeIds ??= (Object.keys(this.trees) as Hex[]).map((v) => BigInt(v));
        if (treeIds.length === 0) {
            throw new Error(`Nothing to sync. No treeIds in cache and no treeIds provided. Please specify which treeIds to sync. SyncTreesStorage cant automatically find them. If you don't know the treeIds, use syncTreesEvent or maybe the contract using the skinny/fat-imt library if it can provide the treeId.`)
        }
        if (chunkSize <= 0n) {
            throw new Error(`chunkSize has to be at least 1, got: ${chunkSize}`)
        }
        const treeIdsHex = treeIds.map((id) => toHex(id));

        const chainId = await this.publicClient.getChainId();
        const cachedTrees = treeIdsHex.filter((id) => this.trees[id] !== undefined && this.trees[id].tree.size > 0)
        if (attemptFastSizeMatch === false && cachedTrees.length > 0) {
            console.warn(`treeIds:${cachedTrees} where found in cache from a previous sync. But attemptFastSizeMatch=false so this cache is not tried and every leaf is read again. The attempt is checked against the onchain root, so it can't cache a wrong tree, it only costs a re-read when it doesn't hold.`)
        }
        const identifiedTreesEnt = await Promise.all(treeIdsHex.map(async (id) => [id, await this.getTreeType(id, chainId)])) as [Hex, TREE_TYPE][]
        const unsupportedTypes = [TREE_TYPE.NO_INTERFACE, TREE_TYPE.UNKNOWN, TREE_TYPE.SKINNY_EVENT]
        const unsupportedTrees = identifiedTreesEnt.filter(([id, type]) => unsupportedTypes.includes(type))
        if (unsupportedTrees.length > 0) {
            throw new Error(`Some or more unsupported types found. Types not supported are: ${unsupportedTypes.map((t) => TREE_TYPE[t])}, unsupported treeIds found: ${unsupportedTrees.map(([id, type]) => `id:${id},type:${TREE_TYPE[type]}`)}`)
        }

        // prevent re-orgs, get a state at a safe block that requires 2/3 of the stake to re-org
        // a blockNumber from the caller is taken as is: older than head needs an archive node, and
        // newer than safe leaves the re-org risk to whoever asked for that block. Like syncToRoot in
        // syncTreesEvent it can also move a cached tree *backwards*, which the trim below handles.
        blockNumber ??= (await this.publicClient.getBlock({ blockTag: "safe" })).number
        const syncedTrees: { [treeId: Hex]: CachedTree } = {}
        for (const treeId of treeIdsHex) {
            const targetSize = await this.getTreeSizeStorage(treeId, chainId, blockNumber)
            const onchainRoot = await this.getRootStorage(treeId, chainId, blockNumber)
            const cached = this.trees[treeId]
            const cacheSize = BigInt(cached ? cached.tree.size : 0)

            let tree: LeanIMT<bigint> | undefined = undefined
            // leaves the attempt below already read from the contract, covering [readFrom, targetSize).
            // They came from this block, not from the cache, so a failed attempt doesn't invalidate them
            // and the fallback read only has to cover [0, readFrom).
            let freshLeaves: bigint[] = []
            let readFrom = targetSize
            if (attemptFastSizeMatch && cacheSize > 0n) {
                const startTime = performance.now()
                let attempt: LeanIMT<bigint>
                if (cacheSize > targetSize) {
                    // the cache is ahead of the onchain tree: either it was synced to a newer block
                    // than this one, or a reset() happened. Either way the hope is that the leaves it
                    // keeps are the same ones, so only the indexes past targetSize have to go.
                    // @TODO trimming rehashes the whole prefix, LeanIMT can't drop leaves and keep
                    // its internal nodes. Same trade-off syncTreesEvent's trim makes.
                    attempt = new LeanIMT(this.hashFunc, cached.tree.leaves.slice(0, Number(targetSize)))
                } else {
                    // the hope is that the tree only grew, so only the indexes the cache is missing
                    // are read. An update() below cacheSize is invisible here, the root check catches it.
                    // @notice mutates cached.tree, but every path below overwrites the cache entry anyway
                    freshLeaves = await this.readLeavesStorage(treeId, chainId, blockNumber, chunkSize, cacheSize, targetSize)
                    readFrom = cacheSize
                    if (freshLeaves.length > 0) {
                        cached.tree.insertMany(freshLeaves)
                    }
                    attempt = cached.tree
                }
                // an empty LeanIMT has no root, the contract reports 0 for one
                if ((attempt.root ?? 0n) === onchainRoot) {
                    tree = attempt
                } else {
                    // the leaves the cache held were not the onchain ones, so an update(), updateMany()
                    // or a reset() rewrote them. Only the tree build is wasted, the leaves read above
                    // are kept, so the fallback re-reads the cached ones and nothing more.
                    console.warn(`failed fast size match on treeId:${treeId}, wasted ${performance.now() - startTime}ms on a tree build. Falling back to reading the ${readFrom} leaves the cache claimed, reusing the ${freshLeaves.length} already read from the contract.`)
                }
            }

            // attempt failed or was not tried, so read every leaf the attempt didn't already get
            if (tree === undefined) {
                const readLeaves = await this.readLeavesStorage(treeId, chainId, blockNumber, chunkSize, 0n, readFrom)
                tree = new LeanIMT(this.hashFunc, [...readLeaves, ...freshLeaves])
                if ((tree.root ?? 0n) !== onchainRoot) {
                    // every leaf came straight from the contract at this block, so this is not a stale
                    // cache. Drop what's cached for this tree, the attempt above may have grown it.
                    delete this.trees[treeId]
                    throw new Error(`Synced treeId:${treeId} to root:${tree.root ?? 0n} at block:${blockNumber}, but the contract reports root:${onchainRoot} for it. Its leaves and its root disagree, so one of the two reads is not what this lib expects.`)
                }
            }

            this.trees[treeId] = {
                tree: tree,
                type: this.trees[treeId].type, // getTreeType() above put every treeId in the cache
                lastSynced: blockNumber,
                // attemptFastSizeMatch is a guess this sync made, not something it learned about the tree,
                // so whatever is known about updates stays as it was
                insertOnlyTree: this.trees[treeId].insertOnlyTree
            }
            syncedTrees[treeId] = this.trees[treeId]
        }
        return syncedTrees
    }

    /**
     * The leaves of `[startIndex, endIndex)`, read in chunks of `chunkSize`. Same range as
     * {@link Trees#getLeavesStorage}, which does it in a single call, but split up so a big range
     * doesn't have to fit in one eth_call. What the caller does with them (build a tree, grow one)
     * is up to it.
     */
    private async readLeavesStorage(
        treeId: Hex, chainId: number, blockNumber: bigint, chunkSize: bigint, startIndex: bigint, endIndex: bigint
    ): Promise<bigint[]> {
        const leaves: bigint[] = []
        for (let firstIndex = startIndex; firstIndex < endIndex; firstIndex += chunkSize) {
            const lastIndex = minBigInt(firstIndex + chunkSize, endIndex) // lastIndex is exclusive
            leaves.push(...await this.getLeavesStorage(treeId, chainId, firstIndex, lastIndex, blockNumber))
        }
        return leaves
    }

    async syncTreesEvent(treeIds: bigint[] | undefined = undefined, { attemptFastSizeMatch = true, syncToRoot, chunkSize = 2000n, insertOnlyTree, autoDiscovery, hasRepeatedLeafs = true }: { attemptFastSizeMatch?: boolean, syncToRoot?: bigint, chunkSize?: bigint, hasRepeatedLeafs?: boolean, insertOnlyTree?: boolean, autoDiscovery?: boolean | undefined } = {}) {
        treeIds ??= [];
        if (treeIds.length !== 0 && autoDiscovery === true) {
            throw new Error(`TreeIds where provided while autoDiscovery=true. Either turn off autoDiscovery to only sync those specific ids or set treeIds=undefined to automatically discover and sync all treeId.`)
        }
        if (treeIds.length === 0 && autoDiscovery === false) {
            throw new Error(`Please specify which treeIds to sync. Or set autoDiscovery=true`)
        }
        const chainId = await this.publicClient.getChainId()
        const defaultToAutoDiscover = treeIds.length === 0 && autoDiscovery === undefined && syncToRoot === undefined
        const discoverAllIds = treeIds.length === 0 && autoDiscovery === undefined && syncToRoot === undefined || autoDiscovery === true
        if (autoDiscovery && syncToRoot !== undefined) {
            console.warn(`autoDiscovery was set to true, but a root was provided to syncToRoot. This causes the function to run all the way till block: ${getDeploymentBlock(chainId)}, to discover all treeIds. Even if a tree is already found with that root and synced, it will keep going to find another tree with that root. If you intent on only syncing one tree (or known list of ids), please provide them and set autoDiscovery=false.`)
        }
        if (defaultToAutoDiscover) {
            console.warn(`No treeIds provided for event sync, defaulting to autoDiscovery of all treeIds. This will run all the way till block: ${getDeploymentBlock(chainId)}, to discover all treeIds. If this intended you can safely ignore this warning or silence it by setting autoDiscovery=true. If you intent on only syncing one or a set of treeIds, please provide them to speed up syncing.`)
        }

        // sync backwards, sync every NewLeaf, UpdatedLeaf, RepeatedLeafs, event
        const newestBlock = (await this.publicClient.getBlock({ blockTag: 'safe' })).number
        // in discovery we go all the way down, if treeIds are provided, we go down till all them are synced
        // if all of them are synced before, we don't sync all leaves, just those who happened after the most out of date tree was synced at
        // when looking for a specific root we need to also go down to the lowest block since the root might be older then the last sync
        const oldestBlock = discoverAllIds || syncToRoot ? BigInt(getDeploymentBlock(chainId)) : this.getOldestSyncBlock(treeIds)

        const syncState: SyncState = { treeCache: this.trees, treeState: {}, lastBlockSynced: newestBlock, unsyncedIds: new Set(treeIds.map((id) => toHex(id))) }

        const insertEvents = hasRepeatedLeafs ? ["NewLeaf", "RepeatedLeafs"] as const : ["NewLeaf"] as const;
        const leafEvents = insertOnlyTree ? insertEvents : ["UpdatedLeaf", ...insertEvents] as const
        do {
            const foundAllRoots = syncState.unsyncedIds.size === 0 && syncToRoot === undefined && discoverAllIds == false
            await queryMultiEventsInChunks({
                publicClient: this.publicClient,
                contract: await this.getContract(),
                eventNames: foundAllRoots ? leafEvents : ["NewRoot", ...leafEvents],
                // only our treeIds. treeId is the 1st indexed param of NewRoot, an array means "any of these"
                sharedEventFilterArgs: discoverAllIds ? undefined : { treeId: [...syncState.unsyncedIds].map((id) => BigInt(id)) },
                firstBlock: oldestBlock,
                lastBlock: syncState.lastBlockSynced,
                reverseOrder: true,
                maxEvents: Infinity,
                chunkSize: chunkSize,
                // if we need all treeIds?
                postQueryFilter: getEventFilter(oldestBlock, syncState, { hashFunc: this.hashFunc, attemptFastSizeMatch: attemptFastSizeMatch, autoDiscover: discoverAllIds, syncToRoot: syncToRoot })
            })
        } while (syncState.unsyncedIds.size > 0 && syncState.lastBlockSynced > oldestBlock)

        // cache the tree, or update the new/updated leafs of an existing cache tree.
        const syncedTrees: { [treeId: Hex]: CachedTree } = {}
        const allTreeIds = new Set([...treeIds.map((id) => toHex(id)), ...Object.keys(syncState.treeState) as Hex[]])
        for (const treeId of allTreeIds) {
            const newSyncState = syncState.treeState[treeId]
            const cacheTree = this.trees[treeId];

            const isNotOld = cacheTree === undefined
                || (newSyncState !== undefined && newSyncState.lastSynced >= cacheTree.lastSynced)

            // no-op, no new state and no rollback (syncToRoot on old root can be used to go back to a older root)
            if (isNotOld === false && syncToRoot === undefined) {
                syncedTrees[treeId] = cacheTree
                continue
            }

            const canMerge = newSyncState !== undefined && cacheTree !== undefined && isNotOld
                && BigInt(cacheTree.tree.size) <= newSyncState.targetSize


            if (newSyncState !== undefined && newSyncState.tree === undefined) {
                const targetSize = Number(newSyncState.targetSize)
                const missing: number[] = []
                for (let index = canMerge ? cacheTree.tree.size : 0; index < targetSize; index++) {
                    if (newSyncState.leaves[index] === undefined) {
                        missing.push(index)
                        break
                    }
                }
                if (missing.length > 0) {
                    throw new Error(
                        `Incomplete sync of treeId:${treeId}. Root ${toHex(newSyncState.expectedRoot)} has ${targetSize} leaves, ` +
                        `but no event was found indexes ${missing}. Possible causes: hasRepeatedLeafs:false, ` +
                        `insertOnlyTree:true, a scan that did not reach far enough back (it started at block ${oldestBlock}), ` +
                        `or a contract that does not emit an event for every leaf it stores.`
                    )
                }
            }

            let synced: CachedTree
            if (newSyncState?.tree !== undefined) {
                // attemptFastSizeMatch was success full by trimming of leaves of the pre-existing cache tree.
                // that caused a tree to already be built and checked so we can just use that rn.
                // it's also almost always a rollback so we should not store in cache
                // (almost always rollback, it could be that a reset happened, and just happens to have the same leaves as the previous tree but smaller size)
                synced = {
                    tree: newSyncState.tree,
                    type: cacheTree!.type,
                    lastSynced: newSyncState.lastSynced,
                    insertOnlyTree: cacheTree!.insertOnlyTree
                }
            } else if (canMerge) {
                // @notice mutates the cached tree in place, so `synced` *is* the cache entry and the
                // isNotOld check below can no longer keep it out. See canMerge above.
                const updatedIndexes: number[] = [];
                const updatedLeaves: bigint[] = [];
                const newLeafs: bigint[] = [];
                newSyncState.leaves.forEach((leaf, index) => {
                    if (index < cacheTree.tree.size) {
                        updatedLeaves.push(leaf)
                        updatedIndexes.push(index)
                    } else {
                        newLeafs.push(leaf)
                    }
                })
                cacheTree.tree.updateMany(updatedIndexes, updatedLeaves)
                if (newLeafs.length > 0) {
                    cacheTree.tree.insertMany(newLeafs)
                }

                cacheTree.lastSynced = newSyncState.lastSynced
                synced = cacheTree
            } else {
                // cached tree does not exist or synced tree is smaller and newSyncState.leaves is complete
                synced = {
                    tree: new LeanIMT(this.hashFunc, newSyncState ? newSyncState.leaves : []),
                    type: cacheTree ? cacheTree.type : await identifyTree(BigInt(treeId), this.contract),
                    lastSynced: newSyncState?.lastSynced ? newSyncState.lastSynced : 0n,
                    // what the caller claims about this sync, falling back to whatever was known before
                    insertOnlyTree: insertOnlyTree ?? cacheTree?.insertOnlyTree
                }
            }

            if (newSyncState !== undefined && (synced.tree.root ?? 0n) !== newSyncState.expectedRoot) {
                throw new Error(`syncing failed, expected root:${toHex(newSyncState.expectedRoot)} but got ${toHex(synced.tree.root ?? 0n)}`)
            }

            // a sync may only ever move the cache forward. A syncToRoot rollback is handed to the
            // caller, but the cache keeps the newer tree it already had.
            if (isNotOld) {
                this.trees[treeId] = synced
            }
            syncedTrees[treeId] = synced;
        }

        if (syncToRoot !== undefined) {
            const treeIdsWithNoRoot = Object.keys(syncedTrees).filter((id) => syncedTrees[id as Hex].tree.root !== syncToRoot) as Hex[]
            const allTreeIds = Object.keys(syncedTrees)
            if (treeIdsWithNoRoot.length > 0) {
                if (allTreeIds.length === treeIdsWithNoRoot.length) {
                    throw new Error(`Root: ${syncToRoot} was never found for all treeIds: ${Object.keys(syncedTrees)}`)
                } else {
                    const foundTreeIds = allTreeIds.filter((id) => treeIdsWithNoRoot.includes(id as Hex));
                    console.warn(
                        `Root: ${syncToRoot} was never found for some treeIds: ${treeIdsWithNoRoot}. But was found for ${foundTreeIds})`
                    )
                    treeIdsWithNoRoot.forEach((id) => delete syncedTrees[id])
                }
            }
        }
        return syncedTrees;
    }

    async getContract(): Promise<ReadableContract> {
        if (this.contract) {
            return this.contract
        } else {
            //[skinnyStorage, skinnyEvent, fatStorage, fatEvent]
            const interfaceSupports = await Promise.all([
                ERC165_IDS.skinnyStorage, ERC165_IDS.skinnyEvent, ERC165_IDS.fatStorage, ERC165_IDS.fatEvent
            ].map((id) => supportsInterface(this.publicClient, this.contractAddress, id)))
            const abis = [skinnyStorageAbi, skinnyEventAbi, fatStorageAbi, fatEventAbi]

            const unionAbi = abis.filter((abi, i) => interfaceSupports[i]).flat()
            this.contract = getContract({
                address: this.contractAddress,
                client: this.publicClient,
                abi: [...unionAbi, ...IIMTEventsArtifact.abi],
                // yeah no amount of type juggling will be able to deal with these crazy union types.
            }) as unknown as ReadableContract
            return this.contract
        }
    }

    getOldestSyncTreeId(treeIds: Hex[]): Hex {
        let oldest = treeIds[0];
        let oldestBlock = 2n ** 256n; // Infinity replacement
        for (const id of treeIds) {
            const tree = this.trees[id]
            if (tree === undefined) {
                return id
            }
            if (tree.lastSynced < oldestBlock) {
                oldestBlock = tree.lastSynced
                oldest = id
            }
        }
        return oldest
    }

    getOldestSyncBlock(treeIds: bigint[]) {
        const oldestTree = this.trees[this.getOldestSyncTreeId(treeIds.map((id) => toHex(id)))]
        return oldestTree ? oldestTree.lastSynced : 0n
    }

    async getTreeType(treeId: Hex, chainId: number) {
        return (await this.initTree(treeId, chainId)).type
    }

    async getLeavesStorage(treeId: Hex, chainId: number, startIndex: bigint, endIndex: bigint, blockNumber: bigint) {
        const size = await this.getTreeSizeStorage(treeId, chainId, blockNumber)
        if (startIndex > endIndex || endIndex > size) {
            throw new Error(`Leaf range [${startIndex}, ${endIndex}) is out of range for treeId:${treeId}, which holds ${size} leaves at block:${blockNumber}.`)
        }
        const treeType = (await this.initTree(treeId, chainId)).type
        const contract = await this.getContract()
        switch (treeType) {
            case TREE_TYPE.SKINNY_STORAGE:
                // TODO debug_storageRange at for these 2 but not FAT_EVENT
                return await (contract as any as ReadableContractSkinnyStorage).read.getSkinnyLeaves([BigInt(treeId), startIndex, endIndex], { blockNumber: blockNumber })
                break;
            case TREE_TYPE.FAT_STORAGE:
                return await (contract as any as ReadableContractFatStorage).read.getFatLeaves([BigInt(treeId), startIndex, endIndex], { blockNumber: blockNumber })
                break;
            case TREE_TYPE.FAT_EVENT:
                return await (contract as any as ReadableContractFatEvent).read.getFatLeaves([BigInt(treeId), startIndex, endIndex], { blockNumber: blockNumber })
                break;
            default:
                throw new Error(`treeId ${treeId} has type: ${TREE_TYPE[treeType]} which is not supported`)
                break;
        }
    }

    async getTreeSizeStorage(treeId: Hex, chainId: number, blockNumber: bigint) {
        const cachedSize = this.sizes[treeId]
        if (cachedSize !== undefined && cachedSize.blockNumber === blockNumber) {
            return cachedSize.size
        }
        const treeType = (await this.initTree(treeId, chainId)).type
        const contract = await this.getContract()
        let size: bigint
        switch (treeType) {
            case TREE_TYPE.SKINNY_STORAGE:
            case TREE_TYPE.SKINNY_EVENT:
                size = await (contract as any as ReadableContractSkinnyEvent).read.getSkinnySize([BigInt(treeId)], { blockNumber: blockNumber })
                break;
            case TREE_TYPE.FAT_STORAGE:
            case TREE_TYPE.FAT_EVENT:
                size = await (contract as any as ReadableContractFatEvent).read.getFatSize([BigInt(treeId)], { blockNumber: blockNumber })
                break;
            default:
                throw new Error(`treeId ${treeId} has type: ${TREE_TYPE[treeType]} which is not supported`)
        }
        this.sizes[treeId] = { blockNumber: blockNumber, size: size }
        return size
    }

    async getRootStorage(treeId: Hex, chainId: number, blockNumber: bigint) {
        const treeType = (await this.initTree(treeId, chainId)).type
        const contract = await this.getContract()
        switch (treeType) {
            case TREE_TYPE.SKINNY_STORAGE:
            case TREE_TYPE.SKINNY_EVENT:
                return await (contract as any as ReadableContractSkinnyEvent).read.getSkinnyRoot([BigInt(treeId)], { blockNumber: blockNumber })
            case TREE_TYPE.FAT_STORAGE:
            case TREE_TYPE.FAT_EVENT:
                return await (contract as any as ReadableContractFatEvent).read.getFatRoot([BigInt(treeId)], { blockNumber: blockNumber })
            default:
                throw new Error(`treeId ${treeId} has type: ${TREE_TYPE[treeType]} which is not supported`)
        }
    }

    async initTree(treeId: Hex, chainId: number) {
        if (this.trees[treeId]) {
            return this.trees[treeId]
        }
        const treeType = await identifyTree(BigInt(treeId), await this.getContract());
        this.trees[treeId] = {
            tree: new LeanIMT(this.hashFunc),
            type: treeType,
            lastSynced: BigInt(getDeploymentBlock(chainId))
        }
        return this.trees[treeId]
    }
}

export async function identifyTree(
    treeId: bigint,
    contract: AnyContract,
) {
    // TODO we can dish out these calls concurrently. but storage always > event, remember storage inherits event!!
    let skinnyStorageProm, skinnyEventProm, fatStorageProm, fatEventProm
    const differentiatingFunctions = ["getSkinnyLeavesBaseSlot", "getSkinnySize", "getFatLeavesBaseSlot", "getFatSize"]
    const contractFunctions = contract.abi.filter((abi) => abi.type === "function" && "name" in abi && differentiatingFunctions.includes(abi.name)).map((abi) => (abi as any).name)
    if (contractFunctions.length === 0) {
        // is okay we can still look for events! SkinnyEvent interface is not even use full while syncing, since we 
        // need events to get the leaves anyway. 
        // TODO we cant deal with NO_INTERFACE case rn because storage emits both repeatedLeaves and newLeaf which is double
        // prob not really a problem?
        return TREE_TYPE.NO_INTERFACE;
    }
    if (contractFunctions.includes("getSkinnyLeavesBaseSlot")) {
        skinnyStorageProm = contract.read.getSkinnyLeavesBaseSlot([treeId])
    }
    if (contractFunctions.includes("getSkinnySize")) {
        skinnyEventProm = (contract as unknown as ReadableContractSkinnyEvent).read.getSkinnySize([treeId])
    }
    if (contractFunctions.includes("getFatLeavesBaseSlot")) {
        fatStorageProm = (contract as unknown as ReadableContractFatStorage).read.getFatLeavesBaseSlot([treeId])
    }
    if (contractFunctions.includes("getFatSize")) {
        fatEventProm = (contract as unknown as ReadableContractFatEvent).read.getFatSize([treeId])
    }


    // @notice storage needs to come first in the arr, since both storage and event resolve if a tree type == STORAGE
    const proms = [skinnyStorageProm, skinnyEventProm, fatStorageProm, fatEventProm]
    const settled = await Promise.allSettled(proms);
    const types = [TREE_TYPE.SKINNY_STORAGE, TREE_TYPE.SKINNY_EVENT, TREE_TYPE.FAT_STORAGE, TREE_TYPE.FAT_EVENT]
    for (let index = 0; index < settled.length; index++) {
        // proms[index] guard: undefined entries (interface absent) become fulfilled in allSettled
        if (proms[index] !== undefined && settled[index].status == "fulfilled") {
            return types[index]
        }
    }

    // usually un-initialized or does not exist
    return TREE_TYPE.UNKNOWN
}

type SyncState = {
    lastBlockSynced: bigint, unsyncedIds: Set<Hex>,
    treeCache: { [treeId: Hex]: CachedTree },
    treeState: { [treeId: Hex]: { expectedRoot: bigint, tree?: LeanIMT<bigint>, leaves: bigint[], count: bigint, targetSize: bigint, lastSynced: bigint } }
}

type IMTEventFilter = PostQueryEventFilter<ReadableEvent<"NewRoot" | "NewLeaf" | "UpdatedLeaf" | "RepeatedLeafs">>
export function getEventFilter(
    firstBlock: bigint, syncState: SyncState,
    { autoDiscover, syncToRoot, attemptFastSizeMatch, hashFunc = LeanIMTHashFuncPoseidon2 }: { hashFunc?: LeanIMTHashFunction, attemptFastSizeMatch?: boolean, autoDiscover?: boolean, syncToRoot?: bigint } = {}
) {
    const quitEarly: IMTEventFilter = (allEvents, chunkEvents, chunkStart, chunkEnd) => {
        let quit = false;
        for (const event of chunkEvents.toReversed()) {
            const treeId = toHex(event.args.treeId);
            // have we found our NewRoot event yet?
            if (syncState.treeState[treeId] === undefined) {
                if (event.eventName === "NewRoot") {
                    if (syncToRoot === undefined || syncToRoot === event.args.root) {
                        //TODO in case that syncToRoot is provided, check the tree in cache, if size >= as root says we need.
                        // trim of excess leaves and check if root is already correct.
                        // this allows us to quit very early on insert only trees or ones with update if we are lucky no update happened
                        const simpleTrim = attemptFastSizeMatch && syncState.treeCache[treeId]?.tree.size > event.args.size
                        if (simpleTrim) {
                            const trimmed = syncState.treeCache[treeId]?.tree.leaves.slice(0, Number(event.args.size))
                            const startTime = performance.now();
                            const trimmedTree = new LeanIMT(hashFunc, trimmed);
                            const endTime = performance.now();
                            if (event.args.root === trimmedTree.root) {
                                console.log(`success full trim on treeId: ${treeId}`)
                                syncState.treeState[treeId] = {
                                    leaves: [],
                                    count: 0n,
                                    targetSize: event.args.size,
                                    lastSynced: event.blockNumber - 1n, // 2 roots can be in one block, so -1 to be safe
                                    tree: trimmedTree,
                                    expectedRoot: event.args.root
                                }
                                syncState.unsyncedIds.delete(treeId);
                                quit = true;
                                continue
                            } else {
                                console.warn(`failed trim, wasted ${endTime - startTime}ms on tree build`)
                                // console.warn(`Rolling back to root: ${toHex(event.args.root)} failed. Likely because a tree reset or update happened. If that is true, you can safely ignore this warning. TODO optimize this`)
                                //TODO: the entire tree was rebuilt here, just to fail. For a future re-write of a more scalable LeanIMTjs, make it so it can trim leaves, while re-using the internal nodes so rehashing is not needed for all.`)
                            }
                        }
                        syncState.treeState[treeId] = {
                            leaves: [],
                            count: 0n,
                            targetSize: event.args.size,
                            lastSynced: event.blockNumber - 1n, // 2 roots can be in one block, so -1 to be safe
                            tree: undefined,
                            expectedRoot: event.args.root
                        }
                    }
                }
                // we have found a NewRoot, or our specific new root if syncToRoot was set
                // so syncState[treeId] contains something now
            } else {
                const tree = syncState.treeState[treeId]
                if (tree.count === tree.targetSize || syncState.treeState[treeId].tree) {
                    syncState.unsyncedIds.delete(treeId);
                    quit = true;
                    continue
                }
                if (event.eventName === "RepeatedLeafs") {
                    const start = Number(event.args.startIndex) // startIndex == inclusive, index = start is correct
                    const end = Number(event.args.nextIndex) // nextIndex == exclusive, so index < end is correct here
                    for (let index = start; index < end; index++) {
                        if (tree.leaves[index] === undefined) {
                            tree.leaves[index] = event.args.leaf;
                            tree.count++;
                        }
                    }
                } else if (event.eventName !== "NewRoot") {
                    const leafIndex = Number(event.args.index)
                    if (tree.leaves[leafIndex] === undefined) {
                        if (event.eventName === "NewLeaf") {
                            // @TODO this is not super scalable, but realistically on L1 you wont really hit numbers high
                            // enough, besides LeanIMT-js uses normal js arrays indexed by numbers so that is the first one to fail
                            // also due to ram usage
                            tree.leaves[leafIndex] = event.args.leaf
                            tree.count++;
                        } else {
                            // if (event.eventName === "UpdatedLeaf")
                            tree.leaves[leafIndex] = event.args.newLeaf;
                            tree.count++;
                        }
                    }
                }
            }
        }
        // we process all events on every chunk right away, we don't need allEvents, so just discard all events to save memory
        // [allEvents, quit]
        // `startBlock === firstBlock` <= detects, "is last chunk", assumes scanning backwards
        if (quit || chunkStart === firstBlock) {
            syncState.lastBlockSynced = chunkStart
        }

        return [[], quit]
    }
    if (autoDiscover) {
        const quitAtEnd: IMTEventFilter = (allEvents, chunkEvents, chunkStart, chunkEnd) => { quitEarly(allEvents, chunkEvents, chunkStart, chunkEnd); return [[], false] };
        return quitAtEnd
    } else {
        return quitEarly
    }
}


