import { toFunctionSelector, toHex, type Abi, type AbiFunction, type Address, type Hex, type PublicClient } from "viem";

/** Function selectors of an ABI, excluding ERC-165's own `supportsInterface`. */
function interfaceSelectors(abi: Abi): Hex[] {
    return abi
        .filter((item): item is AbiFunction => item.type === "function" && item.name !== "supportsInterface")
        .map((fn) => toFunctionSelector(fn));
}

/**
 * ERC-165 interface id (`type(I).interfaceId`) for a Solidity interface, computed from its
 * ABI: the XOR of the interface's function selectors. Pass an artifact's `.abi` straight in.
 *
 * A compiled ABI flattens every inherited function in, but Solidity excludes inherited
 * functions from `type(I).interfaceId`. So `excludeFunctionsOf` lets you subtract functions
 * that belong to a base — pass the base interface's ABI(s) and their functions are removed
 * before the XOR. The common case is an interface that extends another (e.g.
 * `IFatIMTReadableStorage is IFatIMTReadableEvent` → pass the event ABI); a plain interface
 * extending only `IERC165` needs nothing, since `supportsInterface` is always excluded.
 *
 * @param abi the interface's ABI (e.g. `artifact.abi`)
 * @param excludeFunctionsOf ABIs whose functions to subtract first — typically the base
 *        interface(s) `abi` inherits; `IERC165` is already handled
 */
export function getInterfaceId(abi: Abi, excludeFunctionsOf: readonly Abi[] = []): Hex {
    const excluded = new Set(excludeFunctionsOf.flatMap(interfaceSelectors));
    let id = 0n;
    for (const selector of interfaceSelectors(abi)) {
        if (excluded.has(selector)) continue;
        id ^= BigInt(selector);
    }
    return toHex(id, { size: 4 });
}

/**
 * The ERC-165 `supportsInterface(bytes4)` function. Its selector (`0x01ffc9a7`) and signature
 * are fixed by the standard, so this ABI is identical on every ERC-165 contract.
 */
export const SUPPORTS_INTERFACE_ABI = [
    {
        type: "function",
        name: "supportsInterface",
        stateMutability: "view",
        inputs: [{ name: "interfaceId", type: "bytes4" }],
        outputs: [{ name: "", type: "bool" }],
    },
] as const satisfies Abi;

/** Whether `address` reports support for `interfaceId` via ERC-165 `supportsInterface`. */
export function supportsInterface(client: PublicClient, address: Address, interfaceId: Hex): Promise<boolean> {
    return client.readContract({
        address,
        abi: SUPPORTS_INTERFACE_ABI,
        functionName: "supportsInterface",
        args: [interfaceId],
    });
}

/**
 * Probe a contract for a batch of ERC-165 interfaces at once. Give it a map of your own
 * labels to interface ids (e.g. `{ erc721: "0x80ac58cd", metadata: "0x5b5e139f" }`) and it
 * returns the same labels mapped to whether the contract reports support. All queries run
 * concurrently.
 *
 * @param client viem public client to read with
 * @param address address of the (deployed) contract to probe
 * @param interfaceIds map of caller-chosen labels to the interface ids to check
 */
export async function detectSupportedInterfaces<K extends string>(
    client: PublicClient,
    address: Address,
    interfaceIds: Record<K, Hex>,
): Promise<Record<K, boolean>> {
    const labels = Object.keys(interfaceIds) as K[];
    const supported = await Promise.all(labels.map((label) => supportsInterface(client, address, interfaceIds[label])));
    return Object.fromEntries(labels.map((label, i) => [label, supported[i]])) as Record<K, boolean>;
}
