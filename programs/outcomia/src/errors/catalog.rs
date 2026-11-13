//! Canonical Anchor error catalog.
//!
//! Anchor 1.2 permits only one `#[error_code]` definition per program IDL.
//! Domain modules re-export subsets of these variants for focused call sites,
//! while this catalog preserves the single public ABI.

use anchor_lang::prelude::*;

/// Stable program errors returned when an authorization, lifecycle, or order
/// invariant is violated.
#[error_code]
pub enum OutcomiaError {
    #[msg("Market is paused")]
    MarketPaused = 0,

    #[msg("Invalid market status")]
    InvalidMarketStatus = 1,

    #[msg("Market already initialized")]
    MarketAlreadyInitialized = 2,

    #[msg("Market not found")]
    MarketNotFound = 3,

    #[msg("Market is already paused")]
    MarketAlreadyPaused = 4,

    #[msg("Market is already active")]
    MarketAlreadyActive = 5,

    #[msg("Only the market authority can perform this action")]
    Unauthorized = 6,

    #[msg("Market must be paused before it can be closed")]
    MarketMustBePaused = 7,

    #[msg("Market is not active")]
    MarketNotActive = 8,

    #[msg("Invalid order ID")]
    InvalidOrderId = 9,

    #[msg("Price must be greater than zero")]
    InvalidPrice = 10,

    #[msg("Quantity must be greater than zero")]
    InvalidQuantity = 11,

    #[msg("Base and quote mints must be different")]
    IdenticalMints = 12,

    #[msg("Signer is not a protocol administrator")]
    UnauthorizedAdmin = 13,

    #[msg("Signer is not the program upgrade authority")]
    InvalidDeployer = 14,

    #[msg("Only the protocol super admin can perform this action")]
    UnauthorizedSuperAdmin = 15,

    #[msg("Invalid administrator address")]
    InvalidAdmin = 16,

    #[msg("Administrator is already disabled")]
    AdminAlreadyDisabled = 17,

    #[msg("Administrator is already active")]
    AdminAlreadyActive = 18,

    #[msg("The super administrator cannot be disabled or removed")]
    CannotModifySuperAdmin = 19,

    #[msg("Administrator must be disabled before removal")]
    AdminMustBeDisabled = 20,

    #[msg("Administrator is disabled")]
    AdminDisabled = 21,

    #[msg("Only the order owner can cancel this order")]
    UnauthorizedOrderOwner = 22,

    #[msg("Order does not belong to the supplied market")]
    OrderMarketMismatch = 23,

    #[msg("Only an open order can be canceled")]
    OrderNotOpen = 24,

    #[msg("Price tick size must be greater than zero")]
    InvalidPriceTickSize = 25,

    #[msg("Quantity lot size must be greater than zero")]
    InvalidQuantityLotSize = 26,

    #[msg("Price must be a multiple of the market tick size")]
    PriceNotOnTick = 27,

    #[msg("Quantity must be a multiple of the market lot size")]
    QuantityNotOnLot = 28,

    #[msg("Order notional arithmetic overflow")]
    OrderNotionalOverflow = 29,

    #[msg("Order notional is below one quote-mint unit")]
    OrderNotionalTooSmall = 30,

    #[msg("Collateral mint does not match the order side")]
    InvalidCollateralMint = 31,

    #[msg("Trader does not own the collateral token account")]
    InvalidCollateralOwner = 32,

    #[msg("Insufficient collateral balance")]
    InsufficientCollateral = 33,

    #[msg("Open-order counter overflow")]
    OpenOrderCountOverflow = 34,

    #[msg("Open-order counter underflow")]
    OpenOrderCountUnderflow = 35,

    #[msg("Market still contains open orders")]
    MarketHasOpenOrders = 36,

    #[msg("Market vaults must be empty before closing")]
    MarketVaultNotEmpty = 37,

    #[msg("Invalid market vault authority")]
    InvalidVaultAuthority = 38,

    #[msg("Price level belongs to a different market")]
    PriceLevelMarketMismatch = 39,

    #[msg("Price-level side does not match the order side")]
    PriceLevelSideMismatch = 40,

    #[msg("Price-level price does not match the order price")]
    PriceLevelPriceMismatch = 41,

    #[msg("Supplied order is not the current price-level tail")]
    InvalidPriceLevelTail = 42,

    #[msg("Order does not belong to the supplied price level")]
    OrderPriceLevelMismatch = 43,

    #[msg("Price-level order count overflow")]
    PriceLevelOrderCountOverflow = 44,

