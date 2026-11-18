// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IPriceOracle
/// @notice Keeper-posted best bid and ask per Gemini prediction-market contract.
/// @dev Prices are YES-space, scaled 1e6 (1_000_000 = $1.00). NO price = 1e6 - YES price.
///      marketId = keccak256(bytes(instrumentSymbol)), e.g. "GEMI-BTC2611152200-HI61750".
interface IPriceOracle {
    event MarketRegistered(bytes32 indexed marketId, uint256 closeTime);
    event PricePosted(bytes32 indexed marketId, uint256 bid, uint256 ask, uint256 updatedAt);
    event PosterUpdated(address indexed poster, bool allowed);

    error NotPoster();
    error UnknownMarket(bytes32 marketId);
    error StalePrice(bytes32 marketId, uint256 updatedAt);
    error InvalidPrice();
    error InvalidCloseTime();
    error LengthMismatch();

    /// @notice Maximum age of a price in seconds (60).
    function MAX_AGE() external view returns (uint256);

    /// @notice Owner grants or revokes the poster role.
    function setPoster(address poster, bool allowed) external;

    function isPoster(address account) external view returns (bool);

    /// @notice Poster registers a market or updates its close time (unix seconds).
    function registerMarket(bytes32 marketId, uint256 closeTime) external;

    /// @notice Poster posts YES-space best bid and ask. Requires 0 <= bid <= ask <= 1e6 and a registered market.
    function postPrices(bytes32[] calldata marketIds, uint256[] calldata bids, uint256[] calldata asks) external;

    /// @notice Fresh price. Reverts UnknownMarket, or StalePrice when older than MAX_AGE.
    function getPrice(bytes32 marketId) external view returns (uint256 bid, uint256 ask, uint256 updatedAt);

    /// @notice Last price without the staleness check (for UIs). Zeroes if never posted.
    function peekPrice(bytes32 marketId) external view returns (uint256 bid, uint256 ask, uint256 updatedAt);

    function isRegistered(bytes32 marketId) external view returns (bool);

    /// @notice Market close time in unix seconds. Zero if not registered.
    function closeTime(bytes32 marketId) external view returns (uint256);
}
