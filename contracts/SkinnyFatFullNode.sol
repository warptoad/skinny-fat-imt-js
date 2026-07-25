// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// TODO FatIMTData exported in FatIMTPoseidon2WriteFullNode?
// TODO Drop the node it's cleaner
import {FatIMTPoseidon2WriteFullNode, FatIMTDataFullNode} from "@warptoad/fat-imt.sol/poseidon2/FatIMTPoseidon2WriteFullNode.sol";
import {FatIMTFullNodeReadable} from "@warptoad/fat-imt.sol/FatIMTFullNodeReadable.sol";
import {SkinnyIMTPoseidon2WriteFullNode, SkinnyIMTDataFullNode} from "@warptoad/skinny-imt.sol/poseidon2/SkinnyIMTPoseidon2WriteFullNode.sol";
import {SkinnyIMTFullNodeReadable} from "@warptoad/skinny-imt.sol/SkinnyIMTFullNodeReadable.sol";

contract SkinnyFatFullNode is
    SkinnyIMTFullNodeReadable,
    FatIMTFullNodeReadable
{
    FatIMTDataFullNode fatTree;
    SkinnyIMTDataFullNode skinnyTree;

    constructor() {
        FatIMTPoseidon2WriteFullNode.init(fatTree);
        SkinnyIMTPoseidon2WriteFullNode.init(skinnyTree);
    }

    // overridable functions so SkinnyIMTFullNodeReadable and SkinnyIMTDataFullNode
    // can find out where the tree is stored so it can expose a interface to get the leaves and storage slot for debug_getStorageRangeAt
    function _getFatTree(
        uint256 //treeId, only one tree so no need for treeId for looking up a mapping for example
    ) internal view virtual override returns (FatIMTDataFullNode storage) {
        return fatTree;
    }

    // overridable functions so SkinnyIMTFullNodeReadable and SkinnyIMTDataFullNode
    // can find out where the tree is stored so it can expose a interface to get the leaves and storage slot for debug_getStorageRangeAt
    function _getSkinnyTree(
        uint256 //treeId
    ) internal view virtual override returns (SkinnyIMTDataFullNode storage) {
        return skinnyTree;
    }

    function reset() public {
        FatIMTPoseidon2WriteFullNode.reset(fatTree);
        SkinnyIMTPoseidon2WriteFullNode.reset(skinnyTree);
    }

    function insert(uint256 leaf) public {
        FatIMTPoseidon2WriteFullNode.insert(fatTree, leaf);
        SkinnyIMTPoseidon2WriteFullNode.insert(skinnyTree, leaf);
    }

    function insertMany(uint256[] calldata leaves) public {
        FatIMTPoseidon2WriteFullNode.insertMany(fatTree, leaves);
        SkinnyIMTPoseidon2WriteFullNode.insertMany(skinnyTree, leaves);
    }

    function insertManyRepeated(uint256 value, uint256 amount) public {
        FatIMTPoseidon2WriteFullNode.insertManyRepeated(fatTree, value, amount);
        SkinnyIMTPoseidon2WriteFullNode.insertManyRepeated(
            skinnyTree,
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
        FatIMTPoseidon2WriteFullNode.update(fatTree, newLeaf, index);
        SkinnyIMTPoseidon2WriteFullNode.update(
            skinnyTree,
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
        FatIMTPoseidon2WriteFullNode.updateMany(
            fatTree,
            newLeaves,
            leafIndexes
        );
        SkinnyIMTPoseidon2WriteFullNode.updateMany(
            skinnyTree,
            oldLeaves,
            newLeaves,
            leafIndexes,
            proofSiblings
        );
    }
}