    #[msg("Price-level quantity overflow")]
    PriceLevelQuantityOverflow = 45,

    #[msg("Order ID counter overflow")]
    OrderIdOverflow = 46,

    #[msg("Invalid combination of better and worse price-level neighbors")]
    InvalidPriceLevelNeighbors = 47,

    #[msg("Supplied level is not the market's current best level")]
    BestPriceLevelMismatch = 48,

    #[msg("New price does not have better priority than the current best price")]
    InvalidPriceLevelOrdering = 49,

    #[msg("Supplied price-level account is not canonical")]
    NoncanonicalPriceLevel = 50,

    #[msg("Supplied FIFO order neighbor does not match the order link")]
    InvalidOrderNeighbor = 51,

    #[msg("Supplied FIFO neighbor does not link back to the canceled order")]
    BrokenOrderQueueLink = 52,

    #[msg("Price-level order count underflow")]
    PriceLevelOrderCountUnderflow = 53,

    #[msg("Price-level remaining quantity underflow")]
    PriceLevelQuantityUnderflow = 54,

    #[msg("Supplied order account is not canonical")]
    NoncanonicalOrder = 55,

    #[msg("Price-level rent recipient does not match the stored rent payer")]
    InvalidPriceLevelRentRecipient = 56,

    #[msg("Final order does not match the price-level queue endpoints")]
    InvalidPriceLevelEndpoints = 57,

    #[msg("Empty price level has a nonzero remaining quantity")]
    InvalidPriceLevelAggregate = 58,

    #[msg("Deposit amount must be greater than zero")]
    InvalidDepositAmount = 59,

    #[msg("Deposit mint is neither the market base nor quote mint")]
    InvalidDepositMint = 60,

    #[msg("Trader balance belongs to a different market")]
    TraderBalanceMarketMismatch = 61,

    #[msg("Trader balance belongs to a different owner")]
    TraderBalanceOwnerMismatch = 62,

    #[msg("Free balance overflow")]
    FreeBalanceOverflow = 63,

    #[msg("Locked balance overflow")]
    LockedBalanceOverflow = 64,

    #[msg("Locked balance underflow")]
    LockedBalanceUnderflow = 65,

    #[msg("Insufficient token balance for deposit")]
    InsufficientDepositFunds = 66,

    #[msg("Withdrawal amount must be greater than zero")]
    InvalidWithdrawalAmount = 67,

    #[msg("Withdrawal mint is neither the market base nor quote mint")]
    InvalidWithdrawalMint = 68,

    #[msg("Insufficient free balance")]
    InsufficientFreeBalance = 69,

    #[msg("Withdrawal destination is not owned by the trader")]
    InvalidWithdrawalDestinationOwner = 70,

    #[msg("Market vault contains insufficient tokens")]
    InsufficientVaultFunds = 71,

    #[msg("Maker and taker orders must be on opposite sides")]
    MatchingSameSide = 72,

    #[msg("Taker limit price does not cross the maker price")]
    OrdersDoNotCross = 73,

    #[msg("Maker order has insufficient locked collateral")]
    InvalidMakerCollateral = 74,

    #[msg("A trader cannot match against their own order")]
    SelfTradeNotAllowed = 75,

    #[msg("Matching must use the best opposing price level")]
    MakerNotAtBestPrice = 76,

    #[msg("Matching must consume the FIFO head order")]
    MakerNotFifoHead = 77,

    #[msg("Taker fee rate exceeds the protocol maximum")]
    FeeRateTooHigh = 78,

    #[msg("Fee calculation overflow")]
    FeeCalculationOverflow = 79,

    #[msg("Market fee account belongs to a different market")]
    MarketFeesMarketMismatch = 80,

    #[msg("Market fee account uses a different quote mint")]
    MarketFeesQuoteMintMismatch = 81,

    #[msg("Accrued protocol fees must be withdrawn before closing the market")]
    MarketFeesNotEmpty = 82,

    #[msg("Market fee accumulator overflow")]
    FeeAccrualOverflow = 83,

    #[msg("Protocol fee withdrawal amount must be greater than zero")]
    InvalidFeeWithdrawalAmount = 84,

    #[msg("Protocol fee withdrawal exceeds accrued fees")]
    InsufficientAccruedFees = 85,

    #[msg("Protocol fee destination must use the market quote mint")]
    InvalidFeeDestinationMint = 86,

    #[msg("Faucet claim amounts must be greater than zero")]
    InvalidFaucetClaimAmount = 87,

