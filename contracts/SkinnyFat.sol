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

import {FatIMTPoseidon2Read} from "@warptoad/fat-imt.sol/poseidon2/FatIMTPoseidon2Read.sol";
import {SkinnyIMTPoseidon2Read} from "@warptoad/skinny-imt.sol/poseidon2/SkinnyIMTPoseidon2Read.sol";

import {IIMTEvents} from "@warptoad/fat-imt.sol/interfaces/IIMTEvents.sol";

error WrongTreeId();
error TreeHasIncorrectType();
// TODO nice to have also in the package, but zk-kit structure clashes, so maybe skinny-fat as one package?
enum TreeType {
    SKINNY_STORAGE,
    SKINNY_EVENT,
    FAT_STORAGE,
    FAT_EVENT
}

contract SkinnyFat is
    SkinnyIMTReadableStorage,
    FatIMTReadableStorage,
    IIMTEvents
{
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
        indexOfTreeId[fatStorageTreeId] = fatStorageTrees.length - 1;

        FatIMTDataEvent storage fatEventTree = fatEventTrees.push();
        uint256 fatEventTreeId = FatIMTPoseidon2WriteEvent.init(fatEventTree);
        treeTypes[fatEventTreeId] = TreeType.FAT_EVENT;
        indexOfTreeId[fatEventTreeId] = fatEventTrees.length - 1;

        SkinnyIMTDataStorage storage skinnyStorageTree = skinnyStorageTrees
            .push();
        uint256 skinnyStorageTreeId = SkinnyIMTPoseidon2WriteStorage.init(
            skinnyStorageTree
        );
        treeTypes[skinnyStorageTreeId] = TreeType.SKINNY_STORAGE;
        indexOfTreeId[skinnyStorageTreeId] = skinnyStorageTrees.length - 1;

        SkinnyIMTDataEvent storage skinnyEventTree = skinnyEventTrees.push();
        uint256 skinnyEventTreeId = SkinnyIMTPoseidon2WriteEvent.init(
            skinnyEventTree
        );
        treeTypes[skinnyEventTreeId] = TreeType.SKINNY_EVENT;
        indexOfTreeId[skinnyEventTreeId] = skinnyEventTrees.length - 1;
    }

    //
    function supportsInterface(
        bytes4 interfaceId
    )
        public
        view
        override(FatIMTReadableStorage, SkinnyIMTReadableStorage)
        returns (bool)
    {
        // this calls FatIMTReadableStorage.supportsInterface(), which contains a super in it as well which then will
        // call the skinny variant since it is also inherited
        return super.supportsInterface(interfaceId);
    }

    // if you'r only using the storage variant, no need to override this SkinnyIMTReadableStorage just passes treeStorage.treeData along
    // if you use both tho do override like this!!
    // if you got more trees. You can store them in a mapping like this
    function _getSkinnyEventTree(
        uint256 treeId
    ) internal view virtual override returns (SkinnyIMTDataEvent storage) {
        uint256 index = indexOfTreeId[treeId];
        if (treeTypes[treeId] != TreeType.SKINNY_EVENT) {
            revert TreeHasIncorrectType();
        }
        return skinnyEventTrees[index];
    }

    // overridable functions so SkinnyIMTFullNodeReadable and SkinnyIMTDataFullNode
    // can find out where the tree is stored so it can expose a interface to get the leaves and storage slot for debug_getStorageRangeAt
    function _getSkinnyStorageTree(
        uint256 treeId
    ) internal view virtual override returns (SkinnyIMTDataStorage storage) {
        uint256 index = indexOfTreeId[treeId];
        if (treeTypes[treeId] != TreeType.SKINNY_STORAGE) {
            revert TreeHasIncorrectType();
        }
        return skinnyStorageTrees[index];
    }

    function _getFatEventTree(
        uint256 treeId
    ) internal view virtual override returns (FatIMTDataEvent storage) {
        uint256 index = indexOfTreeId[treeId];
        if (treeTypes[treeId] != TreeType.FAT_EVENT) {
            revert TreeHasIncorrectType();
        }
        return fatEventTrees[index];
    }

    // overridable functions so SkinnyIMTFullNodeReadable and SkinnyIMTDataFullNode
    // can find out where the tree is stored so it can expose a interface to get the leaves and storage slot for debug_getStorageRangeAt
    function _getFatStorageTree(
        uint256 treeId
    ) internal view virtual override returns (FatIMTDataStorage storage) {
        uint256 index = indexOfTreeId[treeId];
        if (treeTypes[treeId] != TreeType.FAT_STORAGE) {
            revert TreeHasIncorrectType();
        }
        return fatStorageTrees[index];
    }

    function getTreeIds(
        uint256 index
    ) public view returns (uint256, uint256, uint256, uint256) {
        return (
            fatStorageTrees[index].treeData.treeId,
            fatEventTrees[index].treeId,
            skinnyStorageTrees[index].treeData.treeId,
            skinnyEventTrees[index].treeId
        );
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
        SkinnyIMTPoseidon2WriteStorage.insertMany(
            skinnyStorageTrees[0],
            leaves
        );
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

    function _assertRootMatch() private view returns (uint256) {
        uint256 fatStorageRoot = FatIMTPoseidon2Read.root(
            fatStorageTrees[0].treeData
        );
        uint256 fatEventRoot = FatIMTPoseidon2Read.root(fatEventTrees[0]);
        uint256 skinnyStorageRoot = SkinnyIMTPoseidon2Read.root(
            skinnyStorageTrees[0].treeData
        );
        uint256 skinnyEventRoot = SkinnyIMTPoseidon2Read.root(
            skinnyEventTrees[0]
        );
        require(
            fatStorageRoot == fatEventRoot,
            "fatStorageRoot does not match fatEventRoot"
        );
        require(
            fatStorageRoot == skinnyStorageRoot,
            "fatStorageRoot does not match skinnyStorageRoot"
        );
        require(
            fatStorageRoot == skinnyEventRoot,
            "fatStorageRoot does not match skinnyEventRoot"
        );
        return fatStorageRoot;
    }

    function root() public view returns (uint256) {
        return _assertRootMatch();
    }
}
