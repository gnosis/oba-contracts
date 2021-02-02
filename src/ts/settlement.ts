import { BigNumberish, BytesLike, Signer, ethers } from "ethers";

import {
  Interaction,
  InteractionLike,
  normalizeInteraction,
} from "./interaction";
import {
  NormalizedOrder,
  ORDER_UID_LENGTH,
  Order,
  OrderFlags,
  OrderKind,
  extractOrderUidParams,
  normalizeOrder,
  packOrderUidParams,
} from "./order";
import {
  EcdsaSigningScheme,
  Signature,
  SigningScheme,
  encodeEip1271SignatureData,
  signOrder,
} from "./sign";
import { TypedDataDomain } from "./types/ethers";

/**
 * The stage an interaction should be executed in.
 */
export enum InteractionStage {
  /**
   * A pre-settlement intraction.
   *
   * The interaction will be executed before any trading occurs. This can be
   * used, for example, to perform as EIP-2612 `permit` call for a user trading
   * in the current settlement.
   */
  PRE = 0,
  /**
   * An intra-settlement interaction.
   *
   * The interaction will be executed after all trade sell amounts are
   * transferred into the settlement contract, but before the buy amounts are
   * transferred out to the traders. This can be used, for example, to interact
   * with on-chain AMMs.
   */
  INTRA = 1,
  /**
   * A post-settlement interaction.
   *
   * The interaction will be executed after all trading has completed.
   */
  POST = 2,
}

/**
 * Gnosis Protocol v2 trade flags.
 */
export interface TradeFlags extends OrderFlags {
  /**
   * The signing scheme used to encode the signature.
   */
  signingScheme: SigningScheme;
}

/**
 * Trade parameters used in a settlement.
 */
export type Trade = TradeExecution &
  Omit<
    NormalizedOrder,
    "sellToken" | "buyToken" | "kind" | "partiallyFillable"
  > & {
    /**
     * The index of the sell token in the settlement.
     */
    sellTokenIndex: number;
    /**
     * The index of the buy token in the settlement.
     */
    buyTokenIndex: number;
    /**
     * Encoded order flags.
     */
    flags: number;
    /**
     * Signature data.
     */
    signature: BytesLike;
  };

/**
 * Details representing how an order was executed.
 */
export interface TradeExecution {
  /**
   * The executed trade amount.
   *
   * How this amount is used by the settlement contract depends on the order
   * flags:
   * - Partially fillable sell orders: the amount of sell tokens to trade.
   * - Partially fillable buy orders: the amount of buy tokens to trade.
   * - Fill-or-kill orders: this value is ignored.
   */
  executedAmount: BigNumberish;
  /**
   * Optional fee discount to use.
   *
   * If this value is `0`, then there is no discount and the full fee will be
   * taken for the order.
   */
  feeDiscount: BigNumberish;
}

/**
 * Table mapping token addresses to their respective clearing prices.
 */
export type Prices = Record<string, BigNumberish | undefined>;

/**
 * Encoded settlement parameters.
 */
export type EncodedSettlement = [
  /** Tokens. */
  string[],
  /** Clearing prices. */
  BigNumberish[],
  /** Encoded trades. */
  Trade[],
  /** Encoded interactions. */
  [Interaction[], Interaction[], Interaction[]],
  /** Encoded order refunds. */
  BytesLike[],
];

/**
 * Maximum number of trades that can be included in a single call to the settle
 * function.
 */
export const MAX_TRADES_IN_SETTLEMENT = 2 ** 16 - 1;

/**
 * Encodes signing scheme as a bitfield.
 *
 * @param scheme The signing scheme to encode.
 * @return The bitfield result.
 */
export function encodeSigningScheme(scheme: SigningScheme): number {
  switch (scheme) {
    case SigningScheme.EIP712:
      return 0b0000;
    case SigningScheme.ETHSIGN:
      return 0b0100;
    case SigningScheme.EIP1271:
      return 0b1000;
    case SigningScheme.PRESIGN:
      return 0b1100;
    default:
      throw new Error("Unsupported signing scheme");
  }
}

