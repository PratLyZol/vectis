// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IMarginManager} from "../src/interfaces/IMarginManager.sol";
import {Base} from "./Base.t.sol";

contract LiquidationMathTest is Base {
    uint256 internal constant ONE = 1e6;

    function _leverage(uint256 price, uint256 seed) internal view returns (uint256) {
        uint256 maxLev = manager.maxLeverageForPrice(price);
        return 10 + 5 * bound(seed, 0, (maxLev - 10) / 5);
    }

    /// @dev margin, leverage and price -> (borrowed, contracts, liqPrice) for a fill at `price`.
    function _position(uint256 margin, uint256 leverage, uint256 price)
        internal
        view
        returns (uint256 borrowed, uint256 contracts, uint256 liqPrice)
    {
        uint256 size = margin * leverage / 10;
        borrowed = size - margin;
        contracts = size * ONE / price;
        liqPrice = manager.liquidationPrice(borrowed, contracts);
    }

    function testFuzz_maxLeverageForPrice_bounds(uint256 price) public view {
        price = bound(price, 0, ONE);
        uint256 lev = manager.maxLeverageForPrice(price);
        assertEq(lev % 5, 0);
        assertGe(lev, 10);
        assertLe(lev, 50);
    }

    function testFuzz_maxLeverageForPrice_monotonic(uint256 p1, uint256 p2) public view {
        p1 = bound(p1, 0, ONE);
        p2 = bound(p2, p1, ONE);
        assertLe(manager.maxLeverageForPrice(p1), manager.maxLeverageForPrice(p2));
    }

    function testFuzz_maxLeverageForPrice_matchesFormula(uint256 price) public view {
        price = bound(price, 120_000, 990_000);
        uint256 lev = manager.maxLeverageForPrice(price);
        // lev/10 <= price/0.12, and one more half-step would exceed it (unless capped)
        assertLe(lev * 120_000, price * 10);
        if (lev < 50) assertGt((lev + 5) * 120_000, price * 10);
    }

    function testFuzz_liqPriceBelowEntry(uint256 price, uint256 margin, uint256 seed) public view {
        price = bound(price, 120_000, 990_000);
        margin = bound(margin, 1e6, 1e12);
        (,, uint256 liqPrice) = _position(margin, _leverage(price, seed), price);
        assertLt(liqPrice, price);
    }

    function testFuzz_vaultWholeAtLiqPrice(uint256 price, uint256 margin, uint256 seed) public view {
        price = bound(price, 120_000, 990_000);
        margin = bound(margin, 1e6, 1e12);
        (uint256 borrowed, uint256 contracts, uint256 liqPrice) = _position(margin, _leverage(price, seed), price);
        uint256 proceeds = contracts * liqPrice / ONE;
        assertGe(proceeds, borrowed);
        // and the buffer is really there: 4 cents per contract (minus rounding)
        if (borrowed > 0) assertGe(proceeds + 1, borrowed + contracts * 40_000 / ONE);
    }

    function testFuzz_liqPriceMonotonicInLeverage(uint256 price, uint256 margin, uint256 s1, uint256 s2) public view {
        price = bound(price, 120_000, 990_000);
        margin = bound(margin, 1e6, 1e12);
        uint256 l1 = _leverage(price, s1);
        uint256 l2 = _leverage(price, s2);
        if (l1 > l2) (l1, l2) = (l2, l1);
        (,, uint256 liq1) = _position(margin, l1, price);
        (,, uint256 liq2) = _position(margin, l2, price);
        if (l1 == l2) assertEq(liq1, liq2);
        else assertLt(liq1, liq2);
    }

    /// @dev Same properties through the real contracts: open, fill, drop to liqPrice, liquidate, settle.
    function testFuzz_endToEnd_liquidationAtLiqPriceMakesVaultWhole(uint256 price, uint256 margin, uint256 seed)
        public
    {
        price = bound(price, 120_000, 990_000);
        margin = bound(margin, 1e6, 2_000e6);
        uint256 leverage = _leverage(price, seed);
        _post(price, price);
        assertEq(manager.maxLeverage(MARKET, 0), manager.maxLeverageForPrice(price));

        uint256 size = margin * leverage / 10;
        uint256 contracts = size * ONE / price;
        uint256 id = _open(alice, 0, margin, leverage);
        _fill(id, price, contracts);

        IMarginManager.Position memory p = _pos(id);
        assertEq(p.entryPrice, price);
        assertLe(p.cost, size);
        assertEq(p.borrowed, p.cost > margin ? p.cost - margin : 0);
        assertEq(vault.totalBorrowed(), p.borrowed);
        assertEq(usdc.balanceOf(address(manager)), p.cost);

        (bool ok,) = manager.isLiquidatable(id);
        assertFalse(ok);
        if (p.borrowed == 0) {
            assertEq(p.liqPrice, 0);
            return;
        }
        assertLt(p.liqPrice, p.entryPrice);
        assertEq(manager.health(id), 10_000);

        _post(p.liqPrice + 1, p.liqPrice + 1);
        (ok,) = manager.isLiquidatable(id);
        assertFalse(ok);

        _post(p.liqPrice, p.liqPrice);
        assertEq(manager.health(id), 0);
        manager.liquidate(id);
        _fill(id, p.liqPrice, contracts);

        assertEq(vault.totalBorrowed(), 0);
        assertEq(vault.totalAssets(), 10_000e6 + manager.openFee(size - margin)); // no loss, fee kept
        assertEq(usdc.balanceOf(address(manager)), 0);
        assertLe(usdc.balanceOf(alice), 10_000e6);
    }
}
