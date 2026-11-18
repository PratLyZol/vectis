// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {LendingVault} from "../src/LendingVault.sol";
import {ILendingVault} from "../src/interfaces/ILendingVault.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract LendingVaultTest is Test {
    address internal admin = makeAddr("admin");
    address internal mm = makeAddr("marginManager");
    address internal lp1 = makeAddr("lp1");
    address internal lp2 = makeAddr("lp2");
    address internal stranger = makeAddr("stranger");

    MockUSDC internal usdc;
    LendingVault internal vault;

    function setUp() public {
        usdc = new MockUSDC();
        vault = new LendingVault(admin, IERC20(address(usdc)));
        vm.prank(admin);
        vault.setMarginManager(mm);

        vm.prank(mm);
        usdc.approve(address(vault), type(uint256).max);
        _fund(lp1, 100_000e6);
        _fund(lp2, 100_000e6);
    }

    function _fund(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(address(vault), type(uint256).max);
    }

    function _deposit(address who, uint256 amount) internal returns (uint256 shares) {
        vm.prank(who);
        shares = vault.deposit(amount, who);
    }

    function test_metadata() public view {
        assertEq(vault.name(), "Vectis USDC Vault");
        assertEq(vault.symbol(), "vUSDC");
        assertEq(vault.asset(), address(usdc));
        assertEq(vault.decimals(), 12);
        assertEq(vault.owner(), admin);
        assertEq(vault.marginManager(), mm);
    }

    function test_setMarginManager_onlyOwner() public {
        LendingVault v = new LendingVault(admin, IERC20(address(usdc)));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        v.setMarginManager(mm);
    }

    function test_setMarginManager_onceOnly() public {
        LendingVault v = new LendingVault(admin, IERC20(address(usdc)));
        vm.expectEmit();
        emit ILendingVault.MarginManagerSet(mm);
        vm.prank(admin);
        v.setMarginManager(mm);

        vm.prank(admin);
        vm.expectRevert(ILendingVault.MarginManagerAlreadySet.selector);
        v.setMarginManager(stranger);
    }

    function test_borrow_onlyMarginManager() public {
        _deposit(lp1, 1_000e6);
        vm.prank(stranger);
        vm.expectRevert(ILendingVault.NotMarginManager.selector);
        vault.borrow(1e6);
        vm.prank(admin);
        vm.expectRevert(ILendingVault.NotMarginManager.selector);
        vault.borrow(1e6);
    }

    function test_repay_onlyMarginManager() public {
        vm.prank(stranger);
        vm.expectRevert(ILendingVault.NotMarginManager.selector);
        vault.repay(0, 0);
    }

    function test_depositWithdraw_roundTrip() public {
        uint256 shares = _deposit(lp1, 1_000e6);
        assertEq(shares, 1_000e12);
        assertEq(vault.totalAssets(), 1_000e6);
        assertEq(vault.availableLiquidity(), 1_000e6);
        assertEq(vault.maxWithdraw(lp1), 1_000e6);

        vm.prank(lp1);
        vault.redeem(shares, lp1, lp1);
        assertEq(usdc.balanceOf(lp1), 100_000e6);
        assertEq(vault.totalSupply(), 0);
    }

    function test_borrow_keepsSharePriceAndLimitsWithdrawals() public {
        uint256 shares = _deposit(lp1, 1_000e6);

        vm.expectEmit();
        emit ILendingVault.Borrowed(600e6, 600e6);
        vm.prank(mm);
        vault.borrow(600e6);

        assertEq(usdc.balanceOf(mm), 600e6);
        assertEq(vault.totalBorrowed(), 600e6);
        assertEq(vault.availableLiquidity(), 400e6);
        assertEq(vault.totalAssets(), 1_000e6);
        assertEq(vault.convertToAssets(shares), 1_000e6);

        assertEq(vault.maxWithdraw(lp1), 400e6);
        assertEq(vault.maxRedeem(lp1), vault.convertToShares(400e6));

        vm.prank(lp1);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxWithdraw.selector, lp1, 400e6 + 1, 400e6));
        vault.withdraw(400e6 + 1, lp1, lp1);

        uint256 maxShares = vault.maxRedeem(lp1);
        vm.prank(lp1);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxRedeem.selector, lp1, shares, maxShares));
        vault.redeem(shares, lp1, lp1);

        vm.prank(lp1);
        vault.redeem(maxShares, lp1, lp1);
        assertEq(vault.availableLiquidity(), 0);
        assertEq(vault.maxWithdraw(lp1), 0);
        assertEq(vault.totalAssets(), 600e6);
    }

    function test_borrow_insufficientLiquidity() public {
        _deposit(lp1, 1_000e6);
        vm.prank(mm);
        vm.expectRevert(abi.encodeWithSelector(ILendingVault.InsufficientLiquidity.selector, 1_000e6 + 1, 1_000e6));
        vault.borrow(1_000e6 + 1);
    }

    function test_repay_fullNoLoss() public {
        uint256 shares = _deposit(lp1, 1_000e6);
        vm.startPrank(mm);
        vault.borrow(600e6);
        vm.expectEmit();
        emit ILendingVault.Repaid(600e6, 0, 0);
        vault.repay(600e6, 0);
        vm.stopPrank();

        assertEq(vault.totalBorrowed(), 0);
        assertEq(vault.availableLiquidity(), 1_000e6);
        assertEq(vault.convertToAssets(shares), 1_000e6);
        assertEq(vault.maxWithdraw(lp1), 1_000e6);
    }

    function test_repay_withLossSocialisedAcrossLps() public {
        uint256 s1 = _deposit(lp1, 3_000e6);
        uint256 s2 = _deposit(lp2, 1_000e6);

        vm.startPrank(mm);
        vault.borrow(2_000e6);
        vm.expectEmit();
        emit ILendingVault.Repaid(1_600e6, 400e6, 0);
        vault.repay(1_600e6, 400e6);
        vm.stopPrank();

        assertEq(vault.totalBorrowed(), 0);
        assertEq(vault.totalAssets(), 3_600e6);
        // 10% haircut, pro rata (1 wei of rounding in the vault's favour)
        assertApproxEqAbs(vault.convertToAssets(s1), 2_700e6, 1);
        assertApproxEqAbs(vault.convertToAssets(s2), 900e6, 1);

        // a deposit after the loss does not absorb it
        _fund(stranger, 900e6);
        uint256 s3 = _deposit(stranger, 900e6);
        assertApproxEqAbs(vault.convertToAssets(s3), 900e6, 1);
        assertApproxEqAbs(s3, s2, 1e7);
    }

    function test_repay_partialThenLossOnly() public {
        _deposit(lp1, 1_000e6);
        vm.startPrank(mm);
        vault.borrow(500e6);
        vault.repay(200e6, 0);
        assertEq(vault.totalBorrowed(), 300e6);
        assertEq(vault.totalAssets(), 1_000e6);
        vault.repay(0, 300e6); // total write-off, no transfer
        vm.stopPrank();
        assertEq(vault.totalBorrowed(), 0);
        assertEq(vault.totalAssets(), 700e6);
        assertEq(usdc.balanceOf(mm), 300e6);
    }

    function test_repay_exceedsBorrowed() public {
        _deposit(lp1, 1_000e6);
        vm.startPrank(mm);
        vault.borrow(500e6);
        vm.expectRevert(ILendingVault.RepayExceedsBorrowed.selector);
        vault.repay(500e6, 1);
        vm.expectRevert(ILendingVault.RepayExceedsBorrowed.selector);
        vault.repay(0, 500e6 + 1);
        vm.stopPrank();
    }

    function test_collectFee_onlyMarginManager() public {
        vm.prank(stranger);
        vm.expectRevert(ILendingVault.NotMarginManager.selector);
        vault.collectFee(1e6);
        vm.prank(admin);
        vm.expectRevert(ILendingVault.NotMarginManager.selector);
        vault.collectFee(1e6);
        vm.prank(stranger);
        vm.expectRevert(ILendingVault.NotMarginManager.selector);
        vault.collectFee(0);
    }

    function test_collectFee_raisesSharePriceWithoutMinting() public {
        uint256 s1 = _deposit(lp1, 3_000e6);
        uint256 s2 = _deposit(lp2, 1_000e6);
        uint256 supply = vault.totalSupply();
        usdc.mint(mm, 40e6);

        vm.expectEmit();
        emit ILendingVault.FeeCollected(40e6, 40e6);
        vm.prank(mm);
        vault.collectFee(40e6);

        assertEq(usdc.balanceOf(mm), 0);
        assertEq(vault.totalFeesCollected(), 40e6);
        assertEq(vault.totalSupply(), supply);
        assertEq(vault.totalBorrowed(), 0);
        assertEq(vault.totalAssets(), 4_040e6);
        assertEq(vault.availableLiquidity(), 4_040e6);
        // +1%, pro rata
        assertApproxEqAbs(vault.convertToAssets(s1), 3_030e6, 1);
        assertApproxEqAbs(vault.convertToAssets(s2), 1_010e6, 1);

        usdc.mint(mm, 10e6);
        vm.expectEmit();
        emit ILendingVault.FeeCollected(10e6, 50e6);
        vm.prank(mm);
        vault.collectFee(10e6);
        assertEq(vault.totalFeesCollected(), 50e6);

        // the income is withdrawable
        vm.prank(lp2);
        uint256 out = vault.redeem(s2, lp2, lp2);
        assertApproxEqAbs(out, 1_012.5e6, 1);
    }

    function test_collectFee_zeroIsNoop() public {
        _deposit(lp1, 1_000e6);
        vm.recordLogs();
        vm.prank(mm);
        vault.collectFee(0);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(vault.totalFeesCollected(), 0);
        assertEq(vault.totalAssets(), 1_000e6);
    }

    function test_collectFee_needsAllowance() public {
        usdc.mint(mm, 5e6);
        vm.startPrank(mm);
        usdc.approve(address(vault), 0);
        vm.expectRevert();
        vault.collectFee(5e6);
        vm.stopPrank();
        assertEq(vault.totalFeesCollected(), 0);
    }

    function test_collectFee_withOutstandingBorrow() public {
        uint256 shares = _deposit(lp1, 1_000e6);
        vm.startPrank(mm);
        vault.borrow(600e6);
        vault.collectFee(6e6);
        vm.stopPrank();
        assertEq(vault.totalBorrowed(), 600e6);
        assertEq(vault.totalAssets(), 1_006e6);
        assertEq(vault.maxWithdraw(lp1), 406e6);
        assertApproxEqAbs(vault.convertToAssets(shares), 1_006e6, 1);
    }

    function test_interestlessProfitDonationRaisesSharePrice() public {
        uint256 shares = _deposit(lp1, 1_000e6);
        usdc.mint(address(vault), 100e6);
        assertApproxEqAbs(vault.convertToAssets(shares), 1_100e6, 1);
    }

    function test_inflationAttackIsUnprofitable() public {
        // attacker deposits 1 wei, donates 10,000 USDC, victim deposits 1,000 USDC
        _fund(stranger, 20_000e6);
        uint256 attackerShares = _deposit(stranger, 1);
        vm.prank(stranger);
        usdc.transfer(address(vault), 10_000e6);

        uint256 victimShares = _deposit(lp1, 1_000e6);
        assertGt(victimShares, 0);
        assertApproxEqRel(vault.convertToAssets(victimShares), 1_000e6, 0.001e18);
        // the attacker cannot recover the donation
        assertLt(vault.convertToAssets(attackerShares), 6_000e6);
    }

    function testFuzz_shareAccountingThroughBorrowRepayLoss(uint256 dep, uint256 borrowBps, uint256 lossBps) public {
        dep = bound(dep, 1e6, 100_000e6);
        uint256 borrowed = dep * bound(borrowBps, 0, 10_000) / 10_000;
        uint256 loss = borrowed * bound(lossBps, 0, 10_000) / 10_000;

        uint256 shares = _deposit(lp1, dep);
        vm.startPrank(mm);
        vault.borrow(borrowed);
        assertEq(vault.totalAssets(), dep);
        assertEq(vault.maxWithdraw(lp1), dep - borrowed);
        vault.repay(borrowed - loss, loss);
        vm.stopPrank();

        assertEq(vault.totalBorrowed(), 0);
        assertEq(vault.totalAssets(), dep - loss);
        assertEq(vault.availableLiquidity(), dep - loss);

        uint256 max = vault.maxRedeem(lp1);
        vm.prank(lp1);
        uint256 out = vault.redeem(max, lp1, lp1);
        assertApproxEqAbs(out, dep - loss, 1);
        assertLe(out, dep - loss);
    }
}
