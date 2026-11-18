// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IMarginManager} from "./interfaces/IMarginManager.sol";
import {ILendingVault} from "./interfaces/ILendingVault.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";

/// @title MarginManager
/// @notice Leveraged positions on Gemini prediction-market contracts, margined in USDC.
///         See IMarginManager for units, lifecycle and the custody model.
contract MarginManager is IMarginManager, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.UintSet;

    uint256 public constant LEVERAGE_UNIT = 10;
    uint256 public constant MAX_LEVERAGE = 50;
    uint256 public constant LEVERAGE_PRICE_DIVISOR = 120_000;
    uint256 public constant LIQ_BUFFER = 40_000;
    uint256 public constant DELEVERAGE_WINDOW = 3600;
    uint256 public constant MIN_MARGIN = 1e6;
    uint256 public constant OPEN_FEE_BPS = 100;

    uint256 private constant ONE = 1e6;
    uint256 private constant LEVERAGE_STEP = 5;
    uint256 private constant BPS = 10_000;

    address public immutable usdc;
    address public immutable vault;
    address public immutable oracle;
    address public executor;

    uint256 public nextPositionId = 1;

    mapping(uint256 => Position) private _positions;
    mapping(address => uint256[]) private _positionsOf;
    EnumerableSet.UintSet private _active;

    modifier onlyExecutor() {
        if (msg.sender != executor) revert NotExecutor();
        _;
    }

    constructor(address owner_, address usdc_, address vault_, address oracle_, address executor_) Ownable(owner_) {
        usdc = usdc_;
        vault = vault_;
        oracle = oracle_;
        executor = executor_;
        emit ExecutorUpdated(executor_);
    }

    // ------------------------------------------------------------------ admin

    function setExecutor(address executor_) external onlyOwner {
        executor = executor_;
        emit ExecutorUpdated(executor_);
    }

    // ------------------------------------------------------------ pure helpers

    function maxLeverageForPrice(uint256 price) public pure returns (uint256) {
        uint256 lev = (price * LEVERAGE_UNIT) / LEVERAGE_PRICE_DIVISOR;
        lev -= lev % LEVERAGE_STEP;
        if (lev > MAX_LEVERAGE) return MAX_LEVERAGE;
        if (lev < LEVERAGE_UNIT) return LEVERAGE_UNIT;
        return lev;
    }

    function liquidationPrice(uint256 borrowed, uint256 contracts) public pure returns (uint256) {
        if (borrowed == 0) return 0;
        return Math.mulDiv(borrowed, ONE, contracts, Math.Rounding.Ceil) + LIQ_BUFFER;
    }

    function openFee(uint256 borrowed) public pure returns (uint256) {
        return Math.mulDiv(borrowed, OPEN_FEE_BPS, BPS, Math.Rounding.Ceil);
    }

    // ------------------------------------------------------------------ views

    function maxLeverage(bytes32 marketId, uint8 side) external view returns (uint256 maxLev) {
        (maxLev,) = _maxLeverage(marketId, side);
    }

    function previewOpen(bytes32 marketId, uint8 side, uint256 margin, uint256 leverage)
        external
        view
        returns (uint256 size, uint256 contracts, uint256 borrowed, uint256 liqPrice, uint256 refPrice)
    {
        (size, borrowed, refPrice) = _quoteOpen(marketId, side, margin, leverage);
        contracts = refPrice == 0 ? 0 : (size * ONE) / refPrice;
        liqPrice = liquidationPrice(borrowed, contracts);
    }

    function getPosition(uint256 id) external view returns (Position memory) {
        return _positions[id];
    }

    function positionsOf(address owner_) external view returns (uint256[] memory) {
        return _positionsOf[owner_];
    }

    function activePositionIds() external view returns (uint256[] memory) {
        return _active.values();
    }

    function markPrice(uint256 id) external view returns (uint256 sideBid) {
        Position storage p = _positions[id];
        (uint256 bid, uint256 ask,) = IPriceOracle(oracle).getPrice(p.marketId);
        (sideBid,) = _sidePrices(p.side, bid, ask);
    }

    function isLiquidatable(uint256 id) external view returns (bool liquidatable, uint8 reason) {
        (liquidatable, reason,) = _liquidatable(_positions[id]);
    }

    function health(uint256 id) external view returns (uint256) {
        Position storage p = _positions[id];
        if (p.borrowed == 0) return BPS;
        uint256 mark = _lastSideBid(p);
        uint256 liq = p.liqPrice;
        if (mark <= liq) return 0;
        if (mark >= p.entryPrice) return BPS;
        return ((mark - liq) * BPS) / (p.entryPrice - liq);
    }

    // -------------------------------------------------------------- lifecycle

    function openPosition(bytes32 marketId, uint8 side, uint256 margin, uint256 leverage)
        external
        nonReentrant
        returns (uint256 id)
    {
        (, uint256 borrowed, uint256 refPrice) = _quoteOpen(marketId, side, margin, leverage);

        id = nextPositionId++;
        Position storage p = _positions[id];
        p.owner = msg.sender;
        p.marketId = marketId;
        p.side = side;
        p.status = Status.PendingOpen;
        p.margin = margin;
        p.leverage = leverage;
        p.borrowed = borrowed;
        p.openedAt = block.timestamp;

        _positionsOf[msg.sender].push(id);
        _active.add(id);

        uint256 fee = openFee(borrowed);
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), margin + fee);
        if (borrowed > 0) ILendingVault(vault).borrow(borrowed);
        if (fee > 0) {
            IERC20(usdc).forceApprove(vault, fee);
            ILendingVault(vault).collectFee(fee);
        }

        emit PositionOpened(id, msg.sender, marketId, side, margin, leverage, borrowed, refPrice);
        if (fee > 0) emit OpenFeePaid(id, msg.sender, fee);
    }

    function closePosition(uint256 id) external {
        Position storage p = _positions[id];
        if (msg.sender != p.owner) revert NotPositionOwner();
        if (p.status != Status.Open) revert WrongStatus(p.status);
        p.status = Status.PendingClose;
        emit PositionClosed(id, msg.sender);
    }

    function liquidate(uint256 id) external {
        Position storage p = _positions[id];
        (bool ok, uint8 reason, uint256 mark) = _liquidatable(p);
        if (!ok) revert NotLiquidatable();
        p.liquidated = true;
        p.status = Status.PendingClose;
        emit PositionLiquidated(id, msg.sender, mark, reason);
    }

    function recordFill(uint256 id, uint256 fillPrice, uint256 contracts) external onlyExecutor nonReentrant {
        Position storage p = _positions[id];
        Status status = p.status;
        if (status == Status.PendingOpen) {
            _recordOpenFill(id, p, fillPrice, contracts);
        } else if (status == Status.PendingClose) {
            _recordCloseFill(id, p, fillPrice, contracts);
        } else {
            revert WrongStatus(status);
        }
    }

    // --------------------------------------------------------------- internal

    function _recordOpenFill(uint256 id, Position storage p, uint256 fillPrice, uint256 contracts) private {
        if (fillPrice == 0 || fillPrice >= ONE || contracts == 0) revert InvalidFill();
        uint256 borrowed = p.borrowed;
        uint256 size = p.margin + borrowed;
        uint256 cost = Math.mulDiv(contracts, fillPrice, ONE, Math.Rounding.Ceil);
        if (cost > size) revert InvalidFill();

        uint256 unused = size - cost;
        uint256 toVault = Math.min(unused, borrowed);
        uint256 toOwner = unused - toVault;
        borrowed -= toVault;
        uint256 liqPrice = liquidationPrice(borrowed, contracts);

        p.borrowed = borrowed;
        p.cost = cost;
        p.entryPrice = fillPrice;
        p.contracts = contracts;
        p.liqPrice = liqPrice;
        p.status = Status.Open;

        if (toVault > 0) _repayVault(toVault, 0);
        if (toOwner > 0) IERC20(usdc).safeTransfer(p.owner, toOwner);

        emit FillRecorded(id, fillPrice, contracts, borrowed, liqPrice);
    }

    function _recordCloseFill(uint256 id, Position storage p, uint256 fillPrice, uint256 contracts) private {
        if (contracts != p.contracts || fillPrice > ONE) revert InvalidFill();
        uint256 cost = p.cost;
        uint256 borrowed = p.borrowed;
        uint256 proceeds = (contracts * fillPrice) / ONE;
        uint256 repaid = Math.min(proceeds, borrowed);
        uint256 loss = borrowed - repaid;
        uint256 payout = proceeds - repaid;

        p.borrowed = 0;
        p.status = Status.Closed;
        _active.remove(id);

        // The manager holds `cost`; true it up to `proceeds` against the executor.
        if (proceeds > cost) {
            IERC20(usdc).safeTransferFrom(executor, address(this), proceeds - cost);
        } else if (proceeds < cost) {
            IERC20(usdc).safeTransfer(executor, cost - proceeds);
        }
        if (repaid > 0 || loss > 0) _repayVault(repaid, loss);
        if (payout > 0) IERC20(usdc).safeTransfer(p.owner, payout);

        emit PositionSettled(id, fillPrice, proceeds, repaid, loss, payout);
    }

    function _repayVault(uint256 amount, uint256 loss) private {
        if (amount > 0) IERC20(usdc).forceApprove(vault, amount);
        ILendingVault(vault).repay(amount, loss);
    }

    /// @dev Validates an open request against the fresh oracle price.
    function _quoteOpen(bytes32 marketId, uint8 side, uint256 margin, uint256 leverage)
        private
        view
        returns (uint256 size, uint256 borrowed, uint256 refPrice)
    {
        if (margin < MIN_MARGIN) revert InvalidMargin();
        uint256 maxLev;
        (maxLev, refPrice) = _maxLeverage(marketId, side);
        if (leverage < LEVERAGE_UNIT || leverage > maxLev || leverage % LEVERAGE_STEP != 0) {
            revert InvalidLeverage(leverage, maxLev);
        }
        size = (margin * leverage) / LEVERAGE_UNIT;
        borrowed = size - margin;
    }

    function _maxLeverage(bytes32 marketId, uint8 side) private view returns (uint256 maxLev, uint256 sideAsk) {
        if (side > 1) revert InvalidSide();
        (uint256 bid, uint256 ask,) = IPriceOracle(oracle).getPrice(marketId);
        uint256 closeTime = IPriceOracle(oracle).closeTime(marketId);
        if (block.timestamp >= closeTime) revert MarketClosed();
        (, sideAsk) = _sidePrices(side, bid, ask);
        maxLev = block.timestamp + DELEVERAGE_WINDOW >= closeTime ? LEVERAGE_UNIT : maxLeverageForPrice(sideAsk);
    }

    /// @dev Reason 0 needs a fresh price. Reason 1 (final hour, or after close) does not: the mark
    ///      is then the last posted side bid, or zero if none was ever posted.
    function _liquidatable(Position storage p) private view returns (bool ok, uint8 reason, uint256 mark) {
        if (p.status != Status.Open || p.borrowed == 0) return (false, 0, 0);
        bool fresh;
        try IPriceOracle(oracle).getPrice(p.marketId) returns (uint256 bid, uint256 ask, uint256) {
            fresh = true;
            (mark,) = _sidePrices(p.side, bid, ask);
        } catch {
            mark = _lastSideBid(p);
        }
        if (fresh && mark <= p.liqPrice) return (true, 0, mark);
        if (block.timestamp + DELEVERAGE_WINDOW >= IPriceOracle(oracle).closeTime(p.marketId)) return (true, 1, mark);
        return (false, 0, mark);
    }

    function _lastSideBid(Position storage p) private view returns (uint256 sideBid) {
        (uint256 bid, uint256 ask, uint256 updatedAt) = IPriceOracle(oracle).peekPrice(p.marketId);
        if (updatedAt == 0) return 0;
        (sideBid,) = _sidePrices(p.side, bid, ask);
    }

    function _sidePrices(uint8 side, uint256 bid, uint256 ask) private pure returns (uint256 sideBid, uint256 sideAsk) {
        return side == 0 ? (bid, ask) : (ONE - ask, ONE - bid);
    }
}
