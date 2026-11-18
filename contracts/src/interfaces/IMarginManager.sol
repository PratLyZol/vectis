// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IMarginManager
/// @notice Leveraged positions on Gemini prediction-market contracts, margined in USDC.
/// @dev Units
///   - USDC amounts: 6 decimals (ERC-20 view of Arc USDC).
///   - Prices: 1e6 = $1.00, expressed in the position's own side space
///     (YES price for side 0, NO price = 1e6 - YES price for side 1).
///   - Contract quantities: 6 decimals (1e6 = one contract).
///   - Leverage: tenths. 10 = 1x, 15 = 1.5x ... 50 = 5x. Must be a multiple of 5.
///   - notional (USDC) = contracts * price / 1e6.
///
/// Lifecycle
///   openPosition  -> PendingOpen   (emits PositionOpened; keeper buys on Gemini)
///   recordFill    -> Open          (emits FillRecorded)
///   closePosition -> PendingClose  (emits PositionClosed; keeper sells on Gemini)
///   liquidate     -> PendingClose  (emits PositionLiquidated; keeper sells on Gemini)
///   recordFill    -> Closed        (emits PositionSettled)
///
/// Custody (MVP, custodial executor)
///   On the open fill, cost = contracts * fillPrice / 1e6 must be <= margin + borrowed. Unused
///   size is returned at once: first as vault repayment (reducing borrowed), then to the owner.
///   The manager keeps `cost`. On the close fill, proceeds = contracts * exitPrice / 1e6.
///   If proceeds > cost the manager pulls the difference from the executor (the executor must
///   have approved the manager); if proceeds < cost the manager sends the difference to the
///   executor. Then the vault is repaid min(proceeds, borrowed), any shortfall is written off as
///   vault loss, and the remainder is paid to the owner.
interface IMarginManager {
    enum Status {
        None,
        PendingOpen,
        Open,
        PendingClose,
        Closed
    }

    /// @dev reason codes for PositionLiquidated
    ///   0 = mark crossed liquidation price, 1 = pre-expiry deleverage (final hour, borrowed > 0)
    struct Position {
        address owner;
        bytes32 marketId;
        uint8 side; // 0 = YES, 1 = NO
        Status status;
        bool liquidated;
        uint256 margin; // USDC posted by the owner
        uint256 leverage; // tenths
        uint256 borrowed; // USDC owed to the vault
        uint256 cost; // USDC spent on the open fill
        uint256 entryPrice; // side space, 1e6
        uint256 contracts; // 6 decimals
        uint256 liqPrice; // side space, 1e6. Zero when borrowed == 0
        uint256 openedAt; // block timestamp of openPosition
    }

    event PositionOpened(
        uint256 indexed id,
        address indexed owner,
        bytes32 indexed marketId,
        uint8 side,
        uint256 margin,
        uint256 leverage,
        uint256 borrowed,
        uint256 refPrice
    );
    event FillRecorded(uint256 indexed id, uint256 entryPrice, uint256 contracts, uint256 borrowed, uint256 liqPrice);
    event PositionClosed(uint256 indexed id, address indexed owner);
    event PositionLiquidated(uint256 indexed id, address indexed liquidator, uint256 markPrice, uint8 reason);
    event PositionSettled(
        uint256 indexed id, uint256 exitPrice, uint256 proceeds, uint256 repaid, uint256 loss, uint256 payout
    );
    event ExecutorUpdated(address indexed executor);
    /// @notice Emitted by openPosition when a non-zero open fee is paid to the vault.
    event OpenFeePaid(uint256 indexed id, address indexed owner, uint256 fee);

    error NotExecutor();
    error NotPositionOwner();
    error InvalidSide();
    error InvalidLeverage(uint256 requested, uint256 maxAllowed);
    error InvalidMargin();
    error InvalidFill();
    error WrongStatus(Status current);
    error NotLiquidatable();
    error MarketClosed();

