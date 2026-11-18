// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PriceOracle} from "../src/PriceOracle.sol";
import {LendingVault} from "../src/LendingVault.sol";
import {MarginManager} from "../src/MarginManager.sol";
import {IMarginManager} from "../src/interfaces/IMarginManager.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

abstract contract Base is Test {
    uint256 internal constant T0 = 1_800_000_000;
    /// @dev Open fee of the standard position: 1% of the 480 USDC borrowed.
    uint256 internal constant FEE = 4_800_000;
    bytes32 internal constant MARKET = keccak256("GEMI-BTC2611152200-HI61750");

    address internal admin = makeAddr("admin");
    address internal exec = makeAddr("executor");
    address internal lp = makeAddr("lp");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    MockUSDC internal usdc;
    PriceOracle internal oracle;
    LendingVault internal vault;
    MarginManager internal manager;

    uint256 internal closeTime;

    function setUp() public virtual {
        vm.warp(T0);
        usdc = new MockUSDC();
        oracle = new PriceOracle(admin);
        vault = new LendingVault(admin, IERC20(address(usdc)));
        manager = new MarginManager(admin, address(usdc), address(vault), address(oracle), exec);

        vm.startPrank(admin);
        vault.setMarginManager(address(manager));
        oracle.setPoster(exec, true);
        vm.stopPrank();

        closeTime = T0 + 1 days;
        vm.prank(exec);
        oracle.registerMarket(MARKET, closeTime);
        _post(590_000, 600_000);

        usdc.mint(lp, 10_000e6);
        vm.startPrank(lp);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(10_000e6, lp);
        vm.stopPrank();

        usdc.mint(exec, 100_000e6);
        vm.prank(exec);
        usdc.approve(address(manager), type(uint256).max);

        address[2] memory traders = [alice, bob];
        for (uint256 i; i < traders.length; ++i) {
            usdc.mint(traders[i], 10_000e6);
            vm.prank(traders[i]);
            usdc.approve(address(manager), type(uint256).max);
        }
    }

    function _post(uint256 bid, uint256 ask) internal {
        bytes32[] memory ids = new bytes32[](1);
        uint256[] memory bids = new uint256[](1);
        uint256[] memory asks = new uint256[](1);
        ids[0] = MARKET;
        bids[0] = bid;
        asks[0] = ask;
        vm.prank(exec);
        oracle.postPrices(ids, bids, asks);
    }

    function _open(address who, uint8 side, uint256 margin, uint256 leverage) internal returns (uint256 id) {
        vm.prank(who);
        id = manager.openPosition(MARKET, side, margin, leverage);
    }

    function _fill(uint256 id, uint256 price, uint256 contracts) internal {
        vm.prank(exec);
        manager.recordFill(id, price, contracts);
    }

    /// @dev Alice: 120 USDC at 5x on YES, filled 1000 contracts at 0.60.
    ///      size 600, borrowed 480, fee 4.80, cost 600, liqPrice 0.52.
    function _openStandard() internal returns (uint256 id) {
        id = _open(alice, 0, 120e6, 50);
        _fill(id, 600_000, 1_000e6);
    }

    function _pos(uint256 id) internal view returns (IMarginManager.Position memory) {
        return manager.getPosition(id);
    }
}
