import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { LeanIMT } from "@zk-kit/lean-imt"
import { poseidon2Hash } from "@zkpassport/poseidon2"

import { network } from "hardhat";
import type { SkinnyFat$Type } from "../artifacts/contracts/SkinnyFat.sol/artifacts.js";
import { concat, sha256, toHex, type Account, type GetContractReturnType, type Hex, type PublicClient, type WalletClient } from "viem"

export type WalletWithAccount = WalletClient & { account: Account };
export type SkinnyFatContractType = GetContractReturnType<SkinnyFat$Type["abi"], WalletClient>;

// The tree is defined over the BN254 scalar field, so every leaf must be < this value or the contract
// reverts with LeafGreaterThanSnarkScalarField(). sha256 returns a full 256-bit digest that regularly
// exceeds it, so reduce each generated leaf modulo the field.
const SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
function randomLeaf(seed: Hex, label: string): bigint {
  return BigInt(sha256(concat([seed, toHex(label)]))) % SNARK_SCALAR_FIELD
}

// TODO add this to the lib, or maybe make pr to LeanIMT js?
// Builds a shared (deduplicated) multiproof for `rawIndices` against `tree`, in
// the flat shape `_proofManyToRoot` expects:
//   - `leaves`: flat leaf values in ascending-index order.
//   - `leafIndexes`: the matching real tree indexes, aligned entry-for-entry.
//   - `siblings`: the flat, bottom-up / left-to-right proof-sibling stream (a
//     paired neighbour and a right-edge dangle cost nothing; everything else pulls one).
// Every leaf is fed in at level 0; the contract carries dangling nodes up itself
// from `edgeIndex`, so no per-level schedule is needed.
function generateMultiProof(
  tree: LeanIMT,
  rawIndices: number[]
): { leaves: bigint[]; leafIndexes: number[]; siblings: bigint[] } {
  const indices = [...new Set(rawIndices)].sort((a, b) => a - b)
  // `_nodes[level][position]` holds every computed node; it isn't in the public typings.
  const nodes = (tree as any)._nodes as bigint[][]
  const size = tree.size
  const depth = tree.depth

  // --- proofSiblings: climb the known set from level 0 and collect a sibling
  //     only where the contract reads one from the stream. ---
  let knownPositions = indices.slice()
  let levelSize = size
  const siblings: bigint[] = []
  for (let level = 0; level < depth; level += 1) {
    const parentPositions: number[] = []
    let readCursor = 0
    while (readCursor < knownPositions.length) {
      const childPosition = knownPositions[readCursor]
      if (childPosition % 2 === 0) {
        // left child
        if (childPosition + 1 >= levelSize) {
          // dangle: rightmost node of the level, no sibling to supply
        } else if (
          readCursor + 1 < knownPositions.length &&
          knownPositions[readCursor + 1] === childPosition + 1
        ) {
          // pair: the next known node is the right sibling, nothing to supply
          readCursor += 1
        } else {
          // proof: the contract reads this right sibling from the stream
          siblings.push(nodes[level][childPosition + 1])
        }
      } else {
        // right child: the contract always reads the left sibling
        siblings.push(nodes[level][childPosition - 1])
      }
      parentPositions.push(Math.floor(childPosition / 2))
      readCursor += 1
    }
    knownPositions = parentPositions
    levelSize = Math.ceil(levelSize / 2)
  }

  return {
    leaves: indices.map((idx) => tree.leaves[idx]),
    leafIndexes: indices,
    siblings
  }
}

describe("SkinnyFat", async function () {
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  let SkinnyFatContract: SkinnyFatContractType;
  const [deployer] = await viem.getWalletClients()

  beforeEach(async () => {
    SkinnyFatContract = await viem.deployContract("SkinnyFat", [], {
      libraries: {
        FatIMTPoseidon2WriteStorage: (await viem.deployContract("FatIMTPoseidon2WriteStorage")).address,
        FatIMTPoseidon2WriteEvent: (await viem.deployContract("FatIMTPoseidon2WriteEvent")).address,
        SkinnyIMTPoseidon2WriteStorage: (await viem.deployContract("SkinnyIMTPoseidon2WriteStorage")).address,
        SkinnyIMTPoseidon2WriteEvent: (await viem.deployContract("SkinnyIMTPoseidon2WriteEvent")).address,

        SkinnyIMTPoseidon2Read: (await viem.deployContract("SkinnyIMTPoseidon2Read")).address,
        FatIMTPoseidon2Read: (await viem.deployContract("FatIMTPoseidon2Read")).address,

      }
    });
  })

  const seed = toHex(crypto.getRandomValues(new Uint8Array(32)))
  it(`Should all operations at least twice with random seed: ${seed}`, async function () {
    let jsTree = new LeanIMT((a, b) => poseidon2Hash([a, b]))
    jsTree = await randomTree(SkinnyFatContract, jsTree, seed, deployer, publicClient)
    assert.equal(jsTree.root, await SkinnyFatContract.read.root())
  });
});


async function randomInsert(
  SkinnyFatContract: SkinnyFatContractType,
  jsTree: LeanIMT<bigint>,
  seed: Hex,
  WalletClient: WalletWithAccount,
  publicClient: PublicClient
) {
  const value = randomLeaf(seed, 'insert')
  jsTree.insert(value)
  await SkinnyFatContract.write.insert([value], { account: WalletClient.account, chain: publicClient.chain });
  return jsTree
}

