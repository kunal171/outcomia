//! Club membership errors; append-only codes live in catalog.
pub use super::OutcomiaError::{
    AlreadyClubMember, ClubAdminLimitReached, ClubClosed, ClubCounterMismatch,
    ClubDepositAssetMismatch, ClubDepositBelowMinimum, ClubDepositOverflow, ClubDepositRulesNotSet,
    ClubDepositTooLow, ClubFeeShareTooHigh, ClubFeesNotWithdrawn, ClubHasLiveMarkets,
    ClubInviteExpired, ClubInviteNotExpired, ClubJoinRequestExpired, ClubJoinRequestNotExpired,
    ClubKindUnchanged, ClubMarketCountAlreadySet, ClubMarketCountNotSet, ClubMarketNotFinished,
    ClubMemberCapReached, ClubMembershipRequired, ClubMigrationNotNeeded, ClubNotOpen,
    ClubNotPublic, ClubOwnerLimitReached, ClubOwnerProtected, ClubPriceUpdateRequired,
    ClubRefundAccountsMissing, ClubTooLargeForPrivate, InvalidClubDepositRules, InvalidClubListing,
    InvalidClubMarket, InvalidClubMember, InvalidClubName, InvalidClubRules, InvalidPriceUpdate,
    PriceConfidenceTooWide, PrivateClubCannotList, UnauthorizedClubAdmin, UnauthorizedClubOwner,
};