/**
 * Encodes order flags as a bitfield.
 *
 * @param flags The order flags to encode.
 * @return The bitfield result.
 */
export function encodeOrderFlags(flags: OrderFlags): number {
  let kind;
  switch (flags.kind) {
    case OrderKind.SELL:
      kind = 0;
      break;
    case OrderKind.BUY:
      kind = 1;
      break;
    default:
      throw new Error(`invalid error kind '${kind}'`);
  }
  const partiallyFillable = flags.partiallyFillable ? 0x02 : 0x00;

  return kind | partiallyFillable;
}

/**
 * Encodes trade flags as a bitfield.
 *
 * @param flags The trade flags to encode.
 * @return The bitfield result.
 */
export function encodeTradeFlags(flags: TradeFlags): number {
  return encodeOrderFlags(flags) | encodeSigningScheme(flags.signingScheme);
}

function encodeSignatureData(sig: Signature): string {
  switch (sig.scheme) {
    case SigningScheme.EIP712:
    case SigningScheme.ETHSIGN:
      return ethers.utils.joinSignature(sig.data);
    case SigningScheme.EIP1271:
      return encodeEip1271SignatureData(sig.data);
    case SigningScheme.PRESIGN:
      return packOrderUidParams(
        extractOrderUidParams(ethers.utils.hexlify(sig.data)),
      );
    default:
      throw new Error("unsupported signing scheme");
  }
}

/**
 * A class for building calldata for a settlement.
 *
 * The encoder ensures that token addresses are kept track of and performs
 * necessary computation in order to map each token addresses to IDs to
 * properly encode order parameters for trades.
 */
export class SettlementEncoder {
  private readonly _tokens: string[] = [];
  private readonly _tokenMap: Record<string, number | undefined> = {};
  private _trades: Trade[] = [];
  private _interactions: Record<InteractionStage, Interaction[]> = {
    [InteractionStage.PRE]: [],
    [InteractionStage.INTRA]: [],
    [InteractionStage.POST]: [],
  };
  private _orderRefunds: string[] = [];

  /**
   * Creates a new settlement encoder instance.
   * @param domain Domain used for signing orders. See {@link signOrder} for
   * more details.
   */
  public constructor(public readonly domain: TypedDataDomain) {}

  /**
   * Gets the array of token addresses used by the currently encoded orders.
   *
   * This is used as encoded orders reference tokens by index instead of
   * directly by address for multiple reasons:
   * - Reduce encoding size of orders to save on `calldata` gas.
   * - Direct access to a token's clearing price on settlement instead of
   *   requiring a search.
   */
  public get tokens(): string[] {
    // NOTE: Make sure to slice the original array, so it cannot be modified
    // outside of this class.
    return this._tokens.slice();
  }

  /**
   * Gets the encoded trades as a hex-encoded string.
   */
  public get trades(): Trade[] {
    return this._trades.slice();
  }

  /**
   * Gets the encoded interactions for the specified stage as a hex-encoded
   * string.
   */
  public get interactions(): [Interaction[], Interaction[], Interaction[]] {
    return [
      this._interactions[InteractionStage.PRE].slice(),
      this._interactions[InteractionStage.INTRA].slice(),
      this._interactions[InteractionStage.POST].slice(),
    ];
  }

  /**
   * Gets the currently encoded order UIDs for gas refunds.
   */
  public get orderRefunds(): string[] {
    return this._orderRefunds.slice();
  }

  /**
   * Returns a clearing price vector for the current settlement tokens from the
   * provided price map.
   *
   * @param prices The price map from token address to price.
   * @return The price vector.
   */
  public clearingPrices(prices: Prices): BigNumberish[] {
    return this.tokens.map((token) => {
      const price = prices[token];
      if (price === undefined) {
        throw new Error(`missing price for token ${token}`);
      }
      return price;
    });
  }

