// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ILendingVault} from "./interfaces/ILendingVault.sol";

/// @title LendingVault
/// @notice ERC-4626 USDC vault that lends to the MarginManager.
/// @dev totalAssets() = USDC held + totalBorrowed. Shares carry a 6-decimal offset (12 decimals in
///      total) so that the first depositor cannot inflate the share price by donating.
contract LendingVault is ERC4626, Ownable, ILendingVault {
    using SafeERC20 for IERC20;

    address public marginManager;
    uint256 public totalBorrowed;
    uint256 public totalFeesCollected;

    modifier onlyMarginManager() {
        if (msg.sender != marginManager) revert NotMarginManager();
        _;
    }

    constructor(address owner_, IERC20 usdc_)
        ERC20("Vectis USDC Vault", "vUSDC")
        ERC4626(usdc_)
        Ownable(owner_)
    {}

    function setMarginManager(address marginManager_) external onlyOwner {
        if (marginManager != address(0)) revert MarginManagerAlreadySet();
        require(marginManager_ != address(0), "zero margin manager");
        marginManager = marginManager_;
        emit MarginManagerSet(marginManager_);
    }

    function availableLiquidity() public view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    function totalAssets() public view override returns (uint256) {
        return availableLiquidity() + totalBorrowed;
    }

    function maxWithdraw(address owner_) public view override returns (uint256) {
        return Math.min(super.maxWithdraw(owner_), availableLiquidity());
    }

    function maxRedeem(address owner_) public view override returns (uint256) {
        return Math.min(super.maxRedeem(owner_), _convertToShares(availableLiquidity(), Math.Rounding.Floor));
    }

    function borrow(uint256 amount) external onlyMarginManager {
        uint256 available = availableLiquidity();
        if (amount > available) revert InsufficientLiquidity(amount, available);
        totalBorrowed += amount;
        IERC20(asset()).safeTransfer(msg.sender, amount);
        emit Borrowed(amount, totalBorrowed);
    }

    function repay(uint256 amount, uint256 loss) external onlyMarginManager {
        uint256 reduction = amount + loss;
        if (reduction > totalBorrowed) revert RepayExceedsBorrowed();
        totalBorrowed -= reduction;
        if (amount > 0) IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);
        emit Repaid(amount, loss, totalBorrowed);
    }

    /// @dev No shares are minted: the cash raises totalAssets and so the share price.
    function collectFee(uint256 amount) external onlyMarginManager {
        if (amount == 0) return;
        totalFeesCollected += amount;
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);
        emit FeeCollected(amount, totalFeesCollected);
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }
}
