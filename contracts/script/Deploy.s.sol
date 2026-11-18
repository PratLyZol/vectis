// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PriceOracle} from "../src/PriceOracle.sol";
import {LendingVault} from "../src/LendingVault.sol";
import {MarginManager} from "../src/MarginManager.sol";
import {MockUSDC} from "../test/mocks/MockUSDC.sol";

/// @notice Deploys Vectis and writes the addresses for the web app and the keeper.
/// Env: DEPLOYER_PRIVATE_KEY (required), USDC_ADDRESS, DEPLOY_MOCK_USDC, EXECUTOR, SEED_VAULT_USDC,
///      WRITE_ADDRESSES.
contract Deploy is Script {
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    string internal constant TS_PATH = "../web/src/config/addresses.ts";
    string internal constant JSON_PATH = "../keeper/addresses.json";

    struct Deployment {
        uint256 chainId;
        address usdc;
        address priceOracle;
        address lendingVault;
        address marginManager;
        uint256 deployBlock;
    }

    function run() external returns (Deployment memory d) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address executor = vm.envOr("EXECUTOR", deployer);
        uint256 seed = vm.envOr("SEED_VAULT_USDC", uint256(0));

        d.chainId = block.chainid;
        d.deployBlock = block.number;

        vm.startBroadcast(pk);

        if (vm.envOr("DEPLOY_MOCK_USDC", false)) {
            MockUSDC mock = new MockUSDC();
            mock.mint(deployer, 1_000_000e6);
            d.usdc = address(mock);
        } else {
            d.usdc = vm.envOr("USDC_ADDRESS", ARC_USDC);
        }

        PriceOracle oracle = new PriceOracle(deployer);
        LendingVault vault = new LendingVault(deployer, IERC20(d.usdc));
        MarginManager manager = new MarginManager(deployer, d.usdc, address(vault), address(oracle), executor);

        vault.setMarginManager(address(manager));
        oracle.setPoster(executor, true);

        if (seed > 0) {
            IERC20(d.usdc).approve(address(vault), seed);
            vault.deposit(seed, deployer);
        }

        vm.stopBroadcast();

        d.priceOracle = address(oracle);
        d.lendingVault = address(vault);
        d.marginManager = address(manager);

        console2.log("chainId      ", d.chainId);
        console2.log("usdc         ", d.usdc);
        console2.log("priceOracle  ", d.priceOracle);
        console2.log("lendingVault ", d.lendingVault);
        console2.log("marginManager", d.marginManager);
        console2.log("executor     ", executor);
        console2.log("deployBlock  ", d.deployBlock);

        if (vm.envOr("WRITE_ADDRESSES", true)) {
            vm.writeFile(TS_PATH, renderTs(d));
            vm.writeFile(JSON_PATH, renderJson(d));
        }
    }

    function renderTs(Deployment memory d) public pure returns (string memory) {
        return string.concat(
            "// Written by contracts/script/Deploy.s.sol. Zero addresses mean \"not deployed\": the UI runs on mock data.\n",
            "export const addresses = {\n",
            "  chainId: ",
            vm.toString(d.chainId),
            ",\n",
            _line("usdc", d.usdc, ",\n"),
            _line("priceOracle", d.priceOracle, ",\n"),
            _line("lendingVault", d.lendingVault, ",\n"),
            _line("marginManager", d.marginManager, ",\n"),
            "  deployBlock: ",
            vm.toString(d.deployBlock),
            ",\n} as const;\n"
        );
    }

    function renderJson(Deployment memory d) public pure returns (string memory) {
        return string.concat(
            "{\n  \"chainId\": ",
            vm.toString(d.chainId),
            ",\n",
            _jsonLine("usdc", d.usdc),
            _jsonLine("priceOracle", d.priceOracle),
            _jsonLine("lendingVault", d.lendingVault),
            _jsonLine("marginManager", d.marginManager),
            "  \"deployBlock\": ",
            vm.toString(d.deployBlock),
            "\n}\n"
        );
    }

    function _line(string memory key, address value, string memory end) private pure returns (string memory) {
        return string.concat("  ", key, ": \"", vm.toString(value), "\"", end);
    }

    function _jsonLine(string memory key, address value) private pure returns (string memory) {
        return string.concat("  \"", key, "\": \"", vm.toString(value), "\",\n");
    }
}
