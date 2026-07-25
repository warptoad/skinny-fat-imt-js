// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// TODO FatIMTData exported in FatIMTPoseidon2WriteArchiveNode?
// TODO Drop the node it's cleaner
import {FatIMTPoseidon2WriteArchiveNode} from "@warptoad/fat-imt.sol/poseidon2/FatIMTPoseidon2WriteArchiveNode.sol";
import {FatIMTData} from "@warptoad/fat-imt.sol/InternalFatIMTCore.sol";

import {SkinnyIMTPoseidon2WriteArchiveNode} from "@warptoad/skinny-imt.sol/poseidon2/SkinnyIMTPoseidon2WriteArchiveNode.sol";
import {SkinnyIMTData} from "@warptoad/skinny-imt.sol/InternalSkinnyIMTCore.sol";

contract SkinnyFatArchiveNode {
    FatIMTData fatTree;
    SkinnyIMTData skinnyTree;

    constructor() {
        FatIMTPoseidon2WriteArchiveNode.init(fatTree);
        SkinnyIMTPoseidon2WriteArchiveNode.init(skinnyTree);
    }

    function reset() public {
        FatIMTPoseidon2WriteArchiveNode.reset(fatTree);
        SkinnyIMTPoseidon2WriteArchiveNode.reset(skinnyTree);
    }

    function insert(uint256 leaf) public {
        FatIMTPoseidon2WriteArchiveNode.insert(fatTree, leaf);
        SkinnyIMTPoseidon2WriteArchiveNode.insert(skinnyTree, leaf);
    }

    function insertMany(uint256[] calldata leaves) public {
        FatIMTPoseidon2WriteArchiveNode.insertMany(fatTree, leaves);
        SkinnyIMTPoseidon2WriteArchiveNode.insertMany(skinnyTree, leaves);
    }

    function insertManyRepeated(uint256 value, uint256 amount) public {
        FatIMTPoseidon2WriteArchiveNode.insertManyRepeated(
            fatTree,
            value,
            amount
        );
        SkinnyIMTPoseidon2WriteArchiveNode.insertManyRepeated(
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
        FatIMTPoseidon2WriteArchiveNode.update(fatTree, newLeaf, index);
        SkinnyIMTPoseidon2WriteArchiveNode.update(
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
        FatIMTPoseidon2WriteArchiveNode.updateMany(
            fatTree,
            newLeaves,
            leafIndexes
        );
        SkinnyIMTPoseidon2WriteArchiveNode.updateMany(
            skinnyTree,
            oldLeaves,
            newLeaves,
            leafIndexes,
            proofSiblings
        );
    }
}
