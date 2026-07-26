// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// TODO FatIMTData exported in FatIMTPoseidon2WriteFullNode?
// TODO Drop the node it's cleaner
import {FatIMTPoseidon2WriteStorage, FatIMTDataStorage} from "@warptoad/fat-imt.sol/poseidon2/FatIMTPoseidon2WriteStorage.sol";
import {FatIMTReadableStorage} from "@warptoad/fat-imt.sol/FatIMTReadableStorage.sol";

// TODO FatIMTData -> FatIMTDataEvent
import {FatIMTPoseidon2WriteEvent, FatIMTDataEvent} from "@warptoad/fat-imt.sol/poseidon2/FatIMTPoseidon2WriteEvent.sol";
import {FatIMTReadableEvent} from "@warptoad/fat-imt.sol/FatIMTReadableEvent.sol";

import {SkinnyIMTPoseidon2WriteStorage, SkinnyIMTDataStorage} from "@warptoad/skinny-imt.sol/poseidon2/SkinnyIMTPoseidon2WriteStorage.sol";
import {SkinnyIMTReadableStorage} from "@warptoad/skinny-imt.sol/SkinnyIMTReadableStorage.sol";

import {SkinnyIMTPoseidon2WriteEvent, SkinnyIMTDataEvent} from "@warptoad/skinny-imt.sol/poseidon2/SkinnyIMTPoseidon2WriteEvent.sol";
import {SkinnyIMTDataEvent} from "@warptoad/skinny-imt.sol/InternalSkinnyIMTEvent.sol";
import {SkinnyIMTReadableEvent} from "@warptoad/skinny-imt.sol/SkinnyIMTReadableEvent.sol";

error WrongTreeId();
// TODO nice to have also in the package, but zk-kit structure clashes, so maybe skinny-fat as one package?
enum TreeType {
    SKINNY_STORAGE,
    SKINNY_EVENT,
    FAT_STORAGE,
    FAT_EVENT
}

