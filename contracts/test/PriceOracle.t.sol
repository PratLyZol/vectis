// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PriceOracle} from "../src/PriceOracle.sol";
import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";

contract PriceOracleTest is Test {
    uint256 internal constant T0 = 1_800_000_000;
    bytes32 internal constant M1 = keccak256("M1");
    bytes32 internal constant M2 = keccak256("M2");

    address internal admin = makeAddr("admin");
    address internal poster = makeAddr("poster");
    address internal stranger = makeAddr("stranger");
    PriceOracle internal oracle;

    function setUp() public {
        vm.warp(T0);
        oracle = new PriceOracle(admin);
        vm.prank(admin);
        oracle.setPoster(poster, true);
    }

    function _post(bytes32 id, uint256 bid, uint256 ask) internal {
        bytes32[] memory ids = new bytes32[](1);
        uint256[] memory bids = new uint256[](1);
        uint256[] memory asks = new uint256[](1);
        (ids[0], bids[0], asks[0]) = (id, bid, ask);
        vm.prank(poster);
        oracle.postPrices(ids, bids, asks);
    }

    function test_constants() public view {
        assertEq(oracle.MAX_AGE(), 60);
        assertEq(oracle.owner(), admin);
    }

    function test_setPoster_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        oracle.setPoster(stranger, true);
    }

    function test_setPoster_grantAndRevoke() public {
        vm.expectEmit();
        emit IPriceOracle.PosterUpdated(stranger, true);
        vm.prank(admin);
        oracle.setPoster(stranger, true);
        assertTrue(oracle.isPoster(stranger));

        vm.prank(admin);
        oracle.setPoster(stranger, false);
        assertFalse(oracle.isPoster(stranger));
        vm.prank(stranger);
        vm.expectRevert(IPriceOracle.NotPoster.selector);
        oracle.registerMarket(M1, T0 + 1);
    }

    function test_registerMarket_onlyPoster() public {
        vm.prank(stranger);
        vm.expectRevert(IPriceOracle.NotPoster.selector);
        oracle.registerMarket(M1, T0 + 1 days);
    }

    function test_registerMarket_andUpdate() public {
        assertFalse(oracle.isRegistered(M1));
        assertEq(oracle.closeTime(M1), 0);

        vm.expectEmit();
        emit IPriceOracle.MarketRegistered(M1, T0 + 1 days);
        vm.prank(poster);
        oracle.registerMarket(M1, T0 + 1 days);
        assertTrue(oracle.isRegistered(M1));
        assertEq(oracle.closeTime(M1), T0 + 1 days);

        _post(M1, 400_000, 420_000);
        vm.prank(poster);
        oracle.registerMarket(M1, T0 + 2 days);
        assertEq(oracle.closeTime(M1), T0 + 2 days);
        (uint256 bid, uint256 ask,) = oracle.getPrice(M1); // price survives the update
        assertEq(bid, 400_000);
        assertEq(ask, 420_000);
    }

    function test_registerMarket_invalidCloseTime() public {
        vm.startPrank(poster);
        vm.expectRevert(IPriceOracle.InvalidCloseTime.selector);
        oracle.registerMarket(M1, T0);
        vm.expectRevert(IPriceOracle.InvalidCloseTime.selector);
        oracle.registerMarket(M1, T0 - 1);
        oracle.registerMarket(M1, T0 + 1);
        vm.stopPrank();
    }

    function test_postPrices_onlyPoster() public {
        bytes32[] memory ids = new bytes32[](0);
        uint256[] memory px = new uint256[](0);
        vm.prank(stranger);
        vm.expectRevert(IPriceOracle.NotPoster.selector);
        oracle.postPrices(ids, px, px);
    }

    function test_postPrices_unknownMarket() public {
        bytes32[] memory ids = new bytes32[](1);
        uint256[] memory px = new uint256[](1);
        ids[0] = M1;
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.UnknownMarket.selector, M1));
        oracle.postPrices(ids, px, px);
    }

    function test_postPrices_lengthMismatch() public {
        bytes32[] memory ids = new bytes32[](1);
        uint256[] memory one = new uint256[](1);
        uint256[] memory two = new uint256[](2);
        vm.startPrank(poster);
        vm.expectRevert(IPriceOracle.LengthMismatch.selector);
        oracle.postPrices(ids, two, one);
        vm.expectRevert(IPriceOracle.LengthMismatch.selector);
        oracle.postPrices(ids, one, two);
        vm.stopPrank();
    }

    function test_postPrices_invalidPrice() public {
        vm.prank(poster);
        oracle.registerMarket(M1, T0 + 1 days);

        bytes32[] memory ids = new bytes32[](1);
        uint256[] memory bids = new uint256[](1);
        uint256[] memory asks = new uint256[](1);
        ids[0] = M1;

        (bids[0], asks[0]) = (500_001, 500_000); // bid > ask
        vm.prank(poster);
        vm.expectRevert(IPriceOracle.InvalidPrice.selector);
        oracle.postPrices(ids, bids, asks);

        (bids[0], asks[0]) = (500_000, 1_000_001); // ask > $1
        vm.prank(poster);
        vm.expectRevert(IPriceOracle.InvalidPrice.selector);
        oracle.postPrices(ids, bids, asks);

        _post(M1, 0, 0);
        _post(M1, 1_000_000, 1_000_000);
        _post(M1, 500_000, 500_000);
    }

    function test_postPrices_batchEmitsAndStores() public {
        vm.startPrank(poster);
        oracle.registerMarket(M1, T0 + 1 days);
        oracle.registerMarket(M2, T0 + 2 days);
        vm.stopPrank();

        bytes32[] memory ids = new bytes32[](2);
        uint256[] memory bids = new uint256[](2);
        uint256[] memory asks = new uint256[](2);
        (ids[0], bids[0], asks[0]) = (M1, 300_000, 310_000);
        (ids[1], bids[1], asks[1]) = (M2, 700_000, 720_000);

        vm.expectEmit();
        emit IPriceOracle.PricePosted(M1, 300_000, 310_000, T0);
        vm.expectEmit();
        emit IPriceOracle.PricePosted(M2, 700_000, 720_000, T0);
        vm.prank(poster);
        oracle.postPrices(ids, bids, asks);

        (uint256 bid, uint256 ask, uint256 updatedAt) = oracle.getPrice(M2);
        assertEq(bid, 700_000);
        assertEq(ask, 720_000);
        assertEq(updatedAt, T0);
    }

    function test_getPrice_unknownMarket() public {
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.UnknownMarket.selector, M1));
        oracle.getPrice(M1);
    }

    function test_getPrice_neverPostedIsStale() public {
        vm.prank(poster);
        oracle.registerMarket(M1, T0 + 1 days);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.StalePrice.selector, M1, 0));
        oracle.getPrice(M1);

        (uint256 bid, uint256 ask, uint256 updatedAt) = oracle.peekPrice(M1);
        assertEq(bid + ask + updatedAt, 0);
    }

    function test_getPrice_freshAt60_staleAt61() public {
        vm.prank(poster);
        oracle.registerMarket(M1, T0 + 1 days);
        _post(M1, 400_000, 420_000);

        vm.warp(T0 + 60);
        (uint256 bid, uint256 ask, uint256 updatedAt) = oracle.getPrice(M1);
        assertEq(bid, 400_000);
        assertEq(ask, 420_000);
        assertEq(updatedAt, T0);

        vm.warp(T0 + 61);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracle.StalePrice.selector, M1, T0));
        oracle.getPrice(M1);

        // peek ignores staleness
        (bid, ask, updatedAt) = oracle.peekPrice(M1);
        assertEq(bid, 400_000);
        assertEq(ask, 420_000);
        assertEq(updatedAt, T0);

        // a new post makes it fresh again
        _post(M1, 410_000, 430_000);
        (bid,,) = oracle.getPrice(M1);
        assertEq(bid, 410_000);
    }
}
