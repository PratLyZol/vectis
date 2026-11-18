// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";

contract DeployRenderTest is Test {
    function _sample() internal pure returns (Deploy.Deployment memory d) {
        d.chainId = 5042002;
        d.usdc = 0x3600000000000000000000000000000000000000;
        d.priceOracle = address(0x1111111111111111111111111111111111111111);
        d.lendingVault = address(0x2222222222222222222222222222222222222222);
        d.marginManager = address(0x3333333333333333333333333333333333333333);
        d.deployBlock = 123;
    }

    function test_renderTs_exactShape() public {
        string memory expected = string.concat(
            "// Written by contracts/script/Deploy.s.sol. Zero addresses mean \"not deployed\": the UI runs on mock data.\n",
            "export const addresses = {\n",
            "  chainId: 5042002,\n",
            "  usdc: \"0x3600000000000000000000000000000000000000\",\n",
            "  priceOracle: \"0x1111111111111111111111111111111111111111\",\n",
            "  lendingVault: \"0x2222222222222222222222222222222222222222\",\n",
            "  marginManager: \"0x3333333333333333333333333333333333333333\",\n",
            "  deployBlock: 123,\n",
            "} as const;\n"
        );
        assertEq(new Deploy().renderTs(_sample()), expected);
    }

    function test_renderJson_parses() public {
        string memory json = new Deploy().renderJson(_sample());
        assertEq(vm.parseJsonUint(json, ".chainId"), 5042002);
        assertEq(vm.parseJsonAddress(json, ".usdc"), 0x3600000000000000000000000000000000000000);
        assertEq(vm.parseJsonAddress(json, ".priceOracle"), address(0x1111111111111111111111111111111111111111));
        assertEq(vm.parseJsonAddress(json, ".lendingVault"), address(0x2222222222222222222222222222222222222222));
        assertEq(vm.parseJsonAddress(json, ".marginManager"), address(0x3333333333333333333333333333333333333333));
        assertEq(vm.parseJsonUint(json, ".deployBlock"), 123);
    }
}