async function randomInsertMany(
  SkinnyFatContract: SkinnyFatContractType,
  jsTree: LeanIMT<bigint>,
  seed: Hex,
  WalletClient: WalletWithAccount,
  publicClient: PublicClient
) {
  const size = Number(BigInt(sha256(concat([seed, toHex('insertManySize')]))) % 20n) + 1
  if (size === 0) {
    return jsTree
  }
  const values = new Array(size).fill(0n).map((v, i) => randomLeaf(seed, `insertMany${i}`))
  jsTree.insertMany(values)
  await SkinnyFatContract.write.insertMany([values], { account: WalletClient.account, chain: publicClient.chain });
  return jsTree
}

async function randomInsertRepeated(
  SkinnyFatContract: SkinnyFatContractType,
  jsTree: LeanIMT<bigint>,
  seed: Hex,
  WalletClient: WalletWithAccount,
  publicClient: PublicClient
) {
  const size = Number(BigInt(sha256(concat([seed, toHex('insertManyRepeatedSize')]))) % 20n) + 1
  const value = randomLeaf(seed, 'insertManyRepeated')
  if (size === 0) {
    return jsTree
  }
  jsTree.insertMany(new Array(size).fill(value))
  await SkinnyFatContract.write.insertManyRepeated([value, BigInt(size)], { account: WalletClient.account, chain: publicClient.chain });
  return jsTree
}

async function randomUpdate(
  SkinnyFatContract: SkinnyFatContractType,
  jsTree: LeanIMT,
  seed: Hex,
  WalletClient: WalletWithAccount,
  publicClient: PublicClient
) {
  if (jsTree.size == 0) {
    return jsTree
  }
  const index = BigInt(sha256(concat([seed, toHex('insertManyRepeatedSize')]))) % BigInt(jsTree.size)
  const newValue = randomLeaf(seed, 'insert')
  const oldValue = jsTree.leaves[Number(index)];
  const merkleProof = jsTree.generateProof(Number(index))
  jsTree.update(Number(index), newValue);
  await SkinnyFatContract.write.update([oldValue, newValue, index, merkleProof.siblings], { account: WalletClient.account, chain: publicClient.chain });
  return jsTree

}

async function randomUpdateMany(
  SkinnyFatContract: SkinnyFatContractType,
  jsTree: LeanIMT,
  seed: Hex,
  WalletClient: WalletWithAccount,
  publicClient: PublicClient
) {
  if (jsTree.size == 0) {
    return jsTree
  }
  const numUpdates = Number(BigInt(sha256(concat([seed, toHex('updateManySize')]))) % BigInt(Math.min(20, jsTree.size))) + 1
  const indexes = [...new Set(
    new Array(numUpdates).fill(0).map((v, i) =>
      Number(BigInt(sha256(concat([seed, toHex(`updateManyIndexes${i}`)]))) % BigInt(jsTree.size))
    )
  )].sort((a, b) => a - b)
  const newValues = indexes.map((v, i) => randomLeaf(seed, `updateManyValues${i}`))
  const oldValues = indexes.map((v) => jsTree.leaves[v]);
  const merkleProof = generateMultiProof(jsTree, indexes)
  jsTree.updateMany(indexes, newValues)
  await SkinnyFatContract.write.updateMany([oldValues, newValues, merkleProof.leafIndexes.map((v) => BigInt(v)), merkleProof.siblings], { account: WalletClient.account, chain: publicClient.chain });
  return jsTree

}

async function randomTree(
  SkinnyFatContract: SkinnyFatContractType,
  jsTree: LeanIMT,
  seed: Hex,
  walletClient: WalletWithAccount,
  publicClient: PublicClient,
  numTxs = 10
) {
  const ops = [
    randomInsert,
    randomInsertMany,
    randomInsertRepeated,
    randomUpdate,
    randomUpdateMany,
  ]

  // Coverage floor: every op runs at least twice, regardless of numTxs. Then `numTxs` extra
  // randomly-chosen ops are added on top. The schedule is a flat list of op indexes.
  const schedule: number[] = []
  for (let i = 0; i < ops.length; i++) {
    schedule.push(i, i)
  }
  for (let i = 0; i < numTxs; i++) {
    schedule.push(Number(BigInt(sha256(concat([seed, toHex(`extraOp${i}`)]))) % BigInt(ops.length)))
  }

  // Shuffle into a deterministic, seed-derived random order (Fisher-Yates) so the ordering varies per
  // seed but stays reproducible. This also handles numTxs === 0: the mandatory ops still run, shuffled.
  for (let i = schedule.length - 1; i > 0; i--) {
    const j = Number(BigInt(sha256(concat([seed, toHex(`shuffle${i}`)]))) % BigInt(i + 1))
    const tmp = schedule[i]
    schedule[i] = schedule[j]
    schedule[j] = tmp
  }

  for (let index = 0; index < schedule.length; index++) {
    const iterSeed = sha256(concat([seed, toHex(`iter${index}`)]))
    jsTree = await ops[schedule[index]](SkinnyFatContract, jsTree, iterSeed, walletClient, publicClient)
  }
  return jsTree
}