  /**
   * Encodes a trade from a signed order and executed amount, appending it to
   * the `calldata` bytes that are being built.
   *
   * Additionally, if the order references new tokens that the encoder has not
   * yet seen, they are added to the tokens array.
   *
   * @param order The order of the trade to encode.
   * @param signature The signature for the order data.
   * @param tradeExecution The execution details for the trade.
   */
  public encodeTrade(
    order: Order,
    signature: Signature,
    tradeExecution?: Partial<TradeExecution>,
  ): void {
    const { executedAmount, feeDiscount } = tradeExecution || {};
    if (order.partiallyFillable && executedAmount === undefined) {
      throw new Error("missing executed amount for partially fillable trade");
    }

    if (order.receiver === ethers.constants.AddressZero) {
      throw new Error("receiver cannot be address(0)");
    }

    const tradeFlags = {
      ...order,
      signingScheme: signature.scheme,
    };
    const o = normalizeOrder(order);

    this._trades.push({
      sellTokenIndex: this.tokenIndex(o.sellToken),
      buyTokenIndex: this.tokenIndex(o.buyToken),
      receiver: o.receiver,
      sellAmount: o.sellAmount,
      buyAmount: o.buyAmount,
      validTo: o.validTo,
      appData: o.appData,
      feeAmount: o.feeAmount,
      flags: encodeTradeFlags(tradeFlags),
      executedAmount: executedAmount || 0,
      feeDiscount: feeDiscount || 0,
      signature: encodeSignatureData(signature),
    });
  }

  /**
   * Signs an order and encodes a trade with that order.
   *
   * @param order The order to sign for the trade.
   * @param owner The externally owned account that should sign the order.
   * @param scheme The signing scheme to use. See {@link SigningScheme} for more
   * details.
   * @param tradeExecution The execution details for the trade.
   */
  public async signEncodeTrade(
    order: Order,
    owner: Signer,
    scheme: EcdsaSigningScheme,
    tradeExecution?: Partial<TradeExecution>,
  ): Promise<void> {
    const signature = await signOrder(this.domain, order, owner, scheme);
    this.encodeTrade(order, signature, tradeExecution);
  }

  /**
   * Encodes the input interaction in the packed format accepted by the smart
   * contract and adds it to the interactions encoded so far.
   *
   * @param stage The stage the interaction should be executed.
   * @param interaction The interaction to encode.
   */
  public encodeInteraction(
    interaction: InteractionLike,
    stage: InteractionStage = InteractionStage.INTRA,
  ): void {
    this._interactions[stage].push(normalizeInteraction(interaction));
  }

  /**
   * Encodes order UIDs for gas refunds.
   *
   * @param orderUids The order UIDs for which to claim gas refunds.
   */
  public encodeOrderRefunds(...orderUids: string[]): void {
    if (
      !orderUids.every((orderUid) =>
        ethers.utils.isHexString(orderUid, ORDER_UID_LENGTH),
      )
    ) {
      throw new Error("one or more invalid order UIDs");
    }

    this._orderRefunds.push(...orderUids);
  }

  /**
   * Returns the encoded settlement parameters.
   */
  public encodedSettlement(prices: Prices): EncodedSettlement {
    return [
      this.tokens,
      this.clearingPrices(prices),
      this.trades,
      this.interactions,
      this.orderRefunds,
    ];
  }

  private tokenIndex(token: string): number {
    // NOTE: Verify and normalize the address into a case-checksummed address.
    // Not only does this ensure validity of the addresses early on, it also
    // makes it so `0xff...f` and `0xFF..F` map to the same ID.
    const tokenAddress = ethers.utils.getAddress(token);

    let tokenIndex = this._tokenMap[tokenAddress];
    if (tokenIndex === undefined) {
      tokenIndex = this._tokens.length;
      this._tokens.push(tokenAddress);
      this._tokenMap[tokenAddress] = tokenIndex;
    }

    return tokenIndex;
  }
}
