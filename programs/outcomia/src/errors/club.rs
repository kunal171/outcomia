//! Club membership errors; append-only codes live in catalog.
pub use super::OutcomiaError::{
    AlreadyClubMember, ClubCounterMismatch, ClubFeeShareTooHigh, ClubInviteExpired,
    ClubInviteNotExpired, ClubJoinRequestExpired, ClubJoinRequestNotExpired,
    ClubMembershipRequired, ClubNotOpen, ClubNotPublic, ClubOwnerProtected, InvalidClubListing,
    InvalidClubMarket, InvalidClubMember, InvalidClubName, UnauthorizedClubAdmin,
    UnauthorizedClubOwner,
};