    function LEVERAGE_UNIT() external view returns (uint256); // 10
    function MAX_LEVERAGE() external view returns (uint256); // 50
    function LEVERAGE_PRICE_DIVISOR() external view returns (uint256); // 120_000 ($0.12)
    function LIQ_BUFFER() external view returns (uint256); // 40_000 ($0.04)
    function DELEVERAGE_WINDOW() external view returns (uint256); // 3600 seconds
    function MIN_MARGIN() external view returns (uint256); // 1e6 (1 USDC)
    function OPEN_FEE_BPS() external view returns (uint256); // 100 (1% of the borrowed amount)

    /// @notice Pure helper: fee charged at open for borrowing `borrowed` USDC.
    /// @dev ceil(borrowed * OPEN_FEE_BPS / 10_000). Zero when borrowed == 0 (1x positions).
    ///      The fee is paid by the trader on top of margin, goes straight to the vault as lender
    ///      income, is not part of the position, and is not refunded if the fill uses less size.
    function openFee(uint256 borrowed) external pure returns (uint256);

    function usdc() external view returns (address);
    function vault() external view returns (address);
    function oracle() external view returns (address);
    function executor() external view returns (address);
    function setExecutor(address executor) external;

    /// @notice Max leverage in tenths for a side of a market at the current fresh oracle price.
    /// @dev min(50, floor((sideAsk / 0.12) to a 0.5 step)), never below 10. Returns 10 inside the
    ///      final hour before close. Reverts if the price is stale or the market has closed.
    function maxLeverage(bytes32 marketId, uint8 side) external view returns (uint256);

    /// @notice Pure helper: max leverage in tenths for a side-space price, ignoring time.
    function maxLeverageForPrice(uint256 price) external pure returns (uint256);

    /// @notice Pure helper: liquidation price for a filled position. Zero when borrowed == 0.
    /// @dev ceil(borrowed * 1e6 / contracts) + LIQ_BUFFER.
    function liquidationPrice(uint256 borrowed, uint256 contracts) external pure returns (uint256);

    /// @notice What openPosition would do at the current oracle price (side ask).
    function previewOpen(bytes32 marketId, uint8 side, uint256 margin, uint256 leverage)
        external
        view
        returns (uint256 size, uint256 contracts, uint256 borrowed, uint256 liqPrice, uint256 refPrice);

    /// @notice Pull `margin + openFee(borrowed)` USDC from the caller, borrow
    ///         borrowed = margin * (leverage - 10) / 10 from the vault, and pay the fee to the vault
    ///         through LendingVault.collectFee. Position.margin stays equal to `margin`.
    function openPosition(bytes32 marketId, uint8 side, uint256 margin, uint256 leverage)
        external
        returns (uint256 id);

    /// @notice Owner requests a close of an Open position.
    function closePosition(uint256 id) external;

    /// @notice Anyone. Open position whose side bid <= liqPrice (and borrowed > 0), or any Open
    ///         position with borrowed > 0 inside the final hour before close.
    function liquidate(uint256 id) external;

    /// @notice Executor only. Records the Gemini fill for a PendingOpen or PendingClose position.
    /// @param fillPrice side-space price, 1e6
    /// @param contracts filled quantity, 6 decimals. On close it must equal the position's contracts.
    function recordFill(uint256 id, uint256 fillPrice, uint256 contracts) external;

    function nextPositionId() external view returns (uint256);
    function getPosition(uint256 id) external view returns (Position memory);
    function positionsOf(address owner) external view returns (uint256[] memory);

    /// @notice Ids currently in PendingOpen, Open or PendingClose (for the keeper to scan).
    function activePositionIds() external view returns (uint256[] memory);

    /// @notice Side-space bid for the position's market from the fresh oracle price.
    function markPrice(uint256 id) external view returns (uint256);

    /// @notice True when liquidate(id) would succeed, with the reason code.
    function isLiquidatable(uint256 id) external view returns (bool liquidatable, uint8 reason);

    /// @notice Health in basis points: (mark - liqPrice) / (entryPrice - liqPrice), clamped to
    ///         [0, 10000]. 10000 when borrowed == 0. Uses the last posted price even if stale.
    function health(uint256 id) external view returns (uint256);
}
