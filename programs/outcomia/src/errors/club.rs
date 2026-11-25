//! Club membership errors; append-only codes live in catalog.
pub use super::OutcomiaError::{
    AlreadyClubMember, ClubAdminLimitReached, ClubCounterMismatch, ClubFeeShareTooHigh,
    ClubInviteExpired, ClubInviteNotExpired, ClubJoinRequestExpired, ClubJoinRequestNotExpired,
    ClubMemberCapReached, ClubMembershipRequired, ClubMigrationNotNeeded, ClubNotOpen,
    ClubNotPublic, ClubOwnerLimitReached, ClubOwnerProtected, InvalidClubListing,
    InvalidClubMarket, InvalidClubMember, InvalidClubName, InvalidClubRules, PrivateClubCannotList,
    UnauthorizedClubAdmin, UnauthorizedClubOwner,
};