    #[msg("Only valueless mints with zero supply may initialize a test faucet")]
    FaucetMintSupplyNotZero = 88,

    #[msg("The super administrator must control both test mint authorities")]
    InvalidFaucetMintAuthority = 89,

    #[msg("Faucet configuration does not belong to the supplied market")]
    FaucetMarketMismatch = 90,

    #[msg("Faucet mint does not match the configured market asset")]
    FaucetMintMismatch = 91,

    #[msg("Faucet destination token account is not owned by the claimant")]
    InvalidFaucetDestinationOwner = 92,

    #[msg("The market test faucet must be closed before closing the market")]
    FaucetMustBeClosed = 93,

    #[msg("Market symbols must be 1-16 ASCII letters, digits, '.', '-' or '_'")]
    InvalidMarketSymbol = 94,

    #[msg("Market display name must be 1-64 printable ASCII characters without outer whitespace")]
    InvalidMarketDisplayName = 95,

    #[msg("Prediction market metadata is unavailable until prediction settlement is implemented")]
    PredictionMarketUnavailable = 96,

    #[msg("Market metadata belongs to a different market")]
    MarketMetadataMismatch = 97,

    #[msg("Prediction trading close time must be in the future")]
    InvalidPredictionCloseTime = 98,

    #[msg("Prediction resolution cannot begin before trading closes")]
    InvalidPredictionResolutionTime = 99,

    #[msg("Prediction fallback activation and deadline must follow the resolution window")]
    InvalidPredictionFallback = 100,

    #[msg("Prediction resolver keys must be nonzero and primary and fallback must differ")]
    InvalidPredictionResolver = 101,

    #[msg("Prediction resolution delay must be positive and fit signed timestamp arithmetic")]
    InvalidPredictionResolutionDelay = 102,

    #[msg("Prediction payout must be positive and even for exact Invalid settlement")]
    InvalidPredictionPayout = 103,

    #[msg("Prediction price tick must be positive, below payout and divide it exactly")]
    InvalidPredictionPriceTick = 104,

    #[msg("Prediction rules URI must be bounded printable ASCII using ar:// or https://")]
    InvalidPredictionRulesUri = 105,

    #[msg("Prediction question and rules hashes must be nonzero")]
    InvalidPredictionRulesHash = 106,

    #[msg("Prediction timestamp plus resolution delay exceeds the timestamp range")]
    PredictionTimestampOverflow = 107,

    #[msg("Prediction position belongs to a different market")]
    PredictionPositionMarketMismatch = 108,

    #[msg("Prediction position belongs to a different wallet")]
    PredictionPositionOwnerMismatch = 109,

    #[msg("Token mint does not match the prediction market collateral")]
    InvalidPredictionCollateralMint = 110,

    #[msg("Token vault does not match the prediction market custody account")]
    InvalidPredictionVault = 111,

    #[msg("A resolved prediction market cannot accept new collateral deposits")]
    PredictionDepositAfterResolution = 112,

    #[msg("Prediction collateral source is not owned by the signing wallet")]
    InvalidPredictionTokenOwner = 113,

    #[msg("Contract quantity must be a positive whole number")]
    InvalidPredictionContractQuantity = 114,

    #[msg("Complete sets may only be split while the market is open and before close")]
    PredictionSplitUnavailable = 115,

    #[msg("Complete sets may only be merged in Open, Frozen or Proposed markets")]
    PredictionMergeUnavailable = 116,

    #[msg("Not enough free YES and NO positions to merge")]
    InsufficientPredictionPositions = 117,

    #[msg("Prediction quantity, payout or reserve exceeds u64")]
    PredictionAccountingOverflow = 118,

    #[msg("Prediction supply or backing reserve cannot cover the complete set")]
    PredictionBackingUnderflow = 119,

    #[msg("Only the prediction market authority may open this market")]
    UnauthorizedPredictionAuthority = 120,

    #[msg("Only a draft prediction market can be opened")]
    PredictionNotDraft = 121,

    #[msg("A prediction market cannot be opened at or after its close time")]
    PredictionOpeningClosed = 122,

    #[msg("The market creator must be its primary outcome resolver")]
    PredictionCreatorMustResolve = 123,

