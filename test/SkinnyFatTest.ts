import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { LeanIMT } from "@zk-kit/lean-imt"
import { poseidon2Hash } from "@zkpassport/poseidon2"

import { network } from "hardhat";
import type { SkinnyFat$Type } from "../artifacts/contracts/SkinnyFat.sol/artifacts.js";
import { concat, sha256, toHex, type Account, type GetContractReturnType, type Hex, type PublicClient, type WalletClient } from "viem"
import { identifyTree, Trees } from "../src/Trees.js";

export type WalletWithAccount = WalletClient & { account: Account };
export type SkinnyFatContractType = GetContractReturnType<SkinnyFat$Type["abi"], WalletClient>;

// The tree is defined over the BN254 scalar field, so every leaf must be < this value or the contract
// reverts with LeafGreaterThanSnarkScalarField(). sha256 returns a full 256-bit digest that regularly
// exceeds it, so reduce each generated leaf modulo the field.
const SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
function randomLeaf(seed: Hex, label: string): bigint {
  return BigInt(sha256(concat([seed, toHex(label)]))) % SNARK_SCALAR_FIELD
}

// An empty LeanIMT has no root, so `.root` reads back as undefined. The contract reports 0n for an
// empty tree, so normalize to that to keep the two comparable after a reset.
function rootOf(tree: LeanIMT<bigint>): bigint {
  return tree.root ?? 0n
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
    assert.equal(rootOf(jsTree), await SkinnyFatContract.read.root())

    const trees = new Trees(SkinnyFatContract.address, publicClient)
    const treeIds = await SkinnyFatContract.read.getTreeIds([0n]);
    const onchainRoot = await SkinnyFatContract.read.root()
    const detectedTreeTypes = await Promise.all(treeIds.map(async (treeId)=>await identifyTree(treeId, SkinnyFatContract)))
    console.log({treeTypes: detectedTreeTypes})

    // both with the treeIds known up front, and with them auto discovered from the events
    for (const [mode, reproducedTrees] of [
      ["known treeIds", await trees.syncTreesEvent([...treeIds])],
      ["auto discovered", await trees.syncTreesEvent([],{autoDiscovery:true})],
    ] as const) {
      assert.deepEqual(
        Object.keys(reproducedTrees).sort(),
        treeIds.map((id) => toHex(id)).sort(),
        `${mode}: reproduced a different set of trees than the contract reports`
      )
      for (const [treeId, reproducedTree] of Object.entries(reproducedTrees)) {
        // all 4 trees hold the same leaves, so each one has to come back to the same root
        assert.equal(reproducedTree.tree.size, jsTree.size, `${mode}: tree ${treeId} has the wrong size`)
        assert.deepEqual(reproducedTree.tree.leaves, jsTree.leaves, `${mode}: tree ${treeId} has the wrong leaves`)
        assert.equal(rootOf(reproducedTree.tree), onchainRoot, `${mode}: tree ${treeId} does not match the onchain root`)
      }
    }
  });

  // Same as the random seed test, but with a chunkSize small enough that the backwards scan has to
  // walk several chunks. Catches state that only survives within a single query (a tree that is
  // only completed by merging events across chunk boundaries, an early-quit that fires too soon).
  const chunkedSeed = toHex(crypto.getRandomValues(new Uint8Array(32)))
  it(`Should all operations at least twice with random seed, synced in multiple chunks: ${chunkedSeed}`, async function () {
    const chunkSize = 10n
    let jsTree = new LeanIMT((a, b) => poseidon2Hash([a, b]))
    const startBlock = await publicClient.getBlockNumber()
    // more txs than the default, so the block span comfortably outruns chunkSize
    jsTree = await randomTree(SkinnyFatContract, jsTree, chunkedSeed, deployer, publicClient, 0, undefined, 40)
    assert.equal(rootOf(jsTree), await SkinnyFatContract.read.root())

    // the whole point of this test: the scan must not fit in one chunk
    const endBlock = await publicClient.getBlockNumber()
    assert.ok(
      endBlock - startBlock > chunkSize,
      `only ${endBlock - startBlock} blocks were written, that fits in a single chunk of ${chunkSize}`
    )

    const trees = new Trees(SkinnyFatContract.address, publicClient)
    const treeIds = await SkinnyFatContract.read.getTreeIds([0n]);
    const onchainRoot = await SkinnyFatContract.read.root()

    // both with the treeIds known up front, and with them auto discovered from the events
    for (const [mode, reproducedTrees] of [
      ["known treeIds", await trees.syncTreesEvent([...treeIds], { chunkSize })],
      ["auto discovered", await trees.syncTreesEvent([], { autoDiscovery: true, chunkSize })],
    ] as const) {
      assert.deepEqual(
        Object.keys(reproducedTrees).sort(),
        treeIds.map((id) => toHex(id)).sort(),
        `${mode}: reproduced a different set of trees than the contract reports`
      )
      for (const [treeId, reproducedTree] of Object.entries(reproducedTrees)) {
        // all 4 trees hold the same leaves, so each one has to come back to the same root
        assert.equal(reproducedTree.tree.size, jsTree.size, `${mode}: tree ${treeId} has the wrong size`)
        assert.deepEqual(reproducedTree.tree.leaves, jsTree.leaves, `${mode}: tree ${treeId} has the wrong leaves`)
        assert.equal(rootOf(reproducedTree.tree), onchainRoot, `${mode}: tree ${treeId} does not match the onchain root`)
      }
    }
  });

  // timeout so a resync that never terminates fails the test instead of hanging the run
  it("Should shrink a cached tree back to empty after a reset", { timeout: 30_000 }, async function () {
    const trees = new Trees(SkinnyFatContract.address, publicClient)
    const treeIds = await SkinnyFatContract.read.getTreeIds([0n]);

    // fill all 4 trees, then sync so they end up in the cache
    await SkinnyFatContract.write.insertMany([[1n, 2n, 3n, 4n, 5n]], { account: deployer.account, chain: publicClient.chain })
    const filled = await trees.syncTreesEvent([...treeIds])
    for (const [treeId, tree] of Object.entries(filled)) {
      assert.equal(tree.tree.size, 5, `tree ${treeId} did not sync its 5 leaves`)
    }

    // reset drops every tree back to size 0, which only shows up as NewRoot(treeId, 0, 0)
    await SkinnyFatContract.write.reset({ account: deployer.account, chain: publicClient.chain })

    // re-syncing the same Trees instance has to shrink the cached trees, not keep the stale leaves
    const afterReset = await trees.syncTreesEvent([...treeIds])
    for (const [treeId, tree] of Object.entries(afterReset)) {
      assert.equal(tree.tree.size, 0, `tree ${treeId} kept stale leaves after a reset`)
      assert.deepEqual(tree.tree.leaves, [], `tree ${treeId} kept stale leaves after a reset`)
    }
  });

  // Same reset, but reconstructed from scratch by a Trees with no cache to shrink, and checked
  // against the contract instead of against an expected size. Fails until _reset clears the node
  // storage: root() reads the stale sideNodes/nodes of the pre-reset tree and reverts.
  it("Should sync a freshly reset tree from scratch and agree with the onchain root", { timeout: 30_000 }, async function () {
    const treeIds = await SkinnyFatContract.read.getTreeIds([0n]);

    await SkinnyFatContract.write.insertMany([[1n, 2n, 3n, 4n, 5n]], { account: deployer.account, chain: publicClient.chain })
    await SkinnyFatContract.write.reset({ account: deployer.account, chain: publicClient.chain })

    const onchainRoot = await SkinnyFatContract.read.root()
    const trees = new Trees(SkinnyFatContract.address, publicClient)
    const reproduced = await trees.syncTreesEvent([...treeIds])

    assert.deepEqual(Object.keys(reproduced).sort(), treeIds.map((id) => toHex(id)).sort())
    for (const [treeId, tree] of Object.entries(reproduced)) {
      assert.deepEqual(tree.tree.leaves, [], `tree ${treeId} reconstructed leaves for a reset tree`)
      assert.equal(rootOf(tree.tree), onchainRoot, `tree ${treeId} does not match the onchain root`)
    }
  });

  // the incremental path: the second sync only sees the *new* leaves, so `count` never reaches
  // `targetSize` and no tree is ever removed from unsyncedTreesIds. Must still terminate, and merge.
  it("Should resync incrementally when leaves are appended after a sync", { timeout: 30_000 }, async function () {
    const trees = new Trees(SkinnyFatContract.address, publicClient)
    const treeIds = await SkinnyFatContract.read.getTreeIds([0n]);

    await SkinnyFatContract.write.insertMany([[1n, 2n, 3n, 4n, 5n]], { account: deployer.account, chain: publicClient.chain })
    const filled = await trees.syncTreesEvent([...treeIds])
    for (const [treeId, tree] of Object.entries(filled)) {
      assert.equal(tree.tree.size, 5, `tree ${treeId} did not sync its 5 leaves`)
    }

    // append after the first sync, so only these two land in the second sync's block range
    await SkinnyFatContract.write.insertMany([[6n, 7n]], { account: deployer.account, chain: publicClient.chain })

    const expected = [1n, 2n, 3n, 4n, 5n, 6n, 7n]
    const onchainRoot = await SkinnyFatContract.read.root()
    const appended = await trees.syncTreesEvent([...treeIds])
    for (const [treeId, tree] of Object.entries(appended)) {
      assert.deepEqual(tree.tree.leaves, expected, `tree ${treeId} has the wrong leaves after an incremental sync`)
      assert.equal(tree.tree.root, onchainRoot, `tree ${treeId} does not match the onchain root`)
    }
  });

  // syncToRoot pins the sync to a historic root: the newest NewRoot must be ignored and the scan
  // has to keep walking back until it finds the NewRoot carrying the pinned root.
  it("Should sync to a pinned historic root instead of the current one", { timeout: 30_000 }, async function () {
    const trees = new Trees(SkinnyFatContract.address, publicClient)
    const treeIds = await SkinnyFatContract.read.getTreeIds([0n]);

    await SkinnyFatContract.write.insertMany([[1n, 2n, 3n, 4n, 5n]], { account: deployer.account, chain: publicClient.chain })
    const pinnedRoot = await SkinnyFatContract.read.root()

    // move the trees past the pinned root, so the newest NewRoot is a different one
    await SkinnyFatContract.write.insertMany([[6n, 7n]], { account: deployer.account, chain: publicClient.chain })
    assert.notEqual(await SkinnyFatContract.read.root(), pinnedRoot, "the second insert did not change the root")

    const pinnedTrees = await trees.syncTreesEvent([...treeIds], {syncToRoot: pinnedRoot})
    assert.deepEqual(Object.keys(pinnedTrees).sort(), treeIds.map((id) => toHex(id)).sort())
    for (const [treeId, tree] of Object.entries(pinnedTrees)) {
      assert.deepEqual(tree.tree.leaves, [1n, 2n, 3n, 4n, 5n], `tree ${treeId} did not stop at the pinned root`)
      assert.equal(tree.tree.root, pinnedRoot, `tree ${treeId} does not match the pinned root`)
    }
  });

  // Same pinning, but the cache is already *ahead* of the pinned root: the trees were fully synced to
  // the newer state first, so syncing back to an older root has to shrink the cached tree instead of
  // merging into it.
  it("Should sync back to a root older than what is already in the cache", { timeout: 30_000 }, async function () {
    const trees = new Trees(SkinnyFatContract.address, publicClient)
    const treeIds = await SkinnyFatContract.read.getTreeIds([0n]);

    await SkinnyFatContract.write.insertMany([[1n, 2n, 3n, 4n, 5n]], { account: deployer.account, chain: publicClient.chain })
    const pinnedRoot = await SkinnyFatContract.read.root()

    // first sync: the cache now holds the 5 leaf state
    const filled = await trees.syncTreesEvent([...treeIds])
    for (const [treeId, tree] of Object.entries(filled)) {
      assert.equal(tree.tree.size, 5, `tree ${treeId} did not sync its 5 leaves`)
    }

    // move past the pinned root and sync again, so the cache is ahead of it
    await SkinnyFatContract.write.insertMany([[6n, 7n]], { account: deployer.account, chain: publicClient.chain })
    const ahead = await trees.syncTreesEvent([...treeIds])
    for (const [treeId, tree] of Object.entries(ahead)) {
      assert.equal(tree.tree.size, 7, `tree ${treeId} did not sync its 7 leaves`)
    }

    // now ask for the older root back
    const pinnedTrees = await trees.syncTreesEvent([...treeIds], { syncToRoot: pinnedRoot })
    assert.deepEqual(Object.keys(pinnedTrees).sort(), treeIds.map((id) => toHex(id)).sort())
    for (const [treeId, tree] of Object.entries(pinnedTrees)) {
      assert.deepEqual(tree.tree.leaves, [1n, 2n, 3n, 4n, 5n], `tree ${treeId} kept leaves newer than the pinned root`)
      assert.equal(tree.tree.root, pinnedRoot, `tree ${treeId} does not match the pinned root`)
    }
  });

  // Guards the rewind's `lastSynced`: if it is stamped at the head block instead of the block of the
  // root it actually synced to, the next plain sync starts above the blocks it still needs. The leaves
  // it misses stay holes in the sparse `leaves` array, which `forEach` skips, so they are never filled
  // and the newer ones get appended at the wrong indexes instead.
  it("Should still catch back up to head after being rewound to an older root", { timeout: 30_000 }, async function () {
    const trees = new Trees(SkinnyFatContract.address, publicClient)
    const treeIds = await SkinnyFatContract.read.getTreeIds([0n]);

    await SkinnyFatContract.write.insertMany([[1n, 2n, 3n, 4n, 5n]], { account: deployer.account, chain: publicClient.chain })
    const pinnedRoot = await SkinnyFatContract.read.root()
    await trees.syncTreesEvent([...treeIds])

    // two separate blocks after the pinned root, so the older one is not the block the next sync
    // rescans anyway (its firstBlock is inclusive, which would hide the bug)
    await SkinnyFatContract.write.insertMany([[6n, 7n]], { account: deployer.account, chain: publicClient.chain })
    await SkinnyFatContract.write.insertMany([[8n, 9n]], { account: deployer.account, chain: publicClient.chain })
    await trees.syncTreesEvent([...treeIds])

    // rewind to the older root, then let the chain move on
    const treePinned = await trees.syncTreesEvent([...treeIds], { syncToRoot: pinnedRoot })
    await SkinnyFatContract.write.insertMany([[10n]], { account: deployer.account, chain: publicClient.chain })

    const expected = [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n]
    const onchainRoot = await SkinnyFatContract.read.root()
    const caughtUp = await trees.syncTreesEvent([...treeIds])
    for (const [treeId, tree] of Object.entries(caughtUp)) {
      assert.deepEqual(tree.tree.leaves, expected, `tree ${treeId} has the wrong leaves after catching up from a rewind`)
      assert.equal(tree.tree.root, onchainRoot, `tree ${treeId} does not match the onchain root`)
    }
  });

  // A treeId that never emitted anything has no NewRoot to take a block number from, so nothing
  // in `syncState.treeState` describes it. Syncing it should hand back an empty tree, not blow up.
  it("Should return an empty tree for a treeId that has no events", { timeout: 30_000 }, async function () {
    const trees = new Trees(SkinnyFatContract.address, publicClient)
    await SkinnyFatContract.write.insertMany([[1n, 2n, 3n]], { account: deployer.account, chain: publicClient.chain })

    const synced = await trees.syncTreesEvent([0xdeadn])
    assert.deepEqual(synced[toHex(0xdeadn)].tree.leaves, [], "an unknown treeId reconstructed leaves")
  });

  // The storage path: no events at all, the leaves are read back out of the contract at the safe
  // block. Covers a leaf that was *changed* rather than appended (so a sync that only ever appends
  // gets it wrong), a chunkSize that forces several eth_calls, the incremental insert-only re-sync
  // off the cache, and the skinny event tree, which keeps no leaves and so can't be read this way.
  const storageSeed = toHex(crypto.getRandomValues(new Uint8Array(32)))
  it(`Should sync trees straight from storage with random seed: ${storageSeed}`, { timeout: 30_000 }, async function () {
    const trees = new Trees(SkinnyFatContract.address, publicClient)
    // only the storage trees: skinnyEvent keeps side nodes and no leaves at all, and fatEvent's leaves
    // sit in its nodes, which this contract can't serve — FatIMTReadableStorage claims the one
    // `getFatLeaves` selector for the storage tree, so a contract holding both would have to dispatch.
    const [fatStorage, fatEvent, skinnyStorage, skinnyEvent] = await SkinnyFatContract.read.getTreeIds([0n]);
    const storageTreeIds = [fatStorage, skinnyStorage]

    let jsTree = new LeanIMT((a, b) => poseidon2Hash([a, b]))
    const leaves = [1n, 2n, 3n, 4n, 5n]
    jsTree.insertMany(leaves)
    await SkinnyFatContract.write.insertMany([leaves], { account: deployer.account, chain: publicClient.chain })
    // an update, so the tree that comes back can't be explained by appends alone
    jsTree = await randomUpdate(SkinnyFatContract, jsTree, storageSeed, deployer, publicClient)

    // chunkSize 2 over 5 leaves, so the read spans several eth_calls including a partial last one
    const synced = await trees.syncTreesStorage([...storageTreeIds], { chunkSize: 2n })
    assert.deepEqual(
      Object.keys(synced).sort(),
      storageTreeIds.map((id) => toHex(id)).sort(),
      "storage sync reproduced a different set of trees than it was asked for"
    )
    const onchainRoot = await SkinnyFatContract.read.root()
    for (const [treeId, tree] of Object.entries(synced)) {
      assert.deepEqual(tree.tree.leaves, jsTree.leaves, `tree ${treeId} has the wrong leaves after a storage sync`)
      assert.equal(rootOf(tree.tree), onchainRoot, `tree ${treeId} does not match the onchain root after a storage sync`)
    }

    // remember this state, the last assertion syncs back to it
    const pinnedBlock = await publicClient.getBlockNumber()
    const pinnedLeaves = jsTree.leaves

    // only inserts from here, so the second sync may keep the cached leaves and read just the new ones
    const appended = [6n, 7n, 8n]
    jsTree.insertMany(appended)
    await SkinnyFatContract.write.insertMany([appended], { account: deployer.account, chain: publicClient.chain })

    const resynced = await trees.syncTreesStorage([...storageTreeIds], { chunkSize: 2n, insertOnlyTrees: true })
    const appendedRoot = await SkinnyFatContract.read.root()
    assert.notEqual(appendedRoot, onchainRoot, "the appended leaves did not change the root")
    for (const [treeId, tree] of Object.entries(resynced)) {
      assert.deepEqual(tree.tree.leaves, jsTree.leaves, `tree ${treeId} has the wrong leaves after an incremental storage sync`)
      assert.equal(rootOf(tree.tree), appendedRoot, `tree ${treeId} does not match the onchain root after an incremental storage sync`)
    }

    // insertOnlyTrees is a promise the caller can get wrong: an update() rewrites a leaf below the
    // cached size, which no amount of appending can pick up. The root check has to catch that and
    // re-read the tree in full instead of caching a wrong one.
    jsTree = await randomUpdate(SkinnyFatContract, jsTree, sha256(concat([storageSeed, toHex("brokenPromise")])), deployer, publicClient)
    const repaired = await trees.syncTreesStorage([...storageTreeIds], { chunkSize: 2n, insertOnlyTrees: true })
    const updatedRoot = await SkinnyFatContract.read.root()
    assert.notEqual(updatedRoot, appendedRoot, "the update did not change the root")
    for (const [treeId, tree] of Object.entries(repaired)) {
      assert.deepEqual(tree.tree.leaves, jsTree.leaves, `tree ${treeId} kept the stale cached leaves of a wrongly promised insert-only tree`)
      assert.equal(rootOf(tree.tree), updatedRoot, `tree ${treeId} does not match the onchain root after repairing a stale cache`)
    }

    // reading past the end has to be reported. The fat event tree is the one that used to answer it:
    // its leaves live in a mapping, so every index past the end reads back as a leaf of 0.
    const chainId = await publicClient.getChainId()
    const blockNumber = await publicClient.getBlockNumber()
    const outOfRange = await trees.getLeavesStorage(toHex(fatEvent), chainId, 0n, BigInt(jsTree.size) + 1n, blockNumber)
      .then(() => undefined, (err: Error) => err)
    assert.ok(outOfRange, "reading a leaf range past the end of the tree resolved instead of reporting it")
    assert.match(outOfRange.message, /out of range/i, "the error should say the range is out of range")

    // a reset leaves the tree *smaller* than the cache, so the cached tree is trimmed back to the
    // onchain size and checked, rather than re-read. Re-inserting leaves the cache already holds as
    // its prefix is the case that survives that check.
    const keptPrefix = jsTree.leaves.slice(0, 3)
    await SkinnyFatContract.write.reset({ account: deployer.account, chain: publicClient.chain })
    await SkinnyFatContract.write.insertMany([keptPrefix], { account: deployer.account, chain: publicClient.chain })
    const trimmed = await trees.syncTreesStorage([...storageTreeIds], { chunkSize: 2n, insertOnlyTrees: true })
    const trimmedRoot = await SkinnyFatContract.read.root()
    for (const [treeId, tree] of Object.entries(trimmed)) {
      assert.deepEqual(tree.tree.leaves, keptPrefix, `tree ${treeId} was not trimmed back to the reset tree`)
      assert.equal(rootOf(tree.tree), trimmedRoot, `tree ${treeId} does not match the onchain root after a trim`)
    }

    // and the reset the sizes can't reveal: the tree grew back *past* the cached size, so it looks
    // like ordinary growth while every cached leaf is a different one. Only the root check sees it.
    const regrown = [11n, 12n, 13n, 14n, 15n]
    assert.ok(regrown.length > keptPrefix.length, "the regrown tree has to outgrow the cache to be this case")
    await SkinnyFatContract.write.reset({ account: deployer.account, chain: publicClient.chain })
    await SkinnyFatContract.write.insertMany([regrown], { account: deployer.account, chain: publicClient.chain })
    const regrownSynced = await trees.syncTreesStorage([...storageTreeIds], { chunkSize: 2n, insertOnlyTrees: true })
    const regrownRoot = await SkinnyFatContract.read.root()
    for (const [treeId, tree] of Object.entries(regrownSynced)) {
      assert.deepEqual(tree.tree.leaves, regrown, `tree ${treeId} kept cached leaves from before a reset it grew past`)
      assert.equal(rootOf(tree.tree), regrownRoot, `tree ${treeId} does not match the onchain root after a reset it grew past`)
    }

    // pinned to an older block, every read has to land on that block's state: the leaves from before
    // both resets, not the ones at head that the cache is currently holding.
    const historic = await trees.syncTreesStorage([...storageTreeIds], { chunkSize: 2n, blockNumber: pinnedBlock })
    for (const [treeId, tree] of Object.entries(historic)) {
      assert.deepEqual(tree.tree.leaves, pinnedLeaves, `tree ${treeId} did not sync to the state at block ${pinnedBlock}`)
      assert.equal(tree.lastSynced, pinnedBlock, `tree ${treeId} was not stamped with the block it was synced to`)
    }

    // and a tree whose leaves simply aren't in storage has to be reported, not synced to an empty tree
    const error = await new Trees(SkinnyFatContract.address, publicClient).syncTreesStorage([skinnyEvent])
      .then(() => undefined, (err: Error) => err)
    assert.ok(error, "storage syncing a skinny event tree resolved instead of reporting it")
    assert.match(error.message, /SKINNY_EVENT/, "the error should name the unsupported tree type")
  });

  // Same missing `treeState` entry, reached the other way: the pinned root is never found, so the scan
  // walks the whole range and comes back with nothing. That deserves a "root not found" error, not the
  // TypeError of reading `.lastSynced` off undefined. (If you'd rather return an empty tree here,
  // swap this for the leaves-are-empty assert above.)
  it("Should report a root that was never emitted instead of crashing", { timeout: 30_000 }, async function () {
    const trees = new Trees(SkinnyFatContract.address, publicClient)
    const treeIds = await SkinnyFatContract.read.getTreeIds([0n]);
    await SkinnyFatContract.write.insertMany([[1n, 2n, 3n]], { account: deployer.account, chain: publicClient.chain })
    const error = await trees.syncTreesEvent([...treeIds], { syncToRoot: 12345n })
      .then(() => undefined, (err: Error) => err)
    assert.ok(error, "syncing to a root that was never emitted resolved instead of reporting it")
    assert.match(error.message, /root/i, "the error should name the root it could not find")
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

async function randomReset(
  SkinnyFatContract: SkinnyFatContractType,
  jsTree: LeanIMT,
  seed: Hex,
  WalletClient: WalletWithAccount,
  publicClient: PublicClient
) {
  await SkinnyFatContract.write.reset({ account: WalletClient.account, chain: publicClient.chain });
  // LeanIMT has no reset, so mirror it with a fresh tree carrying the same hash function
  return new LeanIMT((jsTree as any)._hash)
}

async function randomTree(
  SkinnyFatContract: SkinnyFatContractType,
  jsTree: LeanIMT,
  seed: Hex,
  walletClient: WalletWithAccount,
  publicClient: PublicClient,
  minOps = 0,
  ops = [
    randomInsert,
    randomInsertMany,
    randomInsertRepeated,
    randomUpdate,
    randomUpdateMany,
    randomReset,
  ],
  numTxs = 10
) {
  // add minimum amount of operations per functions
  const schedule: number[] = []
  for (let i = 0; i < ops.length; i++) {
    schedule.push(...new Array(minOps).fill(i))
  }

  // add random operations
  for (let i = 0; i < numTxs; i++) {
    schedule.push(Number(BigInt(sha256(concat([seed, toHex(`extraOp${i}`)]))) % BigInt(ops.length)))
  }

  // Shuffle
  for (let i = schedule.length - 1; i > 0; i--) {
    const j = Number(BigInt(sha256(concat([seed, toHex(`shuffle${i}`)]))) % BigInt(i + 1))
    const tmp = schedule[i]
    schedule[i] = schedule[j]
    schedule[j] = tmp
  }

  // run
  for (let index = 0; index < schedule.length; index++) {
    const iterSeed = sha256(concat([seed, toHex(`iter${index}`)]))
    jsTree = await ops[schedule[index]](SkinnyFatContract, jsTree, iterSeed, walletClient, publicClient)
  }
  return jsTree
}
