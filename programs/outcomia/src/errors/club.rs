//! Club membership errors; append-only codes live in catalog.
pub use super::OutcomiaError::{
    AlreadyClubMember, ClubAdminLimitReached, ClubCounterMismatch, ClubDepositAssetMismatch,
    ClubDepositBelowMinimum, ClubDepositOverflow, ClubDepositRulesNotSet, ClubDepositTooLow,
    ClubFeeShareTooHigh, ClubInviteExpired, ClubInviteNotExpired, ClubJoinRequestExpired,
    ClubJoinRequestNotExpired, ClubMarketCountAlreadySet, ClubMarketCountNotSet,
    ClubMemberCapReached, ClubMembershipRequired, ClubMigrationNotNeeded, ClubNotOpen,
    ClubNotPublic, ClubOwnerLimitReached, ClubOwnerProtected, ClubPriceUpdateRequired,
    InvalidClubDepositRules, InvalidClubListing, InvalidClubMarket, InvalidClubMember,
    InvalidClubName, InvalidClubRules, InvalidPriceUpdate, PriceConfidenceTooWide,
    PrivateClubCannotList, UnauthorizedClubAdmin, UnauthorizedClubOwner,
};
