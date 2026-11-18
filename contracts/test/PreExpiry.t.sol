// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IMarginManager} from "../src/interfaces/IMarginManager.sol";
import {Base} from "./Base.t.sol";

contract PreExpiryTest is Base {
    function test_maxLeverage_priceBasedBeforeFinalHour() public {
        vm.warp(closeTime - 3601);
        _post(590_000, 600_000);
        assertEq(manager.maxLeverage(MARKET, 0), 50);
        assertEq(manager.maxLeverage(MARKET, 1), 30);
        _open(alice, 0, 100e6, 50);
    }

    function test_maxLeverage_oneXInsideFinalHour() public {
        vm.warp(closeTime - 3600);
        _post(590_000, 600_000);
        assertEq(manager.maxLeverage(MARKET, 0), 10);
        assertEq(manager.maxLeverage(MARKET, 1), 10);

        vm.warp(closeTime - 1);
        _post(590_000, 600_000);
        assertEq(manager.maxLeverage(MARKET, 0), 10);
    }

    function test_maxLeverage_revertsOnceClosed() public {
        vm.warp(closeTime - 1);
        _post(590_000, 600_000);
        vm.warp(closeTime);
        vm.expectRevert(IMarginManager.MarketClosed.selector);
        manager.maxLeverage(MARKET, 0);

        vm.prank(alice);
        vm.expectRevert(IMarginManager.MarketClosed.selector);
        manager.openPosition(MARKET, 0, 100e6, 10);
    }

    function test_open_aboveOneXRevertsInsideFinalHour() public {
        vm.warp(closeTime - 3600);
        _post(590_000, 600_000);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IMarginManager.InvalidLeverage.selector, 15, 10));
        manager.openPosition(MARKET, 0, 100e6, 15);

        uint256 id = _open(alice, 0, 100e6, 10); // 1x still allowed
        assertEq(_pos(id).borrowed, 0);
    }

    function test_leveragedPosition_liquidatableInWindow_freshPrice() public {
        uint256 id = _openStandard();

        vm.warp(closeTime - 3601);
        _post(700_000, 710_000);
        (bool ok,) = manager.isLiquidatable(id);
        assertFalse(ok);
        vm.expectRevert(IMarginManager.NotLiquidatable.selector);
        manager.liquidate(id);

        vm.warp(closeTime - 3600);
        (bool ok2, uint8 reason) = manager.isLiquidatable(id);
        assertTrue(ok2);
        assertEq(reason, 1);

        vm.expectEmit();
        emit IMarginManager.PositionLiquidated(id, bob, 700_000, 1);
        vm.prank(bob);
        manager.liquidate(id);

        IMarginManager.Position memory p = _pos(id);
        assertTrue(p.liquidated);
        assertEq(uint8(p.status), uint8(IMarginManager.Status.PendingClose));

        // deleveraged at a profit: sold at 0.70 -> proceeds 700, vault 480, alice 220
        vm.expectEmit();
        emit IMarginManager.PositionSettled(id, 700_000, 700e6, 480e6, 0, 220e6);
        _fill(id, 700_000, 1_000e6);

        assertEq(usdc.balanceOf(alice), 10_000e6 - FEE + 100e6);
        assertEq(vault.totalBorrowed(), 0);
        assertEq(vault.totalAssets(), 10_000e6 + FEE);
        assertEq(usdc.balanceOf(address(manager)), 0);
        assertEq(manager.activePositionIds().length, 0);
    }

    function test_leveragedPosition_liquidatableInWindow_stalePrice() public {
        uint256 id = _openStandard(); // last post: bid 0.59 at T0
        vm.warp(closeTime - 1800);

        (bool ok, uint8 reason) = manager.isLiquidatable(id);
        assertTrue(ok);
        assertEq(reason, 1);

        // mark is the last posted bid
        vm.expectEmit();
        emit IMarginManager.PositionLiquidated(id, address(this), 590_000, 1);
        manager.liquidate(id);
        _fill(id, 580_000, 1_000e6);
        assertEq(usdc.balanceOf(alice), 10_000e6 - FEE - 20e6);
        assertEq(vault.totalAssets(), 10_000e6 + FEE);
    }

    function test_leveragedPosition_liquidatableAfterClose() public {
        uint256 id = _openStandard();
        vm.warp(closeTime + 1 days);
        (bool ok, uint8 reason) = manager.isLiquidatable(id);
        assertTrue(ok);
        assertEq(reason, 1);
        manager.liquidate(id);

        // market resolved NO: contracts worth zero, vault eats the debt
        _fill(id, 0, 1_000e6);
        assertEq(vault.totalAssets(), 10_000e6 + FEE - 480e6);
        assertEq(uint8(_pos(id).status), uint8(IMarginManager.Status.Closed));
    }

    function test_priceBreachInsideWindowReportsReasonZero() public {
        uint256 id = _openStandard();
        vm.warp(closeTime - 100);
        _post(500_000, 510_000);
        (bool ok, uint8 reason) = manager.isLiquidatable(id);
        assertTrue(ok);
        assertEq(reason, 0);
    }

    function test_oneXPosition_notLiquidatableInWindow() public {
        uint256 id = _open(alice, 0, 120e6, 10);
        _fill(id, 600_000, 200e6);

        vm.warp(closeTime - 60);
        _post(10_000, 20_000);
        (bool ok,) = manager.isLiquidatable(id);
        assertFalse(ok);
        vm.expectRevert(IMarginManager.NotLiquidatable.selector);
        manager.liquidate(id);

        vm.warp(closeTime + 1);
        (ok,) = manager.isLiquidatable(id);
        assertFalse(ok);

        // the owner can still close and settle after expiry
        vm.prank(alice);
        manager.closePosition(id);
        _fill(id, 1_000_000, 200e6);
        assertEq(usdc.balanceOf(alice), 10_000e6 + 80e6);
    }

    function test_deleveragedByRefund_notLiquidatableInWindow() public {
        // opened at 5x but the fill used less than the margin, so nothing is owed
        uint256 id = _open(alice, 0, 120e6, 50);
        _fill(id, 600_000, 100e6);
        vm.warp(closeTime - 60);
        (bool ok,) = manager.isLiquidatable(id);
        assertFalse(ok);
    }

    function test_pendingOpen_notLiquidatableInWindow() public {
        uint256 id = _open(alice, 0, 120e6, 50);
        vm.warp(closeTime - 60);
        (bool ok,) = manager.isLiquidatable(id);
        assertFalse(ok);
    }
}
