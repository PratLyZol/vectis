// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ILendingVault
/// @notice Extra surface of the ERC-4626 USDC vault. The vault itself also implements IERC4626.
/// @dev totalAssets() = USDC held + totalBorrowed(). Withdrawals are limited to USDC held.
interface ILendingVault {
    event MarginManagerSet(address indexed marginManager);
    event Borrowed(uint256 amount, uint256 totalBorrowed);
    event Repaid(uint256 amount, uint256 loss, uint256 totalBorrowed);

    event FeeCollected(uint256 amount, uint256 totalFeesCollected);

    error NotMarginManager();
    error MarginManagerAlreadySet();
    error InsufficientLiquidity(uint256 requested, uint256 available);
    error RepayExceedsBorrowed();

    /// @notice One-time wiring by the owner.
    function setMarginManager(address marginManager) external;

    function marginManager() external view returns (address);

    /// @notice Outstanding principal lent to the MarginManager (USDC, 6 decimals).
    function totalBorrowed() external view returns (uint256);

    /// @notice USDC currently held by the vault and available to borrow or withdraw.
    function availableLiquidity() external view returns (uint256);

    /// @notice MarginManager only. Transfers `amount` USDC to the MarginManager.
    function borrow(uint256 amount) external;

    /// @notice MarginManager only. Pulls `amount` USDC from the MarginManager (needs allowance) and
    ///         reduces totalBorrowed by `amount + loss`; `loss` is written off against LPs.
    function repay(uint256 amount, uint256 loss) external;

    /// @notice MarginManager only. Pulls `amount` USDC from the MarginManager (needs allowance) as
    ///         lender income. No shares are minted, so totalAssets and the share price rise.
    ///         A zero amount is a no-op.
    function collectFee(uint256 amount) external;

    /// @notice Cumulative open fees paid to the vault (USDC, 6 decimals).
    function totalFeesCollected() external view returns (uint256);
}
