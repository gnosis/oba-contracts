// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity ^0.7.6;
pragma abicoder v2;

import "@gnosis.pm/util-contracts/contracts/StorageAccessible.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./GPv2AllowanceManager.sol";
import "./interfaces/GPv2Authentication.sol";
import "./libraries/GPv2Interaction.sol";
import "./libraries/GPv2Order.sol";
import "./libraries/GPv2Trade.sol";
import "./libraries/GPv2TradeExecution.sol";
import "./mixins/GPv2Signing.sol";

/// @title Gnosis Protocol v2 Settlement Contract
/// @author Gnosis Developers
contract GPv2Settlement is GPv2Signing, ReentrancyGuard, StorageAccessible {
    using GPv2Order for GPv2Order.Data;
    using GPv2Order for bytes;
    using GPv2TradeExecution for GPv2TradeExecution.Data;
    using SafeMath for uint256;

    /// @dev Data used for freeing storage and claiming a gas refund.
    struct OrderRefunds {
        bytes[] filledAmounts;
        bytes[] preSignatures;
    }

    /// @dev The authenticator is used to determine who can call the settle function.
    /// That is, only authorised solvers have the ability to invoke settlements.
    /// Any valid authenticator implements an isSolver method called by the onlySolver
    /// modifier below.
    GPv2Authentication public immutable authenticator;

    /// @dev The allowance manager which has access to order funds. This
    /// contract is created during deployment
    GPv2AllowanceManager public immutable allowanceManager;

    /// @dev Map each user order by UID to the amount that has been filled so
    /// far. If this amount is larger than or equal to the amount traded in the
    /// order (amount sold for sell orders, amount bought for buy orders) then
    /// the order cannot be traded anymore. If the order is fill or kill, then
    /// this value is only used to determine whether the order has already been
    /// executed.
    mapping(bytes => uint256) public filledAmount;

    /// @dev Event emitted for each executed trade.
    event Trade(
        address indexed owner,
        IERC20 sellToken,
        IERC20 buyToken,
        uint256 sellAmount,
        uint256 buyAmount,
        uint256 feeAmount,
        bytes orderUid
    );

    /// @dev Event emitted for each executed interaction.
    ///
    /// For gas effeciency, only the interaction calldata selector (first 4
    /// bytes) is included in the event. For interactions without calldata or
    /// whose calldata is shorter than 4 bytes, the selector will be `0`.
    event Interaction(address indexed target, uint256 value, bytes4 selector);

    /// @dev Event emitted when a settlement complets
    event Settlement(address indexed solver);

    /// @dev Event emitted when an order is invalidated.
    event OrderInvalidated(address indexed owner, bytes orderUid);

    constructor(GPv2Authentication authenticator_) {
        authenticator = authenticator_;
        allowanceManager = new GPv2AllowanceManager();
    }

    // solhint-disable-next-line no-empty-blocks
    receive() external payable {
        // NOTE: Include an empty receive function so that the settlement
        // contract can receive Ether from contract interactions.
    }

    /// @dev This modifier is called by settle function to block any non-listed
    /// senders from settling batches.
    modifier onlySolver {
        require(authenticator.isSolver(msg.sender), "GPv2: not a solver");
        _;
    }

    /// @dev Settle the specified orders at a clearing price. Note that it is
    /// the responsibility of the caller to ensure that all GPv2 invariants are
    /// upheld for the input settlement, otherwise this call will revert.
    /// Namely:
    /// - All orders are valid and signed
    /// - Accounts have sufficient balance and approval.
    /// - Settlement contract has sufficient balance to execute trades. Note
    ///   this implies that the accumulated fees held in the contract can also
    ///   be used for settlement. This is OK since:
    ///   - Solvers need to be authorized
    ///   - Misbehaving solvers will be slashed for abusing accumulated fees for
    ///     settlement
    ///   - Critically, user orders are entirely protected
    ///
    /// @param tokens An array of ERC20 tokens to be traded in the settlement.
    /// Trades encode tokens as indices into this array.
    /// @param clearingPrices An array of clearing prices where the `i`-th price
    /// is for the `i`-th token in the [`tokens`] array.
    /// @param trades Trades for signed orders.
    /// @param interactions Smart contract interactions split into three
    /// separate lists to be run before the settlement, during the settlement
    /// and after the settlement respectively.
    /// @param orderRefunds Order refunds for clearing storage related to
    /// expired orders.
    function settle(
        IERC20[] calldata tokens,
        uint256[] calldata clearingPrices,
        GPv2Trade.Data[] calldata trades,
        GPv2Interaction.Data[][3] calldata interactions,
        OrderRefunds calldata orderRefunds
    ) external nonReentrant onlySolver {
        executeInteractions(interactions[0]);

        GPv2TradeExecution.Data[] memory executedTrades =
            computeTradeExecutions(tokens, clearingPrices, trades);

        allowanceManager.transferIn(executedTrades);

        executeInteractions(interactions[1]);

        transferOut(executedTrades);

        executeInteractions(interactions[2]);

        claimOrderRefunds(orderRefunds);

        emit Settlement(msg.sender);
    }

    /// @dev Settle a single trade directly with on-chain liquidity. This
    /// function is provided as a "fast-path" for settlements without any
    /// coincidence of wants.
    ///
    /// This type of settlement always assumes the order will be filled in full,
    /// and while it does accept partially fillable orders, they must have no
    /// prior filled amount, and will be executed in full. As such, the trade's
    /// `executedAmount` is ignored.
    ///
    /// @param tokens An array of ERC20 tokens to be traded in the settlement.
    /// Trades encode tokens as indices into this array.
    /// @param trade The trade for the single signed order to settle.
    /// @param transfers Direct transfers of user funds to execute in order to
    /// interact with on-chain liquidity.
    /// @param interactions Smart contract interaction to perform with executed
    /// sell amount of the order.
    function settleSingleTrade(
        IERC20[] calldata tokens,
        GPv2Trade.Data calldata trade,
        GPv2AllowanceManager.Transfer[] calldata transfers,
        GPv2Interaction.Data[] calldata interactions
        //bytes[] calldata filledAmountRefunds
    ) external nonReentrant onlySolver {
        RecoveredOrder memory recoveredOrder = allocateRecoveredOrder();
        recoverOrderFromTrade(recoveredOrder, tokens, trade);

        executeSingleTrade(
            recoveredOrder,
            transfers,
            interactions,
            trade.feeDiscount
        );

        //freeOrderStorage(filledAmountRefunds, filledAmount);

        emit Settlement(msg.sender);
    }

    /// @dev Invalidate onchain an order that has been signed offline.
    ///
    /// @param orderUid The unique identifier of the order that is to be made
    /// invalid after calling this function. The user that created the order
    /// must be the the sender of this message. See [`extractOrderUidParams`]
    /// for details on orderUid.
    function invalidateOrder(bytes calldata orderUid) external {
        (, address owner, ) = orderUid.extractOrderUidParams();
        require(owner == msg.sender, "GPv2: caller does not own order");
        filledAmount[orderUid] = uint256(-1);
        emit OrderInvalidated(owner, orderUid);
    }

    /// @dev Process all trades one at a time returning the computed net in and
    /// out transfers for the trades.
    ///
    /// This method reverts if processing of any single trade fails. See
    /// [`computeTradeExecution`] for more details.
    ///
    /// @param tokens An array of ERC20 tokens to be traded in the settlement.
    /// @param clearingPrices An array of token clearing prices.
    /// @param trades Trades for signed orders.
    /// @return executedTrades Array of executed trades.
    function computeTradeExecutions(
        IERC20[] calldata tokens,
        uint256[] calldata clearingPrices,
        GPv2Trade.Data[] calldata trades
    ) internal returns (GPv2TradeExecution.Data[] memory executedTrades) {
        RecoveredOrder memory recoveredOrder = allocateRecoveredOrder();

        executedTrades = new GPv2TradeExecution.Data[](trades.length);
        for (uint256 i = 0; i < trades.length; i++) {
            GPv2Trade.Data calldata trade = trades[i];

            recoverOrderFromTrade(recoveredOrder, tokens, trade);
            computeTradeExecution(
                recoveredOrder,
                clearingPrices[trade.sellTokenIndex],
                clearingPrices[trade.buyTokenIndex],
                trade.executedAmount,
                trade.feeDiscount,
                executedTrades[i]
            );
        }
    }

    /// @dev Compute the in and out transfer amounts for a single trade.
    /// This function reverts if:
    /// - The order has expired
    /// - The order's limit price is not respected
    /// - The order gets over-filled
    /// - The fee discount is larger than the executed fee
    ///
    /// @param recoveredOrder The recovered order to process.
    /// @param sellPrice The price of the order's sell token.
    /// @param buyPrice The price of the order's buy token.
    /// @param executedAmount The portion of the order to execute. This will be
    /// ignored for fill-or-kill orders.
    /// @param feeDiscount The discount to apply to the final executed fees.
    /// @param executedTrade Memory location for computed executed trade data.
    function computeTradeExecution(
        RecoveredOrder memory recoveredOrder,
        uint256 sellPrice,
        uint256 buyPrice,
        uint256 executedAmount,
        uint256 feeDiscount,
        GPv2TradeExecution.Data memory executedTrade
    ) internal {
        GPv2Order.Data memory order = recoveredOrder.data;
        bytes memory orderUid = recoveredOrder.uid;

        // solhint-disable-next-line not-rely-on-time
        require(order.validTo >= block.timestamp, "GPv2: order expired");

        executedTrade.owner = recoveredOrder.owner;
        executedTrade.receiver = order.actualReceiver(recoveredOrder.owner);
        executedTrade.sellToken = order.sellToken;
        executedTrade.buyToken = order.buyToken;

        // NOTE: The following computation is derived from the equation:
        // ```
        // amount_x * price_x = amount_y * price_y
        // ```
        // Intuitively, if a chocolate bar is 0,50€ and a beer is 4€, 1 beer
        // is roughly worth 8 chocolate bars (`1 * 4 = 8 * 0.5`). From this
        // equation, we can derive:
        // - The limit price for selling `x` and buying `y` is respected iff
        // ```
        // limit_x * price_x >= limit_y * price_y
        // ```
        // - The executed amount of token `y` given some amount of `x` and
        //   clearing prices is:
        // ```
        // amount_y = amount_x * price_x / price_y
        // ```

        require(
            order.sellAmount.mul(sellPrice) >= order.buyAmount.mul(buyPrice),
            "GPv2: limit price not respected"
        );

        uint256 executedSellAmount;
        uint256 executedBuyAmount;
        uint256 executedFeeAmount;
        uint256 currentFilledAmount;

        // NOTE: Don't use `SafeMath.div` or `SafeMath.sub` anywhere here as it
        // allocates a string even if it does not revert. Additionally, `div`
        // only checks that the divisor is non-zero and `revert`s in that case
        // instead of consuming all of the remaining transaction gas when
        // dividing by zero, so no extra checks are needed for those operations.

        if (order.kind == GPv2Order.SELL) {
            if (order.partiallyFillable) {
                executedSellAmount = executedAmount;
                executedFeeAmount =
                    order.feeAmount.mul(executedSellAmount) /
                    order.sellAmount;
            } else {
                executedSellAmount = order.sellAmount;
                executedFeeAmount = order.feeAmount;
            }

            executedBuyAmount = executedSellAmount.mul(sellPrice) / buyPrice;

            currentFilledAmount = filledAmount[orderUid].add(
                executedSellAmount
            );
            require(
                currentFilledAmount <= order.sellAmount,
                "GPv2: order filled"
            );
        } else {
            if (order.partiallyFillable) {
                executedBuyAmount = executedAmount;
                executedFeeAmount =
                    order.feeAmount.mul(executedBuyAmount) /
                    order.buyAmount;
            } else {
                executedBuyAmount = order.buyAmount;
                executedFeeAmount = order.feeAmount;
            }

            executedSellAmount = executedBuyAmount.mul(buyPrice) / sellPrice;

            currentFilledAmount = filledAmount[orderUid].add(executedBuyAmount);
            require(
                currentFilledAmount <= order.buyAmount,
                "GPv2: order filled"
            );
        }

        require(
            feeDiscount <= executedFeeAmount,
            "GPv2: fee discount too large"
        );
        executedFeeAmount = executedFeeAmount - feeDiscount;

        executedTrade.sellAmount = executedSellAmount.add(executedFeeAmount);
        executedTrade.buyAmount = executedBuyAmount;

        filledAmount[orderUid] = currentFilledAmount;
        emit Trade(
            executedTrade.owner,
            executedTrade.sellToken,
            executedTrade.buyToken,
            executedTrade.sellAmount,
            executedTrade.buyAmount,
            executedFeeAmount,
            orderUid
        );
    }

    /// @dev Executes a single trade on-chain by performing the specified
    /// transfers and interactions. This function is used as part of the
    /// "fast-path" for settling single trades against on-chain liquidity.
    ///
    /// This method computes the executed sell amount from the total transfer
    /// amount and the executed buy amount by reading the receiver's balance
    /// before and after the execution.
    ///
    /// @param recoveredOrder The recovered order to execute.
    /// @param transfers Direct transfers of user funds to permorm for executing
    /// this order.
    /// @param interactions Smart contract interaction to perform with the
    /// transferred user funds.
    /// @param feeDiscount The discount to apply to the final executed fees.
    function executeSingleTrade(
        RecoveredOrder memory recoveredOrder,
        GPv2AllowanceManager.Transfer[] calldata transfers,
        GPv2Interaction.Data[] calldata interactions,
        uint256 feeDiscount
    ) internal {
        GPv2Order.Data memory order = recoveredOrder.data;
        bytes memory orderUid = recoveredOrder.uid;
        uint256 executedFeeAmount = order.feeAmount.sub(feeDiscount);

        uint256 executedSellAmount;
        uint256 executedBuyAmount;
        {
            address receiver = order.actualReceiver(recoveredOrder.owner);
            uint256 startingBalance = order.buyToken.balanceOf(receiver);

            executedSellAmount = allowanceManager.transferToTargets(
                order.sellToken,
                recoveredOrder.owner,
                transfers
            );

            executeInteractions(interactions);

            executedBuyAmount = order.buyToken.balanceOf(receiver).sub(
                startingBalance
            );
        }

        require(filledAmount[orderUid] == 0, "GPv2: order filled");
        if (order.kind == GPv2Order.SELL) {
            filledAmount[orderUid] = order.sellAmount;
            require(
                executedSellAmount == order.sellAmount.add(executedFeeAmount),
                "GPv2: invalid sell amount"
            );
            require(
                executedBuyAmount >= order.buyAmount,
                "GPv2: buy amount too low"
            );
        } else {
            filledAmount[orderUid] = order.buyAmount;
            require(
                executedSellAmount <= order.sellAmount.add(executedFeeAmount),
                "GPv2: sell amount too high"
            );
            require(
                executedBuyAmount == order.buyAmount,
                "GPv2: invalid buy amount"
            );
        }

        emit Trade(
            recoveredOrder.owner,
            order.sellToken,
            order.buyToken,
            executedSellAmount,
            executedBuyAmount,
            executedFeeAmount,
            orderUid
        );
    }

    /// @dev Execute a list of arbitrary contract calls from this contract.
    /// @param interactions The list of interactions to execute.
    function executeInteractions(GPv2Interaction.Data[] calldata interactions)
        internal
    {
        for (uint256 i; i < interactions.length; i++) {
            GPv2Interaction.Data calldata interaction = interactions[i];

            // To prevent possible attack on user funds, we explicitly disable
            // any interactions with AllowanceManager contract.
            require(
                interaction.target != address(allowanceManager),
                "GPv2: forbidden interaction"
            );
            GPv2Interaction.execute(interaction);

            emit Interaction(
                interaction.target,
                interaction.value,
                GPv2Interaction.selector(interaction)
            );
        }
    }

    /// @dev Transfers all buy amounts for the executed trades from the
    /// settlement contract to the order owners. This function reverts if any of
    /// the ERC20 operations fail.
    ///
    /// @param trades The executed trades whose buy amounts need to be
    /// transferred out.
    function transferOut(GPv2TradeExecution.Data[] memory trades) internal {
        for (uint256 i = 0; i < trades.length; i++) {
            trades[i].transferBuyAmountToOwner();
        }
    }

    /// @dev Claims order gas refunds.
    ///
    /// @param orderRefunds Order refund data for freeing storage.
    function claimOrderRefunds(OrderRefunds calldata orderRefunds) internal {
        freeOrderStorage(orderRefunds.filledAmounts, filledAmount);
        freeOrderStorage(orderRefunds.preSignatures, preSignature);
    }

    /// @dev Claims refund for the specified storage and order UIDs.
    ///
    /// This method reverts if any of the orders are still valid.
    ///
    /// @param orderUids Order refund data for freeing storage.
    /// @param orderStorage Order storage mapped on a UID.
    function freeOrderStorage(
        bytes[] calldata orderUids,
        mapping(bytes => uint256) storage orderStorage
    ) internal {
        for (uint256 i = 0; i < orderUids.length; i++) {
            bytes calldata orderUid = orderUids[i];

            (, , uint32 validTo) = orderUid.extractOrderUidParams();
            // solhint-disable-next-line not-rely-on-time
            require(validTo < block.timestamp, "GPv2: order still valid");

            orderStorage[orderUid] = 0;
        }
    }
}
