// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IMarginManager} from "../src/interfaces/IMarginManager.sol";
import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";
import {ILendingVault} from "../src/interfaces/ILendingVault.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Base} from "./Base.t.sol";

contract MarginManagerTest is Base {
    // ------------------------------------------------------------ config

    function test_constantsAndWiring() public view {
        assertEq(manager.LEVERAGE_UNIT(), 10);
        assertEq(manager.MAX_LEVERAGE(), 50);
        assertEq(manager.LEVERAGE_PRICE_DIVISOR(), 120_000);
        assertEq(manager.LIQ_BUFFER(), 40_000);
        assertEq(manager.DELEVERAGE_WINDOW(), 3600);
        assertEq(manager.MIN_MARGIN(), 1e6);
        assertEq(manager.OPEN_FEE_BPS(), 100);
        assertEq(manager.usdc(), address(usdc));
        assertEq(manager.vault(), address(vault));
        assertEq(manager.oracle(), address(oracle));
        assertEq(manager.executor(), exec);
        assertEq(manager.owner(), admin);
        assertEq(manager.nextPositionId(), 1);
    }

    function test_setExecutor_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        manager.setExecutor(alice);

        vm.expectEmit();
        emit IMarginManager.ExecutorUpdated(bob);
        vm.prank(admin);
        manager.setExecutor(bob);
        assertEq(manager.executor(), bob);

        uint256 id = _open(alice, 0, 100e6, 10);
        vm.prank(exec);
        vm.expectRevert(IMarginManager.NotExecutor.selector);
        manager.recordFill(id, 600_000, 100e6);
    }

    // ----------------------------------------------------- leverage rules

    function test_maxLeverageForPrice_examples() public view {
        assertEq(manager.maxLeverageForPrice(600_000), 50);
        assertEq(manager.maxLeverageForPrice(990_000), 50);
        assertEq(manager.maxLeverageForPrice(599_999), 45);
        assertEq(manager.maxLeverageForPrice(500_000), 40);
        assertEq(manager.maxLeverageForPrice(300_000), 25);
        assertEq(manager.maxLeverageForPrice(200_000), 15);
        assertEq(manager.maxLeverageForPrice(180_000), 15);
        assertEq(manager.maxLeverageForPrice(179_999), 10);
        assertEq(manager.maxLeverageForPrice(100_000), 10);
        assertEq(manager.maxLeverageForPrice(0), 10);
    }

    function test_maxLeverage_usesSideAsk() public {
        _post(590_000, 600_000);
        assertEq(manager.maxLeverage(MARKET, 0), 50); // YES ask 0.60
        assertEq(manager.maxLeverage(MARKET, 1), 30); // NO ask 0.41 -> 3.41x -> 3.0x

        _post(290_000, 300_000);
        assertEq(manager.maxLeverage(MARKET, 0), 25); // YES ask 0.30
        assertEq(manager.maxLeverage(MARKET, 1), 50); // NO ask 0.71
    }

    function test_maxLeverage_reverts() public {
        vm.expectRevert(IMarginManager.InvalidSide.selector);
        manager.maxLeverage(MARKET, 2);

        bytes32 unknown = keccak256("nope");
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.UnknownMarket.selector, unknown));
        manager.maxLeverage(unknown, 0);

        vm.warp(T0 + 61);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.StalePrice.selector, MARKET, T0));
        manager.maxLeverage(MARKET, 0);
    }

    function test_liquidationPrice_helper() public view {
        assertEq(manager.liquidationPrice(0, 1_000e6), 0);
        assertEq(manager.liquidationPrice(480e6, 1_000e6), 520_000);
        assertEq(manager.liquidationPrice(1, 3), 333_334 + 40_000); // rounds up
    }

    // --------------------------------------------------------------- open

    function test_previewOpen() public view {
        (uint256 size, uint256 contracts, uint256 borrowed, uint256 liqPrice, uint256 refPrice) =
            manager.previewOpen(MARKET, 0, 120e6, 50);
        assertEq(size, 600e6);
        assertEq(contracts, 1_000e6);
        assertEq(borrowed, 480e6);
        assertEq(liqPrice, 520_000);
        assertEq(refPrice, 600_000);

        (size, contracts, borrowed, liqPrice, refPrice) = manager.previewOpen(MARKET, 1, 41e6, 10);
        assertEq(size, 41e6);
        assertEq(contracts, 100e6);
        assertEq(borrowed, 0);
        assertEq(liqPrice, 0);
        assertEq(refPrice, 410_000);
    }

    function test_openPosition_happyPath() public {
        vm.expectEmit();
        emit ILendingVault.Borrowed(480e6, 480e6);
        vm.expectEmit();
        emit IMarginManager.PositionOpened(1, alice, MARKET, 0, 120e6, 50, 480e6, 600_000);
        uint256 id = _open(alice, 0, 120e6, 50);

        assertEq(id, 1);
        assertEq(manager.nextPositionId(), 2);
        IMarginManager.Position memory p = _pos(id);
        assertEq(p.owner, alice);
        assertEq(p.marketId, MARKET);
        assertEq(p.side, 0);
        assertEq(uint8(p.status), uint8(IMarginManager.Status.PendingOpen));
        assertFalse(p.liquidated);
        assertEq(p.margin, 120e6);
        assertEq(p.leverage, 50);
        assertEq(p.borrowed, 480e6);
        assertEq(p.cost, 0);
        assertEq(p.contracts, 0);
        assertEq(p.liqPrice, 0);
        assertEq(p.openedAt, T0);

        assertEq(usdc.balanceOf(alice), 10_000e6 - FEE - 120e6);
        assertEq(usdc.balanceOf(address(manager)), 600e6);
        assertEq(vault.totalBorrowed(), 480e6);
        assertEq(vault.totalAssets(), 10_000e6 + FEE);
    }

    function test_openPosition_noSideUsesNoAsk() public {
        vm.expectEmit();
        emit IMarginManager.PositionOpened(1, bob, MARKET, 1, 100e6, 30, 200e6, 410_000);
        _open(bob, 1, 100e6, 30);
    }

    function test_openPosition_tracksIds() public {
        uint256 a1 = _open(alice, 0, 10e6, 10);
        uint256 b1 = _open(bob, 1, 10e6, 20);
        uint256 a2 = _open(alice, 0, 10e6, 15);

        uint256[] memory a = manager.positionsOf(alice);
        assertEq(a.length, 2);
        assertEq(a[0], a1);
        assertEq(a[1], a2);
        assertEq(manager.positionsOf(bob)[0], b1);
        assertEq(manager.activePositionIds().length, 3);
    }

    function test_openPosition_invalidSide() public {
        vm.prank(alice);
        vm.expectRevert(IMarginManager.InvalidSide.selector);
        manager.openPosition(MARKET, 2, 100e6, 10);
    }

    function test_openPosition_invalidMargin() public {
        vm.prank(alice);
        vm.expectRevert(IMarginManager.InvalidMargin.selector);
        manager.openPosition(MARKET, 0, 1e6 - 1, 10);
        _open(alice, 0, 1e6, 10);
    }

    function test_openPosition_invalidLeverage() public {
        uint256[4] memory bad = [uint256(5), 0, 12, 55];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(alice);
            vm.expectRevert(abi.encodeWithSelector(IMarginManager.InvalidLeverage.selector, bad[i], 50));
            manager.openPosition(MARKET, 0, 100e6, bad[i]);
        }
        // NO side at ask 0.41 is capped at 3.0x
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IMarginManager.InvalidLeverage.selector, 35, 30));
        manager.openPosition(MARKET, 1, 100e6, 35);
    }

    function test_openPosition_stalePrice() public {
        vm.warp(T0 + 61);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.StalePrice.selector, MARKET, T0));
        manager.openPosition(MARKET, 0, 100e6, 10);
    }

    function test_openPosition_insufficientVaultLiquidity() public {
        usdc.mint(alice, 10_000e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ILendingVault.InsufficientLiquidity.selector, 12_000e6, 10_000e6));
        manager.openPosition(MARKET, 0, 3_000e6, 50);
    }

    // ---------------------------------------------------------- open fill

    function test_recordFill_onlyExecutor() public {
        uint256 id = _open(alice, 0, 120e6, 50);
        vm.prank(alice);
        vm.expectRevert(IMarginManager.NotExecutor.selector);
        manager.recordFill(id, 600_000, 1_000e6);
        vm.prank(admin);
        vm.expectRevert(IMarginManager.NotExecutor.selector);
        manager.recordFill(id, 600_000, 1_000e6);
    }

    function test_recordFill_wrongStatus() public {
        vm.prank(exec);
        vm.expectRevert(abi.encodeWithSelector(IMarginManager.WrongStatus.selector, IMarginManager.Status.None));
        manager.recordFill(99, 600_000, 1e6);

        uint256 id = _openStandard();
        vm.prank(exec);
        vm.expectRevert(abi.encodeWithSelector(IMarginManager.WrongStatus.selector, IMarginManager.Status.Open));
        manager.recordFill(id, 600_000, 1_000e6);
    }

    function test_openFill_exact() public {
        uint256 id = _open(alice, 0, 120e6, 50);
        vm.expectEmit();
        emit IMarginManager.FillRecorded(id, 600_000, 1_000e6, 480e6, 520_000);
        _fill(id, 600_000, 1_000e6);

        IMarginManager.Position memory p = _pos(id);
        assertEq(uint8(p.status), uint8(IMarginManager.Status.Open));
        assertEq(p.cost, 600e6);
        assertEq(p.entryPrice, 600_000);
        assertEq(p.contracts, 1_000e6);
        assertEq(p.borrowed, 480e6);
        assertEq(p.liqPrice, 520_000);
        assertEq(usdc.balanceOf(address(manager)), 600e6);
    }

    function test_openFill_invalid() public {
        uint256 id = _open(alice, 0, 120e6, 50);
        vm.startPrank(exec);
        vm.expectRevert(IMarginManager.InvalidFill.selector);
        manager.recordFill(id, 0, 1_000e6);
        vm.expectRevert(IMarginManager.InvalidFill.selector);
        manager.recordFill(id, 1_000_000, 100e6);
        vm.expectRevert(IMarginManager.InvalidFill.selector);
        manager.recordFill(id, 600_000, 0);
        vm.expectRevert(IMarginManager.InvalidFill.selector);
        manager.recordFill(id, 600_000, 1_000e6 + 2); // cost rounds up to 600.000002 > size
        vm.stopPrank();
    }

    function test_openFill_unusedRepaysVaultFirst() public {
        uint256 id = _open(alice, 0, 120e6, 50);
        // 800 contracts at 0.60: cost 480, unused 120 -> all to the vault
        vm.expectEmit();
        emit ILendingVault.Repaid(120e6, 0, 360e6);
        vm.expectEmit();
        emit IMarginManager.FillRecorded(id, 600_000, 800e6, 360e6, 490_000);
        _fill(id, 600_000, 800e6);

        IMarginManager.Position memory p = _pos(id);
        assertEq(p.cost, 480e6);
        assertEq(p.borrowed, 360e6);
        assertEq(p.liqPrice, 490_000);
        assertEq(p.margin, 120e6);
        assertEq(vault.totalBorrowed(), 360e6);
        assertEq(usdc.balanceOf(address(manager)), 480e6);
        assertEq(usdc.balanceOf(alice), 10_000e6 - FEE - 120e6);
        assertEq(vault.totalAssets(), 10_000e6 + FEE);
    }

    function test_openFill_unusedBeyondBorrowGoesToOwner() public {
        uint256 id = _open(alice, 0, 120e6, 50);
        // 100 contracts at 0.60: cost 60, unused 540 -> 480 to the vault, 60 to alice
        _fill(id, 600_000, 100e6);

        IMarginManager.Position memory p = _pos(id);
        assertEq(p.cost, 60e6);
        assertEq(p.borrowed, 0);
        assertEq(p.liqPrice, 0);
        assertEq(vault.totalBorrowed(), 0);
        assertEq(vault.availableLiquidity(), 10_000e6 + FEE);
        assertEq(usdc.balanceOf(address(manager)), 60e6);
        assertEq(usdc.balanceOf(alice), 10_000e6 - FEE - 60e6);
        assertEq(manager.health(id), 10_000);
    }

    function test_openFill_unleveragedRefundsOwner() public {
        uint256 id = _open(alice, 0, 120e6, 10);
        _fill(id, 500_000, 200e6); // cost 100, 20 back
        assertEq(_pos(id).cost, 100e6);
        assertEq(usdc.balanceOf(alice), 10_000e6 - 100e6);
        assertEq(vault.totalBorrowed(), 0);
    }

    function test_openFill_costRoundsUp() public {
        uint256 id = _open(alice, 0, 120e6, 50);
        _fill(id, 333_333, 1_000_001); // 0.333333333333 -> 333334 wei
        assertEq(_pos(id).cost, 333_334);
    }

    // -------------------------------------------------------------- close

    function test_closePosition_onlyOwner() public {
        uint256 id = _openStandard();
        vm.prank(bob);
        vm.expectRevert(IMarginManager.NotPositionOwner.selector);
        manager.closePosition(id);
        vm.prank(exec);
        vm.expectRevert(IMarginManager.NotPositionOwner.selector);
        manager.closePosition(id);
    }

    function test_closePosition_wrongStatus() public {
        uint256 id = _open(alice, 0, 120e6, 50);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IMarginManager.WrongStatus.selector, IMarginManager.Status.PendingOpen));
        manager.closePosition(id);

        _fill(id, 600_000, 1_000e6);
        vm.startPrank(alice);
        manager.closePosition(id);
        vm.expectRevert(abi.encodeWithSelector(IMarginManager.WrongStatus.selector, IMarginManager.Status.PendingClose));
        manager.closePosition(id);
        vm.stopPrank();
    }

    function test_fullCycle_profit() public {
        uint256 id = _openStandard();
        uint256 execBefore = usdc.balanceOf(exec);

        vm.expectEmit();
        emit IMarginManager.PositionClosed(id, alice);
        vm.prank(alice);
        manager.closePosition(id);
        assertEq(uint8(_pos(id).status), uint8(IMarginManager.Status.PendingClose));

        // exit 0.80: proceeds 800, executor tops up 200, vault 480, alice 320
        vm.expectEmit();
        emit ILendingVault.Repaid(480e6, 0, 0);
        vm.expectEmit();
        emit IMarginManager.PositionSettled(id, 800_000, 800e6, 480e6, 0, 320e6);
        _fill(id, 800_000, 1_000e6);

        IMarginManager.Position memory p = _pos(id);
        assertEq(uint8(p.status), uint8(IMarginManager.Status.Closed));
        assertEq(p.borrowed, 0);
        assertFalse(p.liquidated);
        assertEq(usdc.balanceOf(alice), 10_000e6 - FEE + 200e6);
        assertEq(usdc.balanceOf(exec), execBefore - 200e6);
        assertEq(usdc.balanceOf(address(manager)), 0);
        assertEq(vault.totalBorrowed(), 0);
        assertEq(vault.totalAssets(), 10_000e6 + FEE);
        assertEq(manager.activePositionIds().length, 0);
        assertEq(manager.positionsOf(alice).length, 1);

        vm.prank(exec);
        vm.expectRevert(abi.encodeWithSelector(IMarginManager.WrongStatus.selector, IMarginManager.Status.Closed));
        manager.recordFill(id, 800_000, 1_000e6);
    }

    function test_fullCycle_loss() public {
        uint256 id = _openStandard();
        uint256 execBefore = usdc.balanceOf(exec);
        vm.prank(alice);
        manager.closePosition(id);

        // exit 0.55: proceeds 550, manager sends 50 to executor, vault 480, alice 70
        vm.expectEmit();
        emit IMarginManager.PositionSettled(id, 550_000, 550e6, 480e6, 0, 70e6);
        _fill(id, 550_000, 1_000e6);

        assertEq(usdc.balanceOf(alice), 10_000e6 - FEE - 50e6);
        assertEq(usdc.balanceOf(exec), execBefore + 50e6);
        assertEq(usdc.balanceOf(address(manager)), 0);
        assertEq(vault.totalAssets(), 10_000e6 + FEE);
    }

    function test_fullCycle_noSide() public {
        // NO ask 0.41. 82 USDC at 2x: size 164, 400 contracts at 0.41
        uint256 id = _open(bob, 1, 82e6, 20);
        _fill(id, 410_000, 400e6);
        IMarginManager.Position memory p = _pos(id);
        assertEq(p.borrowed, 82e6);
        assertEq(p.liqPrice, 205_000 + 40_000);

        // YES 0.59/0.60 -> NO bid 0.40
        assertEq(manager.markPrice(id), 400_000);
        // (0.40 - 0.245) / (0.41 - 0.245)
        assertEq(manager.health(id), uint256(155_000) * 10_000 / 165_000);

        vm.prank(bob);
        manager.closePosition(id);
        _fill(id, 500_000, 400e6); // proceeds 200: vault 82, bob 118
        assertEq(usdc.balanceOf(bob), 10_000e6 - 820_000 + 36e6);
        assertEq(usdc.balanceOf(address(manager)), 0);
    }

    function test_closeFill_invalid() public {
        uint256 id = _openStandard();
        vm.prank(alice);
        manager.closePosition(id);
        vm.startPrank(exec);
        vm.expectRevert(IMarginManager.InvalidFill.selector);
        manager.recordFill(id, 600_000, 1_000e6 - 1);
        vm.expectRevert(IMarginManager.InvalidFill.selector);
        manager.recordFill(id, 1_000_001, 1_000e6);
        vm.stopPrank();
    }

    function test_closeFill_boundaryPrices() public {
        // settle at $1.00
        uint256 id = _openStandard();
        vm.prank(alice);
        manager.closePosition(id);
        _fill(id, 1_000_000, 1_000e6);
        assertEq(usdc.balanceOf(alice), 10_000e6 - FEE + 400e6);

        // settle at $0: full write-off
        id = _open(bob, 0, 120e6, 50);
        _fill(id, 600_000, 1_000e6);
        vm.prank(bob);
        manager.closePosition(id);
        vm.expectEmit();
        emit ILendingVault.Repaid(0, 480e6, 0);
        vm.expectEmit();
        emit IMarginManager.PositionSettled(id, 0, 0, 0, 480e6, 0);
        _fill(id, 0, 1_000e6);
        assertEq(usdc.balanceOf(bob), 10_000e6 - FEE - 120e6);
        assertEq(vault.totalAssets(), 10_000e6 + 2 * FEE - 480e6);
        assertEq(usdc.balanceOf(address(manager)), 0);
    }

    function test_closeFill_revertsWithoutExecutorAllowance() public {
        uint256 id = _openStandard();
        vm.prank(alice);
        manager.closePosition(id);
        vm.prank(exec);
        usdc.approve(address(manager), 0);
        vm.prank(exec);
        vm.expectRevert();
        manager.recordFill(id, 800_000, 1_000e6);
    }

    // -------------------------------------------------------- liquidation

    function test_markPrice_revertsWhenStale() public {
        uint256 id = _openStandard();
        assertEq(manager.markPrice(id), 590_000);
        vm.warp(T0 + 61);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.StalePrice.selector, MARKET, T0));
        manager.markPrice(id);
    }

    function test_health() public {
        uint256 id = _openStandard(); // entry 0.60, liq 0.52
        _post(600_000, 610_000);
        assertEq(manager.health(id), 10_000);
        _post(650_000, 660_000);
        assertEq(manager.health(id), 10_000);
        _post(560_000, 570_000);
        assertEq(manager.health(id), 5_000);
        _post(520_000, 530_000);
        assertEq(manager.health(id), 0);
        _post(100_000, 110_000);
        assertEq(manager.health(id), 0);

        // never reverts on a stale price
        _post(540_000, 550_000);
        vm.warp(T0 + 1 hours);
        assertEq(manager.health(id), 2_500);
    }

    function test_liquidate_notLiquidatable() public {
        uint256 pending = _open(bob, 0, 120e6, 50);
        vm.expectRevert(IMarginManager.NotLiquidatable.selector);
        manager.liquidate(pending);

        uint256 id = _openStandard();
        (bool ok, uint8 reason) = manager.isLiquidatable(id);
        assertFalse(ok);
        assertEq(reason, 0);

        _post(520_001, 530_000); // one tick above liqPrice
        (ok,) = manager.isLiquidatable(id);
        assertFalse(ok);
        vm.expectRevert(IMarginManager.NotLiquidatable.selector);
        manager.liquidate(id);

        vm.expectRevert(IMarginManager.NotLiquidatable.selector);
        manager.liquidate(999);
    }

    function test_liquidate_needsFreshPriceOutsideFinalHour() public {
        uint256 id = _openStandard();
        _post(400_000, 410_000);
        vm.warp(block.timestamp + 61);
        (bool ok,) = manager.isLiquidatable(id);
        assertFalse(ok);
        vm.expectRevert(IMarginManager.NotLiquidatable.selector);
        manager.liquidate(id);

        _post(400_000, 410_000);
        (ok,) = manager.isLiquidatable(id);
        assertTrue(ok);
    }

    function test_liquidate_unleveragedNever() public {
        uint256 id = _open(alice, 0, 120e6, 10);
        _fill(id, 600_000, 200e6);
        _post(0, 10_000);
        (bool ok,) = manager.isLiquidatable(id);
        assertFalse(ok);
        vm.expectRevert(IMarginManager.NotLiquidatable.selector);
        manager.liquidate(id);
    }

    function test_liquidate_thenSettle_noBadDebt() public {
        uint256 id = _openStandard();
        uint256 execBefore = usdc.balanceOf(exec);
        _post(520_000, 530_000); // bid == liqPrice
        (bool ok, uint8 reason) = manager.isLiquidatable(id);
        assertTrue(ok);
        assertEq(reason, 0);

        vm.expectEmit();
        emit IMarginManager.PositionLiquidated(id, bob, 520_000, 0);
        vm.prank(bob);
        manager.liquidate(id);

        IMarginManager.Position memory p = _pos(id);
        assertTrue(p.liquidated);
        assertEq(uint8(p.status), uint8(IMarginManager.Status.PendingClose));
        (ok,) = manager.isLiquidatable(id);
        assertFalse(ok);
        vm.expectRevert(IMarginManager.NotLiquidatable.selector);
        manager.liquidate(id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IMarginManager.WrongStatus.selector, IMarginManager.Status.PendingClose));
        manager.closePosition(id);

        // sold at 0.50: proceeds 500, vault 480, alice 20
        vm.expectEmit();
        emit IMarginManager.PositionSettled(id, 500_000, 500e6, 480e6, 0, 20e6);
        _fill(id, 500_000, 1_000e6);

        p = _pos(id);
        assertTrue(p.liquidated);
        assertEq(uint8(p.status), uint8(IMarginManager.Status.Closed));
        assertEq(usdc.balanceOf(alice), 10_000e6 - FEE - 100e6);
        assertEq(usdc.balanceOf(exec), execBefore + 100e6);
        assertEq(vault.totalBorrowed(), 0);
        assertEq(vault.totalAssets(), 10_000e6 + FEE);
        assertEq(usdc.balanceOf(address(manager)), 0);
        assertEq(manager.activePositionIds().length, 0);
    }

    function test_liquidate_thenSettle_badDebt() public {
        uint256 id = _openStandard();
        uint256 lpShares = vault.balanceOf(lp);
        _post(400_000, 410_000);
        manager.liquidate(id);

        // sold at 0.40: proceeds 400, vault 400, loss 80, alice 0
        vm.expectEmit();
        emit ILendingVault.Repaid(400e6, 80e6, 0);
        vm.expectEmit();
        emit IMarginManager.PositionSettled(id, 400_000, 400e6, 400e6, 80e6, 0);
        _fill(id, 400_000, 1_000e6);

        assertEq(usdc.balanceOf(alice), 10_000e6 - FEE - 120e6);
        assertEq(vault.totalBorrowed(), 0);
        assertEq(vault.totalAssets(), 10_000e6 + FEE - 80e6);
        assertApproxEqAbs(vault.convertToAssets(lpShares), 10_000e6 + FEE - 80e6, 1);
        assertEq(usdc.balanceOf(address(manager)), 0);
    }

    function test_liquidate_noSide() public {
        uint256 id = _open(bob, 1, 82e6, 20);
        _fill(id, 410_000, 400e6); // liq 0.245
        _post(740_000, 754_999); // NO bid 0.245001
        (bool ok,) = manager.isLiquidatable(id);
        assertFalse(ok);
        _post(740_000, 755_000); // NO bid 0.245
        vm.expectEmit();
        emit IMarginManager.PositionLiquidated(id, address(this), 245_000, 0);
        manager.liquidate(id);
    }

    // ----------------------------------------------------------- open fee

    function test_openFee_constantAndRounding() public view {
        assertEq(manager.OPEN_FEE_BPS(), 100);
        assertEq(manager.openFee(0), 0);
        assertEq(manager.openFee(1), 1); // rounds up
        assertEq(manager.openFee(99), 1);
        assertEq(manager.openFee(100), 1);
        assertEq(manager.openFee(101), 2);
        assertEq(manager.openFee(480e6), FEE);
        assertEq(manager.openFee(480e6 + 1), FEE + 1);
    }

    function testFuzz_openFee(uint256 borrowed) public view {
        borrowed = bound(borrowed, 0, 1e30);
        uint256 fee = manager.openFee(borrowed);
        assertGe(fee, borrowed / 100);
        assertGe(fee * 10_000, borrowed * 100); // never under-charges
        assertLt(fee * 10_000, borrowed * 100 + 10_000); // by less than one unit
        assertEq(fee == 0, borrowed == 0);
    }

    function test_openFee_paidToVaultAndEmitted() public {
        uint256 lpShares = vault.balanceOf(lp);
        uint256 supply = vault.totalSupply();
        assertEq(vault.convertToAssets(lpShares), 10_000e6);

        vm.expectEmit();
        emit ILendingVault.Borrowed(480e6, 480e6);
        vm.expectEmit();
        emit ILendingVault.FeeCollected(FEE, FEE);
        vm.expectEmit();
        emit IMarginManager.PositionOpened(1, alice, MARKET, 0, 120e6, 50, 480e6, 600_000);
        vm.expectEmit();
        emit IMarginManager.OpenFeePaid(1, alice, FEE);
        uint256 id = _open(alice, 0, 120e6, 50);

        // trader pays margin + fee; the position and the manager only see the margin
        assertEq(usdc.balanceOf(alice), 10_000e6 - 120e6 - FEE);
        assertEq(_pos(id).margin, 120e6);
        assertEq(_pos(id).borrowed, 480e6);
        assertEq(usdc.balanceOf(address(manager)), 600e6);
        assertEq(usdc.allowance(address(manager), address(vault)), 0);

        // lenders earn it: no new shares, higher share price
        assertEq(vault.totalFeesCollected(), FEE);
        assertEq(vault.totalSupply(), supply);
        assertEq(vault.totalAssets(), 10_000e6 + FEE);
        assertEq(vault.availableLiquidity(), 10_000e6 - 480e6 + FEE);
        assertApproxEqAbs(vault.convertToAssets(lpShares), 10_000e6 + FEE, 1);
        assertGt(vault.convertToAssets(lpShares), 10_000e6);
    }

    function test_openFee_accumulatesAcrossOpens() public {
        _open(alice, 0, 120e6, 50); // borrowed 480 -> 4.80
        _open(bob, 1, 82e6, 20); // borrowed 82 -> 0.82
        assertEq(vault.totalFeesCollected(), FEE + 820_000);
        assertEq(vault.totalAssets(), 10_000e6 + FEE + 820_000);
    }

    function test_openFee_oneXPaysNothing() public {
        vm.recordLogs();
        uint256 id = _open(alice, 0, 120e6, 10);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != IMarginManager.OpenFeePaid.selector);
            assertTrue(logs[i].topics[0] != ILendingVault.FeeCollected.selector);
        }
        assertEq(_pos(id).borrowed, 0);
        assertEq(usdc.balanceOf(alice), 10_000e6 - 120e6);
        assertEq(vault.totalFeesCollected(), 0);
        assertEq(vault.totalAssets(), 10_000e6);
    }

    function test_openFee_allowanceForMarginOnlyReverts() public {
        vm.startPrank(alice);
        usdc.approve(address(manager), 120e6);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, address(manager), 120e6, 120e6 + FEE
            )
        );
        manager.openPosition(MARKET, 0, 120e6, 50);

        // one unit short still fails, exact allowance works, and 1x needs only the margin
        usdc.approve(address(manager), 120e6 + FEE - 1);
        vm.expectRevert();
        manager.openPosition(MARKET, 0, 120e6, 50);
        usdc.approve(address(manager), 120e6 + FEE);
        manager.openPosition(MARKET, 0, 120e6, 50);
        usdc.approve(address(manager), 120e6);
        manager.openPosition(MARKET, 0, 120e6, 10);
        vm.stopPrank();
    }

    function test_openFee_balanceForMarginOnlyReverts() public {
        address carol = makeAddr("carol");
        usdc.mint(carol, 120e6 + FEE - 1);
        vm.startPrank(carol);
        usdc.approve(address(manager), type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, carol, 120e6 + FEE - 1, 120e6 + FEE)
        );
        manager.openPosition(MARKET, 0, 120e6, 50);
        vm.stopPrank();
    }

    function test_openFee_notRefundedOnPartialFill() public {
        uint256 id = _open(alice, 0, 120e6, 50);
        _fill(id, 600_000, 100e6); // cost 60: all 480 borrowed goes back, 60 to alice
        assertEq(_pos(id).borrowed, 0);
        assertEq(usdc.balanceOf(alice), 10_000e6 - 60e6 - FEE);
        assertEq(vault.totalFeesCollected(), FEE);
        assertEq(vault.totalAssets(), 10_000e6 + FEE);
    }

    function test_openFee_previewOpenUnchanged() public view {
        (uint256 size,, uint256 borrowed,,) = manager.previewOpen(MARKET, 0, 120e6, 50);
        assertEq(size, 600e6);
        assertEq(borrowed, 480e6);
        assertEq(manager.openFee(borrowed), FEE);
    }

    // ------------------------------------------------------- bookkeeping

    function test_activeSetAcrossLifecycle() public {
        uint256 a = _openStandard();
        uint256 b = _open(bob, 0, 50e6, 20);
        uint256 c = _open(bob, 1, 50e6, 10);
        assertEq(manager.activePositionIds().length, 3);

        vm.prank(alice);
        manager.closePosition(a);
        assertEq(manager.activePositionIds().length, 3);
        _fill(a, 600_000, 1_000e6);

        uint256[] memory ids = manager.activePositionIds();
        assertEq(ids.length, 2);
        assertTrue((ids[0] == b && ids[1] == c) || (ids[0] == c && ids[1] == b));
    }

    function test_managerHoldsExactlyOpenCosts() public {
        uint256 a = _openStandard(); // cost 600
        uint256 b = _open(bob, 1, 82e6, 20);
        _fill(b, 410_000, 300e6); // cost 123, 41 unused -> vault
        assertEq(usdc.balanceOf(address(manager)), 600e6 + 123e6);
        assertEq(vault.totalBorrowed(), 480e6 + 41e6);

        vm.prank(alice);
        manager.closePosition(a);
        _fill(a, 700_000, 1_000e6);
        assertEq(usdc.balanceOf(address(manager)), 123e6);
        assertEq(vault.totalBorrowed(), 41e6);
    }
}
