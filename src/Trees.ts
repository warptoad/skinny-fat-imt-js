import { LeanIMT, type LeanIMTHashFunction } from "@zk-kit/lean-imt";
import { poseidon2Hash } from "@zkpassport/poseidon2";
import { getContract, toHex, type Abi, type AbiEvent, type Address, type GetContractReturnType, type Hex, type Log, type PublicClient, type WalletClient } from "viem";

import { getInterfaceId, detectSupportedInterfaces, supportsInterface } from "./interfaceId.js";

import { queryEventInChunks, queryMultiEventsInChunks, type EventLog, type PostQueryEventFilter } from "./eventScanning.js";

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
import { DEPLOY_BLOCK } from "./config.js";

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
    FAT_STORAGE,
    FAT_EVENT,
    SKINNY_STORAGE,
    SKINNY_EVENT,
    UNKNOWN,
    NO_INTERFACE
}

export const LeanIMTHashFuncPoseidon2: LeanIMTHashFunction = (a: bigint, b: bigint) => poseidon2Hash([a, b])

export class Trees {
    private trees: { [treeId: Hex]: { tree: LeanIMT<bigint>, type: TREE_TYPE } } = {}

    public contractAddress: Address;
    public contract!: ReadableContract;
    public hashFunc: LeanIMTHashFunction;
    private publicClient: PublicClient;

    constructor(contractAddress: Address, client: PublicClient, hashFunc = LeanIMTHashFuncPoseidon2) {
        this.contractAddress = contractAddress
        this.publicClient = client
        this.hashFunc = hashFunc;
    }

    /**
     *
     * @param treeIds what treeIds to sync, leave empty to auto discover and sync all (archive node only)
     */
    async sync(treeIds: Hex[] = []) {

    }

    async syncTreesStorage(treeIds: bigint[]) {
    }

    async syncTreesEvent(treeIds: bigint[] = [], chunkSize = 2000n) {
        const syncAllIds = treeIds.length === 0
        const chainId = await this.publicClient.getChainId()
        if (syncAllIds) {
            console.warn(`No treeIds provided for event sync, scan will run all the way till block: ${DEPLOY_BLOCK[chainId]}, to auto discover all treeIds.`)
        }
        // sync backwards, sync every NewLeaf, UpdatedLeaf, RepeatedLeafs, TreeReset, event
        const safeBlockNum = (await this.publicClient.getBlock({ blockTag: 'safe' })).number


        const treesAndLeaves: { [treeId: Hex]: { leaves: bigint[], count: bigint, targetSize: bigint } } = {}
        let unsyncedTreesIds = new Set(treeIds.map((id) => toHex(id)));
        // at each chunk scanned, check if at least one tree is done syncing and exit early, so we can remove that tree
        // from the list
        const geLeavesQuitEarly: PostQueryEventFilter<ReadableEvent<"NewRoot" | "NewLeaf" | "UpdatedLeaf" | "RepeatedLeafs">> = (allEvents, chunkEvents) => {
            let quit = false;
            for (const event of chunkEvents.toReversed()) {
                const treeId = toHex(event.args.treeId);
                if (event.eventName === "NewRoot") {
                    if (treesAndLeaves[treeId] === undefined) {
                        treesAndLeaves[treeId] = {
                            leaves: [],
                            count: 0n,
                            targetSize: event.args.size,
                        }
                    }
                } else {
                    const tree = treesAndLeaves[treeId]
                    if (tree.count >= tree.targetSize) {
                        // this treeId is already synced, don't touch it
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
                    } else {
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

                    if (tree.count >= tree.targetSize) {
                        unsyncedTreesIds.delete(treeId);
                        quit = true;
                    }
                }
            }
            return [allEvents, quit]
        }

        const geLeavesQuitNever: PostQueryEventFilter<ReadableEvent<"NewRoot" | "NewLeaf" | "UpdatedLeaf" | "RepeatedLeafs">> = (allEvents, chunkEvents) => {
            geLeavesQuitEarly(allEvents, chunkEvents);
            return [allEvents, false]
        }

        do {
            await queryMultiEventsInChunks({
                publicClient: this.publicClient,
                contract: await this.getContract(),
                eventNames: ["NewRoot", "NewLeaf", "UpdatedLeaf", "RepeatedLeafs"],
                // only our treeIds. treeId is the 1st indexed param of NewRoot, an array means "any of these"
                sharedEventFilterArgs: syncAllIds ? undefined : { treeId: [...unsyncedTreesIds].map((id) => BigInt(id)) },
                firstBlock: BigInt(DEPLOY_BLOCK[chainId]),
                lastBlock: safeBlockNum,
                reverseOrder: true,
                maxEvents: Infinity,
                chunkSize: chunkSize,
                // if we need all treeIds?
                postQueryFilter: syncAllIds ? geLeavesQuitNever : geLeavesQuitEarly,
            })
            console.log({ treesAndLeaves })
        } while (unsyncedTreesIds.size > 0)

        const leanIMTTrees: { [treeId: Hex]: LeanIMT<bigint> } = {}
        for (const [treeId, tree] of Object.entries(treesAndLeaves)) {
            leanIMTTrees[treeId as Hex] = new LeanIMT(this.hashFunc, tree.leaves)
        }
        return leanIMTTrees;
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

    async initTree(treeId: Hex, hashFunc: LeanIMTHashFunction) {
        const treeType = await identifyTree(BigInt(treeId), await this.getContract());
        this.trees[treeId] = {
            tree: new LeanIMT(this.hashFunc),
            type: treeType
        }
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

