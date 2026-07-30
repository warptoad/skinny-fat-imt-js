import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    // These libraries live in node_modules; Hardhat 3 only emits deployable
    // artifacts for local sources, so list them here to get artifacts we can
    // deploy + link against SkinnyFat.
    npmFilesToBuild: [
      // Abstract read interfaces — no deployable bytecode, but we need their
      // artifacts so we can derive viem contract types from their ABIs.
      "@warptoad/skinny-imt.sol/SkinnyIMTReadableStorage.sol",
      "@warptoad/skinny-imt.sol/SkinnyIMTReadableEvent.sol",
      "@warptoad/fat-imt.sol/FatIMTReadableStorage.sol",
      "@warptoad/fat-imt.sol/FatIMTReadableEvent.sol",

      // ERC-165 interfaces — we read each one's `type(I).interfaceId` off its
      // artifact ABI to detect which read ABIs a deployed contract exposes.
      "@warptoad/skinny-imt.sol/interfaces/ISkinnyIMTReadableStorage.sol",
      "@warptoad/skinny-imt.sol/interfaces/ISkinnyIMTReadableEvent.sol",
      "@warptoad/fat-imt.sol/interfaces/IFatIMTReadableStorage.sol",
      "@warptoad/fat-imt.sol/interfaces/IFatIMTReadableEvent.sol",

      "@warptoad/skinny-imt.sol/poseidon2/SkinnyIMTPoseidon2WriteStorage.sol",
      "@warptoad/skinny-imt.sol/poseidon2/SkinnyIMTPoseidon2WriteEvent.sol",
      "@warptoad/fat-imt.sol/poseidon2/FatIMTPoseidon2WriteStorage.sol",
      "@warptoad/fat-imt.sol/poseidon2/FatIMTPoseidon2WriteEvent.sol",

      "@warptoad/skinny-imt.sol/poseidon2/SkinnyIMTPoseidon2Read.sol",
      "@warptoad/fat-imt.sol/poseidon2/FatIMTPoseidon2Read.sol",
    ],
    profiles: {
      default: {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 2 ** 32 - 1,
          },
        },
      },
      production: {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 2 ** 32 - 1,
          },
        },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    hardhatOp: {
      type: "edr-simulated",
      chainType: "op",
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [configVariable("SEPOLIA_PRIVATE_KEY")],
    },
  },
});