    #[msg("Prediction book belongs to a different market")]
    PredictionBookMarketMismatch = 124,
    #[msg("Prediction orders require an open market before its close time")]
    PredictionOrderUnavailable = 125,
    #[msg("This placement path requires an empty outcome/side price list")]
    PredictionSideNotEmpty = 126,
    #[msg("Prediction price must be positive, below payout and tick-aligned")]
    InvalidPredictionOrderPrice = 127,
    #[msg("A crossing prediction order must use the matching path")]
    PredictionOrderWouldCross = 128,
    #[msg("Prediction order ID must match the book's next positive ID")]
    InvalidPredictionOrderId = 129,
    #[msg("Prediction level identity or book linkage is invalid")]
    InvalidPredictionPriceLevel = 130,
    #[msg("Prediction queue tail identity, status or links are invalid")]
    InvalidPredictionTail = 131,
    #[msg("Prediction order must be open")]
    PredictionOrderNotOpen = 132,
    #[msg("Only the prediction order owner may cancel it")]
    UnauthorizedPredictionOrderOwner = 133,
    #[msg("Prediction FIFO neighbors are missing, stale or invalid")]
    InvalidPredictionOrderNeighbor = 134,
    #[msg("Empty prediction level rent must return to its original payer")]
    InvalidPredictionRentRecipient = 135,
    #[msg("Prediction order backing or book counters are inconsistent")]
    PredictionOrderAccountingMismatch = 136,
    #[msg("Prediction maker and taker must be on opposite sides")]
    PredictionMatchingSameSide = 137,
    #[msg("Prediction limit price does not cross the resting maker")]
    PredictionOrdersDoNotCross = 138,
    #[msg("Prediction traders cannot match their own resting orders")]
    PredictionSelfTrade = 139,
    #[msg("Prediction matching must use the best opposing price")]
    PredictionMakerNotBest = 140,
    #[msg("Prediction matching must use the oldest open order at that price")]
    PredictionMakerNotHead = 141,

    #[msg("Shared balance owner, mint or address is invalid")]
    InvalidAssetBalance = 142,
    #[msg("Shared book kind or underlying market is invalid")]
    SharedMarketKindMismatch = 143,
    #[msg("Shared order book or queue accounts are inconsistent")]
    InvalidSharedBook = 144,
    #[msg("A shared price/FIFO neighbor is missing, stale or invalid")]
    InvalidSharedNeighbor = 145,
    #[msg("Only the shared order owner may cancel it")]
    UnauthorizedSharedOrderOwner = 146,
    #[msg("Shared book still has open orders or unwithdrawn fees")]
    SharedBookNotEmpty = 147,
    #[msg("Close the shared book before closing its underlying market")]
    SharedBookMustBeClosed = 148,
    #[msg("Prediction outcome is not ready for proposal or finalization")]
    PredictionResolutionUnavailable = 149,
    #[msg("Only the active configured resolver may propose or correct")]
    UnauthorizedPredictionResolver = 150,
    #[msg("Prediction evidence URI and hash must be nonempty and bounded")]
    InvalidPredictionEvidence = 151,
    #[msg("A proposal already exists or the correction window has ended")]
    PredictionProposalUnavailable = 152,
    #[msg("Fallback activation or timeout conditions are not met")]
    PredictionFallbackUnavailable = 153,
    #[msg("Prediction market has not reached a final outcome")]
    PredictionNotResolved = 154,
    #[msg("There are no selected free contracts to redeem")]
    NothingToRedeem = 155,

    #[msg("Multi-outcome markets require two to eight outcomes")]
    InvalidMultiOutcomeCount = 156,
    #[msg("Outcome ID is outside this market's immutable outcome list")]
    InvalidMultiOutcomeId = 157,
    #[msg("Outcome labels must be distinct, trimmed, nonempty and bounded UTF-8")]
    InvalidMultiOutcomeLabel = 158,
    #[msg("Multi-outcome face payout must be positive")]
    InvalidMultiOutcomePayout = 159,
    #[msg("Multi-outcome price must be positive, below payout and tick aligned")]
    InvalidMultiOutcomePrice = 160,
    #[msg("Multi-outcome lot or quantity cannot support exact settlement")]
    InvalidMultiOutcomeLot = 161,
    #[msg("Multi-outcome accounting exceeds the supported collateral amount")]
    MultiOutcomeAccountingOverflow = 162,
    #[msg("Multi-outcome supplies are inconsistent with the lifecycle")]
    MultiOutcomeSupplyMismatch = 163,
    #[msg("Unused outcome slots must remain zero")]
    MultiOutcomeInactiveSlot = 164,
    #[msg("Multi-outcome position owner, market or quantities are inconsistent")]
    InvalidMultiOutcomePosition = 165,
    #[msg("Multi-outcome reserve accounting or physical backing is inconsistent")]
    MultiOutcomeReserveMismatch = 166,
}