contract SkinnyFatFullNode is SkinnyIMTReadableStorage, FatIMTReadableStorage {
    //mapping(uint256 => FatIMTDataStorage) fatStorageTrees;
    FatIMTDataStorage[] fatStorageTrees;
    FatIMTDataEvent[] fatEventTrees;

    SkinnyIMTDataStorage[] skinnyStorageTrees;
    SkinnyIMTDataEvent[] skinnyEventTrees;

    mapping(uint256 => TreeType) treeTypes;
    // you cant really store tree[treeId], since you are now allowed to assign a struct that has a mapping inside of it, to a mapping
    // so we just resolve treeId => index of a array. then just do treeArray[index]. (in one line: `treeArray[indexOfTreeId[treeId]]`)
    mapping(uint256 => uint256) indexOfTreeId;

    constructor() {
        FatIMTDataStorage storage fatStorageTree = fatStorageTrees.push();
        uint256 fatStorageTreeId = FatIMTPoseidon2WriteStorage.init(
            fatStorageTree
        );
        treeTypes[fatStorageTreeId] = TreeType.FAT_STORAGE;
        indexOfTreeId[fatStorageTrees.length - 1] = fatStorageTreeId;

        FatIMTDataEvent storage fatEventTree = fatEventTrees.push();
        uint256 fatEventTreeId = FatIMTPoseidon2WriteEvent.init(
            fatEventTree
        );
        treeTypes[fatEventTreeId] = TreeType.FAT_EVENT;
        indexOfTreeId[fatEventTrees.length - 1] = fatEventTreeId;

        SkinnyIMTDataStorage storage skinnyStorageTree = skinnyStorageTrees.push();
        uint256 skinnyStorageTreeId = SkinnyIMTPoseidon2WriteStorage.init(
            skinnyStorageTree
        );
        treeTypes[skinnyStorageTreeId] = TreeType.SKINNY_STORAGE;
        indexOfTreeId[skinnyStorageTrees.length - 1] = skinnyStorageTreeId;

        SkinnyIMTDataEvent storage skinnyEventTree = skinnyEventTrees.push();
        uint256 skinnyEventTreeId = SkinnyIMTPoseidon2WriteEvent.init(
            skinnyEventTree
        );
        treeTypes[skinnyEventTreeId] = TreeType.SKINNY_EVENT;
        indexOfTreeId[skinnyEventTrees.length - 1] = skinnyEventTreeId;
    }

    // overridable functions so SkinnyIMTFullNodeReadable and SkinnyIMTDataFullNode
    // can find out where the tree is stored so it can expose a interface to get the leaves and storage slot for debug_getStorageRangeAt
    function _getFatStorageTree(
        uint256 //treeId, only one tree so no need for treeId for looking up a mapping for example
    ) internal view virtual override returns (FatIMTDataStorage storage) {
        return fatStorageTrees[0];
    }

    // if you'r only using the storage variant, no need to override this SkinnyIMTReadableStorage just passes treeStorage.treeData along
    // if you use both tho do override like this!!
    // if you got more trees. You can store them in a mapping like this
    function _getSkinnyEventTree(
        uint256 treeId
    ) internal view virtual override returns (SkinnyIMTDataEvent storage) {
        if (treeTypes[treeId] == TreeType.SKINNY_STORAGE) {
            return skinnyStorageTrees[indexOfTreeId[treeId]].treeData;
        } else if (treeTypes[treeId] == TreeType.SKINNY_EVENT) {
            return skinnyEventTrees[indexOfTreeId[treeId]];
        } else {
            revert WrongTreeId();
        }
    }

    // overridable functions so SkinnyIMTFullNodeReadable and SkinnyIMTDataFullNode
    // can find out where the tree is stored so it can expose a interface to get the leaves and storage slot for debug_getStorageRangeAt
    function _getSkinnyStorageTree(
        uint256 //treeId
    ) internal view virtual override returns (SkinnyIMTDataStorage storage) {
        return skinnyStorageTrees[0];
    }

    function _getFatEventTree(
        uint256 treeId
    ) internal view virtual override returns (FatIMTDataEvent storage) {
        if (treeTypes[treeId] == TreeType.FAT_STORAGE) {
            return fatStorageTrees[indexOfTreeId[treeId]].treeData;
        } else if (treeTypes[treeId] == TreeType.FAT_EVENT) {
            return fatEventTrees[indexOfTreeId[treeId]];
        } else {
            revert WrongTreeId();
        }
    }

    function reset() public {
        FatIMTPoseidon2WriteStorage.reset(fatStorageTrees[0]);
        SkinnyIMTPoseidon2WriteStorage.reset(skinnyStorageTrees[0]);

        FatIMTPoseidon2WriteEvent.reset(fatEventTrees[0]);
        SkinnyIMTPoseidon2WriteEvent.reset(skinnyEventTrees[0]);
    }

    function insert(uint256 leaf) public {
        FatIMTPoseidon2WriteStorage.insert(fatStorageTrees[0], leaf);
        SkinnyIMTPoseidon2WriteStorage.insert(skinnyStorageTrees[0], leaf);

        FatIMTPoseidon2WriteEvent.insert(fatEventTrees[0], leaf);
        SkinnyIMTPoseidon2WriteEvent.insert(skinnyEventTrees[0], leaf);
    }

    function insertMany(uint256[] calldata leaves) public {
        FatIMTPoseidon2WriteStorage.insertMany(fatStorageTrees[0], leaves);
        SkinnyIMTPoseidon2WriteStorage.insertMany(skinnyStorageTrees[0], leaves);
        FatIMTPoseidon2WriteEvent.insertMany(fatEventTrees[0], leaves);
        SkinnyIMTPoseidon2WriteEvent.insertMany(skinnyEventTrees[0], leaves);
    }

    function insertManyRepeated(uint256 value, uint256 amount) public {
        FatIMTPoseidon2WriteStorage.insertManyRepeated(
            fatStorageTrees[0],
            value,
            amount
        );
        SkinnyIMTPoseidon2WriteStorage.insertManyRepeated(
            skinnyStorageTrees[0],
            value,
            amount
        );

        FatIMTPoseidon2WriteEvent.insertManyRepeated(
            fatEventTrees[0],
            value,
            amount
        );
        SkinnyIMTPoseidon2WriteEvent.insertManyRepeated(
            skinnyEventTrees[0],
            value,
            amount
        );
    }

    function update(
        uint256 oldLeaf,
        uint256 newLeaf,
        uint256 index,
        uint256[] calldata proofSiblings
    ) public {
        FatIMTPoseidon2WriteStorage.update(fatStorageTrees[0], newLeaf, index);
        SkinnyIMTPoseidon2WriteStorage.update(
            skinnyStorageTrees[0],
            oldLeaf,
            newLeaf,
            index,
            proofSiblings
        );

        FatIMTPoseidon2WriteEvent.update(fatEventTrees[0], newLeaf, index);
        SkinnyIMTPoseidon2WriteEvent.update(
            skinnyEventTrees[0],
            oldLeaf,
            newLeaf,
            index,
            proofSiblings
        );
    }

    function updateMany(
        uint256[] calldata oldLeaves,
        uint256[] calldata newLeaves,
        uint256[] calldata leafIndexes,
        uint256[] calldata proofSiblings
    ) public {
        FatIMTPoseidon2WriteStorage.updateMany(
            fatStorageTrees[0],
            newLeaves,
            leafIndexes
        );
        SkinnyIMTPoseidon2WriteStorage.updateMany(
            skinnyStorageTrees[0],
            oldLeaves,
            newLeaves,
            leafIndexes,
            proofSiblings
        );

        FatIMTPoseidon2WriteEvent.updateMany(
            fatEventTrees[0],
            newLeaves,
            leafIndexes
        );
        SkinnyIMTPoseidon2WriteEvent.updateMany(
            skinnyEventTrees[0],
            oldLeaves,
            newLeaves,
            leafIndexes,
            proofSiblings
        );
    }
}
