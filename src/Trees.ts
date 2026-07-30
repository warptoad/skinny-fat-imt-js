import { LeanIMT, type LeanIMTHashFunction } from "@zk-kit/lean-imt";
import { poseidon2Hash } from "@zkpassport/poseidon2";
import { getContract, type Abi, type Address, type GetContractReturnType, type Hex, type PublicClient } from "viem";
import { queryEventInChunks } from "@warptoad/gigabridge-js/viem-utils"

import { getInterfaceId, detectSupportedInterfaces, supportsInterface } from "./interfaceId.js";

import type { SkinnyIMTReadableStorage$Type } from "../artifacts/@warptoad/skinny-imt.sol/SkinnyIMTReadableStorage.sol/artifacts.js";
import type { SkinnyIMTReadableEvent$Type } from "../artifacts/@warptoad/skinny-imt.sol/SkinnyIMTReadableEvent.sol/artifacts.js";
import type { FatIMTReadableStorage$Type } from "../artifacts/@warptoad/fat-imt.sol/FatIMTReadableStorage.sol/artifacts.js";
import type { FatIMTReadableEvent$Type } from "../artifacts/@warptoad/fat-imt.sol/FatIMTReadableEvent.sol/artifacts.js";

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
import fatEventArtifact from "../artifacts/@warptoad/fat-imt.sol/FatIMTReadableEvent.sol/FatIMTReadableEvent.json" with { type: "json" };

type ReadableStorageAbi = readonly [
    ...SkinnyIMTReadableStorage$Type["abi"],
    ...FatIMTReadableStorage$Type["abi"],
];

type ReadableEventAbi = readonly [
    ...FatIMTReadableEvent$Type["abi"],
    ...SkinnyIMTReadableEvent$Type["abi"],
]

type ReadableAbi = readonly [...ReadableStorageAbi, ...ReadableEventAbi]


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
    SKINNY_STORAGE,
    SKINNY_EVENT,
    FAT_STORAGE,
    FAT_EVENT
}

export const LeanIMTHashFuncPoseidon2:LeanIMTHashFunction = (a:bigint,b:bigint)=>poseidon2Hash([a,b])

export class Trees {
    private trees: { [treeId: Hex]: { tree: LeanIMT<bigint>, type: TREE_TYPE } } = {}

    public contractAddress: Address;
    public contract!: ReadableContract;
    public hashFunc: LeanIMTHashFunction;
    private publicClient: PublicClient;

    constructor(contractAddress: Address, client: PublicClient, hashFunc=LeanIMTHashFuncPoseidon2) {
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

    /**
     *
     * @param treeIds what treeIds to to init with, leave empty to only init trees object
     */
    async getContract():Promise<ReadableContract> {
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
                abi: unionAbi,
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

async function identifyTree(
    treeId: bigint,
    contract: ReadableContract,
) {
    // TODO we can dish out these calls concurrently. but storage always > event, remember storage inherits event!!
    let skinnyStorageProm, skinnyEventProm, fatStorageProm, fatEventProm
    if ("getSkinnyLeavesBaseSlot" in contract.read) {
        skinnyStorageProm = contract.read.getSkinnyLeavesBaseSlot([treeId])
    }
    if ("getSkinnySize" in contract.read) {
        skinnyEventProm = contract.read.getSkinnySize([treeId])
    }

    if ("getFatLeavesBaseSlot" in contract.read) {
        fatStorageProm = contract.read.getFatLeavesBaseSlot([treeId])
    }
    if ("getFatSize" in contract.read) {
        fatEventProm = contract.read.getFatSize([treeId])
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
    // but could also be that the contract does not support the interface, at that point we just treat it as a generic event type to sync
    return TREE_TYPE.UNKNOWN
}

