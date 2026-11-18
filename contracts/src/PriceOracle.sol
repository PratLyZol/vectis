// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";

/// @title PriceOracle
/// @notice Keeper-posted YES-space best bid and ask per Gemini prediction-market contract.
contract PriceOracle is IPriceOracle, Ownable {
    uint256 public constant MAX_AGE = 60;
    uint256 private constant ONE = 1e6;

    struct Market {
        uint64 closeTime;
        uint64 updatedAt;
        uint32 bid;
        uint32 ask;
    }

    mapping(bytes32 => Market) private _markets;
    mapping(address => bool) public isPoster;

    modifier onlyPoster() {
        if (!isPoster[msg.sender]) revert NotPoster();
        _;
    }

    constructor(address owner_) Ownable(owner_) {}

    function setPoster(address poster, bool allowed) external onlyOwner {
        isPoster[poster] = allowed;
        emit PosterUpdated(poster, allowed);
    }

    function registerMarket(bytes32 marketId, uint256 closeTime_) external onlyPoster {
        if (closeTime_ <= block.timestamp || closeTime_ > type(uint64).max) revert InvalidCloseTime();
        _markets[marketId].closeTime = uint64(closeTime_);
        emit MarketRegistered(marketId, closeTime_);
    }

    function postPrices(bytes32[] calldata marketIds, uint256[] calldata bids, uint256[] calldata asks)
        external
        onlyPoster
    {
        uint256 n = marketIds.length;
        if (bids.length != n || asks.length != n) revert LengthMismatch();
        for (uint256 i; i < n; ++i) {
            bytes32 marketId = marketIds[i];
            Market storage m = _markets[marketId];
            if (m.closeTime == 0) revert UnknownMarket(marketId);
            uint256 bid = bids[i];
            uint256 ask = asks[i];
            if (bid > ask || ask > ONE) revert InvalidPrice();
            // bid <= ask <= 1e6 was checked above, so both fit in 32 bits
            // forge-lint: disable-next-line(unsafe-typecast)
            m.bid = uint32(bid);
            // forge-lint: disable-next-line(unsafe-typecast)
            m.ask = uint32(ask);
            m.updatedAt = uint64(block.timestamp);
            emit PricePosted(marketId, bid, ask, block.timestamp);
        }
    }

    function getPrice(bytes32 marketId) external view returns (uint256 bid, uint256 ask, uint256 updatedAt) {
        Market storage m = _markets[marketId];
        if (m.closeTime == 0) revert UnknownMarket(marketId);
        updatedAt = m.updatedAt;
        if (updatedAt == 0 || block.timestamp - updatedAt > MAX_AGE) revert StalePrice(marketId, updatedAt);
        return (m.bid, m.ask, updatedAt);
    }

    function peekPrice(bytes32 marketId) external view returns (uint256 bid, uint256 ask, uint256 updatedAt) {
        Market storage m = _markets[marketId];
        return (m.bid, m.ask, m.updatedAt);
    }

    function isRegistered(bytes32 marketId) external view returns (bool) {
        return _markets[marketId].closeTime != 0;
    }

    function closeTime(bytes32 marketId) external view returns (uint256) {
        return _markets[marketId].closeTime;
    }
}
